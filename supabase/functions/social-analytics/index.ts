import { createClient } from "npm:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 20_000;
const clickWindows = new Map<string, { start: number; count: number }>();

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

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = defaultKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Social analytics storage is not configured. The Supabase function runtime did not provide its secret key.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authenticatedUser(request: Request) {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || defaultKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!url || !key || !token) throw new Error("Sign in to Creator HQ to manage social analytics.");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("Your Creator HQ session expired. Sign in again.");
  return data.user;
}

function allowClick(ip: string) {
  const now = Date.now();
  const current = clickWindows.get(ip);
  if (!current || now - current.start >= 60_000) {
    clickWindows.set(ip, { start: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 60;
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
  if (!origins.includes(origin)) return json({ error: "This website origin is not allowed. Add it to ALLOWED_APP_ORIGINS." }, 403, origin);
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413, origin);
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || !["track", "register", "report"].includes(payload.action)) return json({ error: "Unknown social analytics action." }, 400, origin);

  try {
    const admin = serviceClient();
    if (payload.action === "track") {
      const linkId = typeof payload.linkId === "string" ? payload.linkId : "";
      if (!UUID.test(linkId)) return json({ error: "Invalid social link." }, 400, origin);
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
      if (!allowClick(ip)) return json({ error: "Click rate limit reached." }, 429, origin);
      const { data: link, error: linkError } = await admin.from("creator_social_links").select("link_id").eq("link_id", linkId).eq("is_active", true).maybeSingle();
      if (linkError) throw linkError;
      if (!link) return json({ error: "Social link is not registered." }, 404, origin);
      const { error } = await admin.from("creator_social_clicks").insert({ link_id: linkId, source: "linktree" });
      if (error) throw error;
      return json({ tracked: true }, 202, origin);
    }

    const user = await authenticatedUser(request);
    if (payload.action === "register") {
      const inputLinks = Array.isArray(payload.links) ? payload.links : [];
      if (inputLinks.length > 30) return json({ error: "A maximum of 30 social links can be tracked." }, 400, origin);
      const links = inputLinks.map((link: Record<string, unknown>) => {
        const linkId = typeof link.linkId === "string" ? link.linkId : "";
        const label = typeof link.label === "string" ? link.label.trim().slice(0, 80) : "";
        const platform = typeof link.platform === "string" ? link.platform.trim().slice(0, 40) : "Other";
        const destination = typeof link.url === "string" ? link.url.trim().slice(0, 500) : "";
        let url: URL;
        try { url = new URL(destination); } catch { throw new Error("Each tracked social link needs a valid URL."); }
        if (!UUID.test(linkId) || !label || !["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Each tracked social link needs a valid ID, label, and HTTP(S) URL.");
        return { link_id: linkId, user_id: user.id, label, platform, destination_url: url.href, is_active: true, updated_at: new Date().toISOString() };
      });
      if (links.length) {
        const { data: existing, error: ownershipError } = await admin.from("creator_social_links").select("link_id,user_id").in("link_id", links.map((link: { link_id: string }) => link.link_id));
        if (ownershipError) throw ownershipError;
        if ((existing || []).some((row: { user_id: string }) => row.user_id !== user.id)) return json({ error: "A social link ID is already registered to another workspace." }, 403, origin);
      }
      const { error: deactivateError } = await admin.from("creator_social_links").update({ is_active: false, updated_at: new Date().toISOString() }).eq("user_id", user.id);
      if (deactivateError) throw deactivateError;
      if (links.length) {
        const { error } = await admin.from("creator_social_links").upsert(links, { onConflict: "link_id" });
        if (error) throw error;
      }
      return json({ registered: links.length }, 200, origin);
    }

    const { data: links, error: linksError } = await admin.from("creator_social_links")
      .select("link_id,label,platform,destination_url")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .order("updated_at", { ascending: false });
    if (linksError) throw linksError;
    if (!links?.length) return json({ links: [] }, 200, origin);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const events: Array<{ link_id: string; clicked_at: string }> = [];
    for (let offset = 0; offset < 50_000; offset += 1000) {
      const { data, error } = await admin.from("creator_social_clicks")
        .select("link_id,clicked_at")
        .gte("clicked_at", since)
        .in("link_id", links.map((link: { link_id: string }) => link.link_id))
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (error) throw error;
      events.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const now = Date.now();
    const totals = new Map<string, { clicks30d: number; clicks7d: number; clicksToday: number }>();
    for (const event of events || []) {
      const counts = totals.get(event.link_id) || { clicks30d: 0, clicks7d: 0, clicksToday: 0 };
      const clickedAt = new Date(event.clicked_at).getTime();
      counts.clicks30d += 1;
      if (clickedAt >= now - 7 * 24 * 60 * 60 * 1000) counts.clicks7d += 1;
      if (new Date(event.clicked_at).toDateString() === new Date().toDateString()) counts.clicksToday += 1;
      totals.set(event.link_id, counts);
    }
    return json({ links: (links || []).map((link: { link_id: string; label: string; platform: string; destination_url: string }) => ({
      id: link.link_id, label: link.label, platform: link.platform, url: link.destination_url,
      ...(totals.get(link.link_id) || { clicks30d: 0, clicks7d: 0, clicksToday: 0 })
    })) }, 200, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Social analytics request failed.";
    const status = message.includes("Sign in") || message.includes("session expired") ? 401 : 502;
    return json({ error: message }, status, origin);
  }
});