import { createClient } from "npm:@supabase/supabase-js@2";

type Provider = "twitch" | "youtube" | "instagram" | "tiktok";
type TokenSet = { access_token: string; refresh_token?: string; expires_at?: number; scope?: string[] | string };

const PROVIDERS: Provider[] = ["twitch", "youtube", "instagram", "tiktok"];
const CALLBACK_PATH = "/functions/v1/social-accounts";
const MAX_BODY_BYTES = 8_000;

function json(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}) }
  });
}

function allowedOrigins() {
  return (Deno.env.get("ALLOWED_APP_ORIGINS") || "http://127.0.0.1:8765,http://localhost:8765").split(",").map(value => value.trim()).filter(Boolean);
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

function decodeSecret(name: string) {
  const value = Deno.env.get(name) || "";
  if (!value) return new Uint8Array();
  try {
    const decoded = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    if (decoded.length === 32) return decoded;
  } catch {}
  return new TextEncoder().encode(value);
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = defaultKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Platform account storage is not configured in this Supabase project.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authenticatedUser(request: Request) {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || defaultKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!url || !key || !token) throw new Error("Sign in to Creator HQ to manage platform accounts.");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("Your Creator HQ session expired. Sign in again.");
  return data.user;
}

function config(provider: Provider) {
  const credentials: Record<Provider, { clientId: string; clientSecret: string }> = {
    twitch: { clientId: Deno.env.get("TWITCH_CLIENT_ID") || "", clientSecret: Deno.env.get("TWITCH_CLIENT_SECRET") || "" },
    youtube: { clientId: Deno.env.get("YOUTUBE_CLIENT_ID") || "", clientSecret: Deno.env.get("YOUTUBE_CLIENT_SECRET") || "" },
    instagram: { clientId: Deno.env.get("INSTAGRAM_CLIENT_ID") || "", clientSecret: Deno.env.get("INSTAGRAM_CLIENT_SECRET") || "" },
    tiktok: { clientId: Deno.env.get("TIKTOK_CLIENT_KEY") || "", clientSecret: Deno.env.get("TIKTOK_CLIENT_SECRET") || "" }
  };
  const result = credentials[provider];
  if (!result.clientId || !result.clientSecret) throw new Error(`${provider} app credentials are not configured in Supabase Function secrets.`);
  return result;
}

function callbackUrl() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  if (!url) throw new Error("Supabase URL is unavailable to the Edge Function.");
  return `${url.replace(/\/$/, "")}${CALLBACK_PATH}`;
}

function randomHex(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return [...values].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach(value => binary += String.fromCharCode(value));
  return btoa(binary);
}

