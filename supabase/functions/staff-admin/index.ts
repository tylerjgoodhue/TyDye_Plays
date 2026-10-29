import { createClient } from "npm:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const MAX_BODY_BYTES = 20_000;
const PERMISSIONS = [
  "dashboard", "tasks", "schedule", "content", "assets", "analytics",
  "community", "shop", "website", "linktree", "social", "settings"
];
const ROLES = ["owner", "admin", "staff", "viewer"];

function cleanPermissions(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  return [...new Set(input.map(value => String(value)).filter(value => PERMISSIONS.includes(value)))].sort();
}

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

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!key) {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      if (typeof keys.service_role === "string") key = keys.service_role;
    } catch { /* ignore */ }
  }
  if (!url || !key) throw new Error("Staff management is not configured. The function runtime is missing its service-role secret key.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authenticatedUser(request: Request) {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    (() => { try { const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}"); return typeof keys.default === "string" ? keys.default : ""; } catch { return ""; } })();
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!url || !key || !token) throw new Error("Sign in to Creator HQ to manage staff accounts.");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("Your Creator HQ session expired. Sign in again.");
  return data.user;
}

function allowedManagers() {
  return (Deno.env.get("STAFF_ADMIN_ALLOWED_USER_IDS") || "")
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
}

Deno.serve(async request => {
  const origin = request.headers.get("Origin") || "";
  const origins = allowedOrigins();
  if (request.method === "OPTIONS") {
    if (!origins.includes(origin)) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
      }
    });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
  if (!origins.includes(origin)) return json({ error: "This app origin is not allowed. Add it to ALLOWED_APP_ORIGINS." }, 403, origin);
  try {
    const caller = await authenticatedUser(request);
    const managers = allowedManagers();
    if (!managers.length) {
      return json({ error: "Staff management is not configured. Set the STAFF_ADMIN_ALLOWED_USER_IDS secret to the owner's Supabase user UUID." }, 403, origin);
    }
    if (!managers.includes(caller.id.toLowerCase())) {
      return json({ error: "Only the workspace owner can manage staff accounts." }, 403, origin);
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large." }, 413, origin);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "Invalid JSON body." }, 400, origin); }
    const action = String(body.action || "");
    const admin = adminClient();

    if (action === "list") {
      const page = Number.isInteger(body.page) && (body.page as number) > 0 ? (body.page as number) : 1;
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 50 });
      if (error) throw error;
      const users = (data?.users || []).map(user => ({
        id: user.id,
        email: user.email || "",
        createdAt: user.created_at || "",
        lastSignInAt: user.last_sign_in_at || "",
        emailConfirmed: Boolean(user.email_confirmed_at),
        banned: Boolean((user as { banned_until?: string }).banned_until && new Date((user as { banned_until?: string }).banned_until || "").getTime() > Date.now()),
        isOwner: caller.id === user.id,
        role: (user.user_metadata as { role?: string } | null)?.role || "",
        permissions: cleanPermissions((user.user_metadata as { permissions?: unknown } | null)?.permissions) || []
      }));
      return json({ users, page, hasMore: Boolean((data as { nextPage?: number | null })?.nextPage) }, 200, origin);
    }

    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!EMAIL.test(email)) return json({ error: "Enter a valid email address for the new staff account." }, 400, origin);
      if (password.length < 8) return json({ error: "Use a password with at least 8 characters." }, 400, origin);
      const role = ROLES.includes(String(body.role || "")) ? String(body.role) : "staff";
      const permissions = cleanPermissions(body.permissions) ?? PERMISSIONS.filter(item => item !== "settings");
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { role: "staff", workspace: "Creator HQ", assignedRole: role, permissions }
      });
      if (error) throw error;
      return json({ user: data.user ? { id: data.user.id, email: data.user.email || email } : null }, 200, origin);
    }

    if (action === "update") {
      const id = String(body.id || "");
      if (!UUID.test(id)) return json({ error: "A valid staff account id is required." }, 400, origin);
      const changes: Record<string, unknown> = {};
      if (typeof body.email === "string" && body.email.trim()) {
        const email = body.email.trim().toLowerCase();
        if (!EMAIL.test(email)) return json({ error: "Enter a valid email address." }, 400, origin);
        changes.email = email;
        changes.email_confirm = true;
      }
      if (typeof body.password === "string" && body.password) {
        if (body.password.length < 8) return json({ error: "Use a password with at least 8 characters." }, 400, origin);
        changes.password = body.password;
      }
      if (!selfEdit && body.banned === true) changes.ban_duration = "876000h";
      if (!selfEdit && body.banned === false) changes.ban_duration = "none";
      const selfEdit = id.toLowerCase() === caller.id.toLowerCase();
      const metadata: Record<string, unknown> = {};
      if (!selfEdit && typeof body.role === "string" && ROLES.includes(body.role)) metadata.assignedRole = body.role;
      const permissions = selfEdit ? null : cleanPermissions(body.permissions);
      if (permissions) metadata.permissions = permissions;
      if (Object.keys(metadata).length) {
        const { data: existing, error: fetchError } = await admin.auth.admin.getUserById(id);
        if (fetchError || !existing?.user) throw fetchError || new Error("Staff account not found.");
        changes.user_metadata = { ...(existing.user.user_metadata || {}), ...metadata };
      }
      if (!Object.keys(changes).length) return json({ error: "Nothing to update." }, 400, origin);
      const { data, error } = await admin.auth.admin.updateUserById(id, changes);
      if (error) throw error;
      return json({ user: data.user ? { id: data.user.id, email: data.user.email || "" } : null }, 200, origin);
    }

    if (action === "delete") {
      const id = String(body.id || "");
      if (!UUID.test(id)) return json({ error: "A valid staff account id is required." }, 400, origin);
      if (id.toLowerCase() === caller.id.toLowerCase()) return json({ error: "You cannot delete the account you are signed in with." }, 400, origin);
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      return json({ deleted: true }, 200, origin);
    }

    return json({ error: "Unknown action." }, 400, origin);
  } catch (error) {
    return json({ error: (error as Error)?.message || "Staff management request failed." }, 400, origin);
  }
});
