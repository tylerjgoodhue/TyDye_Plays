import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_BODY_BYTES = 60_000; // JSON API bodies; uploads stream separately below
const DROPBOX_API = "https://api.dropboxapi.com/2";
const TOKEN_URL = "https://api.dropbox.com/oauth2/token";

function json(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {})
    }
  });
}

function allowedOrigins() {
  return (Deno.env.get("ALLOWED_APP_ORIGINS") || "http://127.0.0.1:8765,http://localhost:8765")
    .split(",").map(value => value.trim()).filter(Boolean);
}

function defaultKey(environmentName: string, legacyName: string) {
  const legacy = Deno.env.get(legacyName) || "";
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get(environmentName) || "{}");
    return typeof keys.default === "string" ? keys.default : "";
  } catch {
    return "";
  }
}

function dropboxAppConfig() {
  const appKey = Deno.env.get("DROPBOX_APP_KEY") || "";
  const appSecret = Deno.env.get("DROPBOX_APP_SECRET") || "";
  return { appKey, appSecret };
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = defaultKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Dropbox storage is not configured. The function runtime did not provide its secret key.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authenticatedUser(request: Request) {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || defaultKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!url || !key || !token) throw new Error("Sign in to Creator HQ to use Dropbox.");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("Your Creator HQ session expired. Sign in again.");
  return data.user;
}

function functionBaseUrl(request: Request) {
  // An explicit secret overrides the derived URL when needed.
  const configured = (Deno.env.get("DROPBOX_REDIRECT_URI") || "").trim();
  if (configured) return configured;
  const url = new URL(request.url);
  // The edge runtime may report an internal http:// origin; Dropbox requires https.
  const origin = url.origin.replace(/^http:\/\//i, "https://");
  return `${origin}/functions/v1/dropbox`;
}

async function exchangeToken(params: Record<string, string>) {
  const { appKey, appSecret } = dropboxAppConfig();
  if (!appKey || !appSecret) throw new Error("Dropbox is not configured. Set the DROPBOX_APP_KEY and DROPBOX_APP_SECRET secrets.");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: appKey, client_secret: appSecret })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.refresh_token) {
    throw new Error(data.error_description || data.error || "Dropbox authorization failed.");
  }
  return data as { access_token: string; refresh_token: string; expires_in: number; account_id: string };
}

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getAccessToken(userId: string, refreshToken: string) {
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  const token = await exchangeToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  tokenCache.set(userId, { accessToken: token.access_token, expiresAt: Date.now() + (token.expires_in || 14400) * 1000 });
  return token.access_token;
}