async function encryptionKey() {
  const secret = decodeSecret("SOCIAL_TOKEN_ENCRYPTION_KEY");
  if (secret.length !== 32) throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return await crypto.subtle.importKey("raw", secret, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptTokens(tokens: TokenSet) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), new TextEncoder().encode(JSON.stringify(tokens)));
  return `${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}

async function decryptTokens(ciphertext: string): Promise<TokenSet> {
  const [ivText, dataText] = ciphertext.split(".");
  if (!ivText || !dataText) throw new Error("Stored provider authorization cannot be decrypted.");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(atob(ivText), character => character.charCodeAt(0)) }, await encryptionKey(), Uint8Array.from(atob(dataText), character => character.charCodeAt(0)));
  return JSON.parse(new TextDecoder().decode(clear));
}

async function providerJson(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result?.error?.message || result?.error_description || result?.message || result?.error?.message || `Provider returned HTTP ${response.status}.`;
    throw new Error(String(message).slice(0, 250));
  }
  if (result?.error?.code && result.error.code !== "ok") throw new Error(String(result.error.message || result.error.code).slice(0, 250));
  return result;
}

function tokenExpiry(result: Record<string, unknown>) {
  return Date.now() + Math.max(0, Number(result.expires_in) || 0) * 1000;
}

function safeProviderError(error: unknown) {
  const raw = error instanceof Error ? error.message : "Provider request failed.";
  return raw
    .replace(/(access_token|refresh_token|client_secret|authorization_code|\bcode\b)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/https?:\/\/\S+/gi, "[provider endpoint]")
    .slice(0, 120);
}

function scopesOf(tokens: TokenSet) {
  return Array.isArray(tokens.scope) ? tokens.scope : typeof tokens.scope === "string" ? tokens.scope.split(/[ ,]+/).filter(Boolean) : [];
}

async function authorizeUrl(provider: Provider, state: string) {
  const { clientId } = config(provider);
  const redirectUri = callbackUrl();
  const urls: Record<Provider, string> = {
    twitch: "https://id.twitch.tv/oauth2/authorize",
    youtube: "https://accounts.google.com/o/oauth2/v2/auth",
    instagram: "https://www.instagram.com/oauth/authorize",
    tiktok: "https://www.tiktok.com/v2/auth/authorize/"
  };
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", state });
  if (provider === "twitch") params.set("scope", "moderator:read:followers");
  if (provider === "youtube") {
    params.set("client_id", clientId);
    params.set("scope", "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly");
    params.set("access_type", "offline");
    params.set("prompt", "select_account consent");
    params.set("include_granted_scopes", "true");
  }
  if (provider === "instagram") {
    params.delete("client_id");
    params.set("client_id", clientId);
    params.set("scope", "instagram_business_basic,instagram_business_manage_insights");
    params.set("enable_fb_login", "0");
  }
  if (provider === "tiktok") {
    params.delete("client_id");
    params.set("client_key", clientId);
    params.set("scope", "user.info.basic,user.info.stats,video.list");
  }
  return `${urls[provider]}?${params.toString()}`;
}

async function exchangeCode(provider: Provider, code: string): Promise<TokenSet> {
  const { clientId, clientSecret } = config(provider);
  const redirectUri = callbackUrl();
  let result: Record<string, unknown>;
  if (provider === "twitch") {
    result = await providerJson("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }) });
  } else if (provider === "youtube") {
    result = await providerJson("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }) });
  } else if (provider === "instagram") {
    const short = await providerJson("https://api.instagram.com/oauth/access_token", { method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }) });
    const long = await providerJson(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: clientSecret, access_token: String(short.access_token || "") })}`);
    result = { ...long, user_id: short.user_id, permissions: short.permissions };
  } else {
    result = await providerJson("https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_key: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }) });
  }
  const tokenResult = provider === "tiktok" ? (result.data || {}) : result;
  const accessToken = String(tokenResult.access_token || "");
  if (!accessToken) throw new Error(`${provider} did not return an access token.`);
  return {
    access_token: accessToken,
    refresh_token: typeof tokenResult.refresh_token === "string" ? tokenResult.refresh_token : undefined,
    expires_at: tokenExpiry(tokenResult),
    scope: Array.isArray(tokenResult.scope) ? tokenResult.scope as string[] : typeof tokenResult.scope === "string" ? tokenResult.scope : typeof result.permissions === "string" ? result.permissions : ""
  };
}

