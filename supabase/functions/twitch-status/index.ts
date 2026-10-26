const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_STREAMS_URL = "https://api.twitch.tv/helix/streams";
const TWITCH_USERS_URL = "https://api.twitch.tv/helix/users";
const CACHE_MS = 30_000;
const MIN_REFRESH_MS = 15_000;

let appToken = "";
let tokenExpiresAt = 0;
let cachedStatus: { login: string; data: Record<string, unknown>; expiresAt: number } | null = null;
let lastUpstreamCheck = 0;
let pendingRefresh: Promise<Record<string, unknown>> | null = null;

function json(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${Math.floor(CACHE_MS / 1000)}`,
      ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {})
    }
  });
}

function allowedOrigins() {
  return (Deno.env.get("ALLOWED_APP_ORIGINS") || "http://127.0.0.1:8765,http://localhost:8765")
    .split(",").map((value) => value.trim()).filter(Boolean);
}

async function getAppToken(clientId: string, clientSecret: string) {
  if (appToken && Date.now() < tokenExpiresAt - 60_000) return appToken;
  const response = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(10_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") throw new Error("Twitch authorization failed.");
  appToken = result.access_token;
  tokenExpiresAt = Date.now() + Number(result.expires_in || 0) * 1000;
  return appToken;
}

async function fetchLiveStatus(login: string, clientId: string, clientSecret: string) {
  const token = await getAppToken(clientId, clientSecret);
  const url = new URL(TWITCH_STREAMS_URL);
  url.searchParams.set("user_login", login);
  const usersUrl = new URL(TWITCH_USERS_URL);
  usersUrl.searchParams.set("login", login);
  const headers = { Authorization: `Bearer ${token}`, "Client-Id": clientId };
  const [response, userResponse] = await Promise.all([
    fetch(url, { headers, signal: AbortSignal.timeout(10_000) }),
    fetch(usersUrl, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null)
  ]);
  if (response.status === 401) {
    appToken = "";
    tokenExpiresAt = 0;
    throw new Error("Twitch authorization expired; retry shortly.");
  }
  if (!response.ok) throw new Error(`Twitch returned HTTP ${response.status}.`);
  const result = await response.json().catch(() => ({}));
  const userResult = userResponse?.ok ? await userResponse.json().catch(() => ({})) : {};
  const stream = Array.isArray(result.data) ? result.data[0] : null;
  const user = Array.isArray(userResult.data) ? userResult.data[0] : null;
  return {
    login,
    profileImageUrl: typeof user?.profile_image_url === "string" && user.profile_image_url.startsWith("https://") ? user.profile_image_url : "",
    live: Boolean(stream && stream.type === "live"),
    title: typeof stream?.title === "string" ? stream.title.slice(0, 140) : "",
    game: typeof stream?.game_name === "string" ? stream.game_name.slice(0, 100) : "",
    viewerCount: Number.isFinite(stream?.viewer_count) ? stream.viewer_count : null,
    startedAt: typeof stream?.started_at === "string" ? stream.started_at : null,
    checkedAt: new Date().toISOString()
  };
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin") || "";
  const origins = allowedOrigins();
  if (request.method === "OPTIONS") {
    if (!origins.includes(origin)) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
      }
    });
  }
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, origin);
  if (!origins.includes(origin)) return json({ error: "This website origin is not allowed. Add it to ALLOWED_APP_ORIGINS." }, 403, origin);

  const clientId = Deno.env.get("TWITCH_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("TWITCH_CLIENT_SECRET") || "";
  const configuredLogin = (Deno.env.get("TWITCH_CHANNEL_LOGIN") || "").trim().toLowerCase();
  if (!clientId || !clientSecret || !configuredLogin) {
    return json({ error: "Twitch live status is not configured. Set TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, and TWITCH_CHANNEL_LOGIN as function secrets." }, 503, origin);
  }
  if (!/^[a-z0-9_]{1,25}$/.test(configuredLogin)) return json({ error: "TWITCH_CHANNEL_LOGIN is invalid." }, 500, origin);

  const requestedLogin = new URL(request.url).searchParams.get("login")?.trim().toLowerCase();
  if (requestedLogin && requestedLogin !== configuredLogin) return json({ error: "This endpoint only reports the configured Twitch channel." }, 403, origin);
  if (cachedStatus?.login === configuredLogin && Date.now() < cachedStatus.expiresAt) return json(cachedStatus.data, 200, origin);
  if (Date.now() - lastUpstreamCheck < MIN_REFRESH_MS) {
    return json({ error: "Status refresh is cooling down. Retry shortly." }, 429, origin);
  }
  if (pendingRefresh) {
    try { return json(await pendingRefresh, 200, origin); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "Could not read Twitch status." }, 502, origin); }
  }

  lastUpstreamCheck = Date.now();
  pendingRefresh = fetchLiveStatus(configuredLogin, clientId, clientSecret);
  try {
    const data = await pendingRefresh;
    cachedStatus = { login: configuredLogin, data, expiresAt: Date.now() + CACHE_MS };
    return json(data, 200, origin);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not read Twitch status." }, 502, origin);
  } finally {
    pendingRefresh = null;
  }
});