async function dropboxCall(path: string, accessToken: string, body: unknown, method = "POST") {
  const response = await fetch(`${DROPBOX_API}${path}`, {
    method,
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { ok: response.ok, status: response.status, data };
}

function entrySummary(entry: Record<string, unknown>) {
  const metadata = (entry as { metadata?: Record<string, unknown> }).metadata || entry;
  const tag = String(metadata[".tag"] || "");
  const sharing = metadata as { sharing_info?: { read_only?: boolean } };
  return {
    name: String(metadata.name || ""),
    path: String(metadata.path_lower || metadata.path_display || ""),
    isFolder: tag === "folder",
    size: typeof metadata.size === "number" ? metadata.size : 0,
    modified: String(metadata.server_modified || ""),
    readOnly: Boolean(sharing.sharing_info?.read_only)
  };
}

Deno.serve(async request => {
  const origin = request.headers.get("Origin") || "";
  const origins = allowedOrigins();
  const requestUrl = new URL(request.url);
  const action = requestUrl.searchParams.get("action") || "api";

  if (request.method === "OPTIONS") {
    if (!origins.includes(origin)) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
      }
    });
  }

  // OAuth callback: Dropbox redirects here with ?code&state. No CORS needed.
  if (action === "callback") {
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
    const code = requestUrl.searchParams.get("code") || "";
    const state = requestUrl.searchParams.get("state") || "";
    const errorParam = requestUrl.searchParams.get("error_description") || requestUrl.searchParams.get("error") || "";
    const appBase = origins[0] || `${requestUrl.origin}/`;
    if (errorParam || !code || !state) {
      return Response.redirect(`${appBase}#dropbox-error=${encodeURIComponent(errorParam || "Missing authorization code.")}`, 302);
    }
    try {
      const { appKey, appSecret } = dropboxAppConfig();
      if (!appKey || !appSecret) throw new Error("Dropbox is not configured on the server.");
      const token = await exchangeToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: functionBaseUrl(request)
      });
      const admin = serviceClient();
      const who = await dropboxCall("/users/get_current_account", token.access_token, null);
      const account = who.ok && who.data ? who.data as { name?: { display_name?: string }; email?: string } : {};
      const { error } = await admin.from("dropbox_connections").upsert({
        user_id: state,
        refresh_token: token.refresh_token,
        account_name: account.name?.display_name || "",
        account_email: account.email || "",
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id" });
      if (error) throw error;
      return Response.redirect(`${appBase}#dropbox-connected=1`, 302);
    } catch (error) {
      return Response.redirect(`${appBase}#dropbox-error=${encodeURIComponent((error as Error).message)}`, 302);
    }
  }

  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
  if (!origins.includes(origin)) return json({ error: "This app origin is not allowed. Add it to ALLOWED_APP_ORIGINS." }, 403, origin);

  try {
    const user = await authenticatedUser(request);
    const admin = serviceClient();

    if (action === "start") {
      const { appKey } = dropboxAppConfig();
      if (!appKey) throw new Error("Dropbox is not configured. Set the DROPBOX_APP_KEY secret.");
      const authorize = new URL("https://www.dropbox.com/oauth2/authorize");
      authorize.searchParams.set("client_id", appKey);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("token_access_type", "offline");
      authorize.searchParams.set("redirect_uri", functionBaseUrl(request));
      authorize.searchParams.set("state", user.id);
      return json({ authorizeUrl: authorize.toString() }, 200, origin);
    }

    if (action === "disconnect") {
      const { error } = await admin.from("dropbox_connections").delete().eq("user_id", user.id);
      if (error) throw error;
      tokenCache.delete(user.id);
      return json({ connected: false }, 200, origin);
    }

    // Everything below needs a connected account.
    const { data: connection, error: connectionError } = await admin.from("dropbox_connections")
      .select("refresh_token, account_name, account_email").eq("user_id", user.id).maybeSingle();
    if (connectionError) {
      const detail = `${connectionError.code || ""} ${connectionError.message || ""}`.toLowerCase();
      if (detail.includes("schema cache") || detail.includes("does not exist") || detail.includes("42p01") || detail.includes("pgrst205")) {
        return json({
          error: "The dropbox_connections table does not exist in the database yet. Open the Supabase SQL editor and run the SQL from supabase/migrations/20261030000000_dropbox_connections.sql, then reload Creator HQ.",
          needsMigration: true
        }, 400, origin);
      }
      throw connectionError;
    }
    if (action === "status") {
      return json({
        connected: Boolean(connection),
        accountName: connection?.account_name || "",
        accountEmail: connection?.account_email || "",
        configured: Boolean(dropboxAppConfig().appKey)
      }, 200, origin);
    }
    if (!connection) return json({ error: "Dropbox is not connected yet. Connect your account first." }, 400, origin);

    const accessToken = await getAccessToken(user.id, connection.refresh_token);

    // File upload streams through the content endpoint with raw bytes.
    if (action === "upload") {
      const dropboxArg = request.headers.get("Dropbox-API-Arg") || "";
      if (!dropboxArg) return json({ error: "Missing upload target." }, 400, origin);
      const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Dropbox-API-Arg": dropboxArg, "Content-Type": "application/octet-stream" },
        body: request.body
      });
      const text = await response.text();
      let data: unknown = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      if (!response.ok) return json({ error: (data as { error_summary?: string })?.error_summary || "Upload failed." }, 400, origin);
      return json(entrySummary(data as Record<string, unknown>), 200, origin);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large." }, 413, origin);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "Invalid JSON body." }, 400, origin); }

    if (action === "list") {
      const path = typeof body.path === "string" ? body.path : "";
      let result;
      if (typeof body.cursor === "string" && body.cursor) {
        result = await dropboxCall("/files/list_folder/continue", accessToken, { cursor: body.cursor });
      } else {
        result = await dropboxCall("/files/list_folder", accessToken, {
          path,
          recursive: false,
          include_deleted: false,
          limit: 500
        });
      }
      if (!result.ok) {
        const summary = (result.data as { error_summary?: string })?.error_summary || "";
        return json({ error: summary || `Dropbox list failed (${result.status}).` }, 400, origin);
      }
      const payload = result.data as { entries?: Record<string, unknown>[]; cursor?: string; has_more?: boolean };
      const entries = (payload.entries || []).map(entrySummary).sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      return json({ entries, cursor: payload.cursor || "", hasMore: Boolean(payload.has_more) }, 200, origin);
    }

    if (action === "move") {
      const fromPath = typeof body.fromPath === "string" ? body.fromPath : "";
      const toPath = typeof body.toPath === "string" ? body.toPath : "";
      if (!fromPath || !toPath) return json({ error: "Both the file and destination paths are required." }, 400, origin);
      const result = await dropboxCall("/files/move_v2", accessToken, { from_path: fromPath, to_path: toPath, autorename: true });
      if (!result.ok) return json({ error: (result.data as { error_summary?: string })?.error_summary || "Move failed." }, 400, origin);
      return json({ moved: entrySummary((result.data as { metadata?: Record<string, unknown> }).metadata || {}) }, 200, origin);
    }

    if (action === "create-folder") {
      const path = typeof body.path === "string" ? body.path : "";
      if (!path) return json({ error: "A folder path is required." }, 400, origin);
      const result = await dropboxCall("/files/create_folder_v2", accessToken, { path });
      if (!result.ok) return json({ error: (result.data as { error_summary?: string })?.error_summary || "Could not create the folder." }, 400, origin);
      return json({ folder: entrySummary((result.data as { metadata?: Record<string, unknown> }).metadata || {}) }, 200, origin);
    }

    if (action === "delete") {
      const path = typeof body.path === "string" ? body.path : "";
      if (!path) return json({ error: "A path is required." }, 400, origin);
      const result = await dropboxCall("/files/delete_v2", accessToken, { path });
      if (!result.ok) return json({ error: (result.data as { error_summary?: string })?.error_summary || "Delete failed." }, 400, origin);
      return json({ deleted: true }, 200, origin);
    }

    if (action === "download-link") {
      const path = typeof body.path === "string" ? body.path : "";
      if (!path) return json({ error: "A path is required." }, 400, origin);
      const result = await dropboxCall("/files/get_temporary_link", accessToken, { path });
      if (!result.ok) return json({ error: (result.data as { error_summary?: string })?.error_summary || "Could not open the file." }, 400, origin);
      const link = (result.data as { link?: string }).link || "";
      return json({ link }, 200, origin);
    }

    if (action === "batch-move") {
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const toFolder = typeof body.toFolder === "string" ? body.toFolder : "";
      if (!entries.length || !toFolder) return json({ error: "Select files and a destination folder." }, 400, origin);
      const results: unknown[] = [];
      for (const entry of entries.slice(0, 50)) {
        const source = String((entry as { path?: string }).path || "");
        if (!source) continue;
        const name = source.split("/").pop() || "";
        const destination = `${toFolder === "/" ? "" : toFolder}/${name}`;
        const result = await dropboxCall("/files/move_v2", accessToken, { from_path: source, to_path: destination, autorename: true });
        results.push(result.ok ? { path: source, ok: true } : { path: source, ok: false, error: (result.data as { error_summary?: string })?.error_summary || "" });
      }
      return json({ results }, 200, origin);
    }

    return json({ error: "Unknown action." }, 400, origin);
  } catch (error) {
    return json({ error: (error as Error)?.message || "Dropbox request failed." }, 400, origin);
  }
});