async function refreshTokens(provider: Provider, tokens: TokenSet): Promise<TokenSet> {
  if (tokens.expires_at && tokens.expires_at > Date.now() + 120_000) return tokens;
  const { clientId, clientSecret } = config(provider);
  if (provider === "instagram") {
    const result = await providerJson(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: tokens.access_token })}`);
    return { ...tokens, access_token: String(result.access_token || tokens.access_token), expires_at: tokenExpiry(result) };
  }
  if (!tokens.refresh_token) throw new Error(`${provider} authorization expired. Reconnect this account.`);
  const body = provider === "tiktok"
    ? new URLSearchParams({ client_key: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: tokens.refresh_token })
    : new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  const url = provider === "twitch" ? "https://id.twitch.tv/oauth2/token" : provider === "youtube" ? "https://oauth2.googleapis.com/token" : "https://open.tiktokapis.com/v2/oauth/token/";
  const result = await providerJson(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const tokenResult = provider === "tiktok" ? (result.data || {}) : result;
  return {
    ...tokens,
    access_token: String(tokenResult.access_token || tokens.access_token),
    refresh_token: typeof tokenResult.refresh_token === "string" ? tokenResult.refresh_token : tokens.refresh_token,
    expires_at: tokenExpiry(tokenResult),
    scope: Array.isArray(tokenResult.scope) ? tokenResult.scope as string[] : tokens.scope
  };
}

async function identifyAccount(provider: Provider, tokens: TokenSet) {
  if (provider === "twitch") {
    const user = (await providerJson("https://api.twitch.tv/helix/users", { headers: { Authorization: `Bearer ${tokens.access_token}`, "Client-Id": config(provider).clientId } })).data?.[0];
    if (!user?.id) throw new Error("Could not read the authorized Twitch account.");
    return { id: String(user.id), name: String(user.display_name || user.login), username: String(user.login || "") };
  }
  if (provider === "youtube") {
    const user = (await providerJson("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${tokens.access_token}` } })).items?.[0];
    if (!user?.id) throw new Error("YOUTUBE_CHANNEL_NOT_FOUND");
    return { id: String(user.id), name: String(user.snippet?.title || "YouTube channel"), username: String(user.snippet?.customUrl || "") };
  }
  if (provider === "instagram") {
    const result = await providerJson(`https://graph.instagram.com/me?${new URLSearchParams({ fields: "id,username" , access_token: tokens.access_token })}`);
    if (!result.id) throw new Error("Could not read the authorized Instagram professional account.");
    return { id: String(result.id), name: String(result.username || "Instagram account"), username: String(result.username || "") };
  }
  const result = await providerJson("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const user = result.data?.user;
  if (!user?.open_id) throw new Error("Could not read the authorized TikTok account.");
  return { id: String(user.open_id), name: String(user.display_name || "TikTok account"), username: String(user.username || "") };
}

function utcDate() { return new Date().toISOString().slice(0, 10); }

function dateDaysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

async function storeMetrics(admin: ReturnType<typeof serviceClient>, userId: string, provider: Provider, daily: Array<{ date: string; metrics: Record<string, unknown> }>) {
  if (!daily.length) daily.push({ date: utcDate(), metrics: {} });
  const rows = daily.map(item => ({ user_id: userId, provider, metric_date: item.date, metrics: item.metrics, fetched_at: new Date().toISOString() }));
  const { error } = await admin.from("creator_platform_metrics").upsert(rows, { onConflict: "user_id,provider,metric_date" });
  if (error) throw error;
}

async function syncProvider(admin: ReturnType<typeof serviceClient>, account: Record<string, any>) {
  const provider = account.provider as Provider;
  let tokens = await decryptTokens(account.token_ciphertext);
  tokens = await refreshTokens(provider, tokens);
  let displayName = account.display_name;
  let username = account.username;
  const daily: Array<{ date: string; metrics: Record<string, unknown> }> = [];

  if (provider === "twitch") {
    const headers = { Authorization: `Bearer ${tokens.access_token}`, "Client-Id": config(provider).clientId };
    const followers = await providerJson(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(account.external_account_id)}&first=1`, { headers });
    const streams = await providerJson(`https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(account.external_account_id)}`, { headers });
    daily.push({ date: utcDate(), metrics: { followers: Number(followers.total || 0), liveViewers: Number(streams.data?.[0]?.viewer_count || 0), live: Boolean(streams.data?.[0]), streamTitle: String(streams.data?.[0]?.title || "") } });
  } else if (provider === "youtube") {
    const channel = (await providerJson("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true", { headers: { Authorization: `Bearer ${tokens.access_token}` } })).items?.[0];
    if (!channel?.id) throw new Error("No YouTube channel was returned for this account.");
    displayName = String(channel.snippet?.title || displayName);
    const stats = channel.statistics || {};
    daily.push({ date: utcDate(), metrics: { subscribers: Number(stats.subscriberCount || 0), channelViews: Number(stats.viewCount || 0), videoCount: Number(stats.videoCount || 0) } });
    const report = await providerJson(`https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: "channel==MINE", startDate: dateDaysAgo(29), endDate: dateDaysAgo(1), dimensions: "day", metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost", sort: "day" })}`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    for (const row of report.rows || []) daily.push({ date: String(row[0]), metrics: { views: Number(row[1] || 0), watchMinutes: Number(row[2] || 0), subscribersGained: Number(row[3] || 0), subscribersLost: Number(row[4] || 0) } });
  } else if (provider === "instagram") {
    const profile = await providerJson(`https://graph.instagram.com/me?${new URLSearchParams({ fields: "id,username,followers_count,media_count", access_token: tokens.access_token })}`);
    displayName = String(profile.username || displayName);
    username = String(profile.username || username);
    const insight = await providerJson(`https://graph.instagram.com/${encodeURIComponent(account.external_account_id)}/insights?${new URLSearchParams({ metric: "reach,profile_views,accounts_engaged", period: "day", access_token: tokens.access_token })}`);
    const metrics: Record<string, unknown> = { followers: Number(profile.followers_count || 0), mediaCount: Number(profile.media_count || 0) };
    for (const item of insight.data || []) {
      const last = Array.isArray(item.values) ? item.values[item.values.length - 1] : null;
      if (last && item.name) metrics[String(item.name)] = Number(last.value || 0);
    }
    daily.push({ date: utcDate(), metrics });
  } else {
    const profile = await providerJson("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username,follower_count,following_count,likes_count,video_count", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const user = profile.data?.user || {};
    displayName = String(user.display_name || displayName);
    username = String(user.username || username);
    const videos = await providerJson("https://open.tiktokapis.com/v2/video/list/?fields=id,create_time,view_count,like_count,comment_count,share_count", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ max_count: 20 }) });
    const recent = videos.data?.videos || [];
    daily.push({ date: utcDate(), metrics: {
      followers: Number(user.follower_count || 0), following: Number(user.following_count || 0), likes: Number(user.likes_count || 0), videoCount: Number(user.video_count || 0),
      recentVideoViews: recent.reduce((sum: number, video: Record<string, unknown>) => sum + Number(video.view_count || 0), 0),
      recentVideoLikes: recent.reduce((sum: number, video: Record<string, unknown>) => sum + Number(video.like_count || 0), 0),
      recentVideoComments: recent.reduce((sum: number, video: Record<string, unknown>) => sum + Number(video.comment_count || 0), 0),
      recentVideoShares: recent.reduce((sum: number, video: Record<string, unknown>) => sum + Number(video.share_count || 0), 0)
    } });
  }

  await storeMetrics(admin, account.user_id, provider, daily);
  const { error } = await admin.from("creator_platform_accounts").update({ token_ciphertext: await encryptTokens(tokens), token_expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null, display_name: displayName, username, last_synced_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("user_id", account.user_id).eq("provider", provider);
  if (error) throw error;
  return { provider, displayName, username, lastSyncedAt: new Date().toISOString(), metricDates: daily.length };
}

async function callback(request: Request) {
  const params = new URL(request.url).searchParams;
  const state = params.get("state") || "";
  const admin = serviceClient();
  let returnUrl = new URL("/", allowedOrigins()[0] || "https://localhost");
  const finish = (provider: string, status: string, detail = "") => {
    returnUrl.searchParams.set("social_connection", status);
    if (PROVIDERS.includes(provider as Provider)) returnUrl.searchParams.set("provider", provider);
    if (detail) returnUrl.searchParams.set("social_error", detail.slice(0, 180));
    return Response.redirect(returnUrl.toString(), 303);
  };
  if (!state || state.length > 200) return finish("", "invalid");
  const stateHash = await sha256(state);
  const { data: row, error } = await admin.from("creator_oauth_states").delete().eq("state_hash", stateHash).select("state_hash,user_id,provider,return_url,expires_at").maybeSingle();
  if (error || !row) return finish("", "invalid");
  returnUrl = new URL(row.return_url);
  if (new Date(row.expires_at).getTime() < Date.now()) return finish(row.provider, "expired");
  if (params.has("error") || !params.get("code")) return finish(row.provider, "denied");
  let stage = "exchange";
  try {
    const provider = row.provider as Provider;
    const tokens = await exchangeCode(provider, params.get("code") || "");
    stage = "account_lookup";
    const identity = await identifyAccount(provider, tokens);
    stage = "storage";
    const { error: saveError } = await admin.from("creator_platform_accounts").upsert({
      user_id: row.user_id, provider, external_account_id: identity.id, display_name: identity.name, username: identity.username,
      scopes: scopesOf(tokens), token_ciphertext: await encryptTokens(tokens), token_expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
      connected_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null
    }, { onConflict: "user_id,provider" });
    if (saveError) throw saveError;
    return finish(provider, "success");
  } catch (error) {
    const safeError = safeProviderError(error);
    console.error("Social provider callback failed", row.provider, stage, safeError);
    const details: Record<string, string> = {
      exchange: `${row.provider} token exchange failed (${safeError}). Check the OAuth client ID/secret and exact redirect URI.`,
      account_lookup: `${row.provider} authorization succeeded, but account lookup failed (${safeError}). Check that the provider API is enabled and the requested scopes were granted.`,
      storage: `${row.provider} authorization succeeded, but saving the connection failed (${safeError}). Check the database migration and token encryption key.`
    };
    const noChannel = row.provider === "youtube" && error instanceof Error && error.message === "YOUTUBE_CHANNEL_NOT_FOUND";
    const youtubeApiDisabled = row.provider === "youtube" && error instanceof Error && /YouTube Data API v3 has not been used|YouTube Data API v3.*disabled/i.test(error.message);
    const detail = noChannel
      ? "Google sign-in succeeded, but no YouTube channel was found. Reconnect and choose the Google account or Brand Account that owns your channel."
      : youtubeApiDisabled
      ? "Enable YouTube Data API v3 and YouTube Analytics API in Google Cloud project 993666341767, then connect YouTube again."
      : details[stage] || "Provider connection failed.";
    return finish(row.provider, "failed", detail);
  }
}

Deno.serve(async request => {
  const origin = request.headers.get("Origin") || "";
  const origins = allowedOrigins();
  if (request.method === "OPTIONS") {
    if (!origins.includes(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Max-Age": "86400", "Vary": "Origin" } });
  }
  const url = new URL(request.url);
  if (request.method === "GET") return await callback(request);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
  if (origin && !origins.includes(origin)) return json({ error: "This website origin is not allowed. Add it to ALLOWED_APP_ORIGINS." }, 403, origin);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413, origin);
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") return json({ error: "Invalid request." }, 400, origin);

  if (payload.action === "scheduledSync") {
    const expected = Deno.env.get("SOCIAL_SYNC_CRON_SECRET") || "";
    const supplied = request.headers.get("x-social-sync-secret") || "";
    if (!expected || supplied.length !== expected.length) return json({ error: "Scheduled sync is not authorized." }, 401, origin);
    const secretBytes = new TextEncoder().encode(expected);
    const suppliedBytes = new TextEncoder().encode(supplied);
    let mismatch = 0;
    for (let index = 0; index < secretBytes.length; index++) mismatch |= secretBytes[index] ^ suppliedBytes[index];
    if (mismatch !== 0) return json({ error: "Scheduled sync is not authorized." }, 401, origin);
    try {
      const admin = serviceClient();
      const { data: accounts, error } = await admin.from("creator_platform_accounts").select("*");
      if (error) throw error;
      const results = await Promise.all((accounts || []).map(async (account: Record<string, any>) => {
        try { return { ...(await syncProvider(admin, account)), ok: true }; }
        catch (error) {
          const detail = error instanceof Error ? error.message.slice(0, 200) : "Metric sync failed.";
          await admin.from("creator_platform_accounts").update({ last_error: detail, updated_at: new Date().toISOString() }).eq("user_id", account.user_id).eq("provider", account.provider);
          return { provider: account.provider, ok: false, error: detail };
        }
      }));
      return json({ synced: results.length, results }, 200, origin);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Scheduled sync failed." }, 502, origin);
    }
  }

  try {
    const user = await authenticatedUser(request);
    const admin = serviceClient();
    if (payload.action === "start") {
      const provider = String(payload.provider || "") as Provider;
      if (!PROVIDERS.includes(provider)) return json({ error: "Choose a supported platform." }, 400, origin);
      config(provider);
      await encryptionKey();
      const state = randomHex();
      const returnUrl = new URL(typeof payload.returnUrl === "string" ? payload.returnUrl : "/index.html", origin);
      if (returnUrl.origin !== origin || !origins.includes(returnUrl.origin)) return json({ error: "Return to the website where you started the connection." }, 400, origin);
      returnUrl.search = "";
      returnUrl.hash = "";
      const { error } = await admin.from("creator_oauth_states").insert({ state_hash: await sha256(state), user_id: user.id, provider, return_url: returnUrl.toString(), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
      if (error) throw error;
      return json({ authorizationUrl: await authorizeUrl(provider, state) }, 200, origin);
    }
    if (payload.action === "accounts") {
      const { data, error } = await admin.from("creator_platform_accounts").select("provider,external_account_id,display_name,username,scopes,connected_at,last_synced_at,last_error").eq("user_id", user.id);
      if (error) throw error;
      const { data: metrics, error: metricsError } = await admin.from("creator_platform_metrics").select("provider,metric_date,metrics,fetched_at").eq("user_id", user.id).order("metric_date", { ascending: false }).limit(120);
      if (metricsError) throw metricsError;
      return json({ accounts: data || [], metrics: metrics || [] }, 200, origin);
    }
    if (payload.action === "sync") {
      const requested = Array.isArray(payload.providers) ? payload.providers.filter((provider: unknown): provider is Provider => typeof provider === "string" && PROVIDERS.includes(provider as Provider)) : PROVIDERS;
      const { data: accounts, error } = await admin.from("creator_platform_accounts").select("*").eq("user_id", user.id).in("provider", requested);
      if (error) throw error;
      const results = await Promise.all((accounts || []).map(async (account: Record<string, any>) => {
        try { return { ...(await syncProvider(admin, account)), ok: true }; }
        catch (error) {
          const detail = error instanceof Error ? error.message.slice(0, 200) : "Metric sync failed.";
          await admin.from("creator_platform_accounts").update({ last_error: detail, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("provider", account.provider);
          return { provider: account.provider, ok: false, error: detail };
        }
      }));
      const { data: metrics, error: metricsError } = await admin.from("creator_platform_metrics").select("provider,metric_date,metrics,fetched_at").eq("user_id", user.id).order("metric_date", { ascending: false }).limit(120);
      if (metricsError) throw metricsError;
      return json({ results, metrics: metrics || [] }, 200, origin);
    }
    if (payload.action === "disconnect") {
      const provider = String(payload.provider || "") as Provider;
      if (!PROVIDERS.includes(provider)) return json({ error: "Choose a supported platform." }, 400, origin);
      const { error } = await admin.from("creator_platform_accounts").delete().eq("user_id", user.id).eq("provider", provider);
      if (error) throw error;
      return json({ disconnected: true }, 200, origin);
    }
    return json({ error: "Unknown platform account action." }, 400, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Platform account request failed.";
    const status = message.includes("Sign in") || message.includes("session expired") ? 401 : message.includes("credentials are not configured") || message.includes("ENCRYPTION_KEY") ? 503 : 502;
    return json({ error: message }, status, origin);
  }
});