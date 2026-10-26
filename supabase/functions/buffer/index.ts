import { createClient } from "npm:@supabase/supabase-js@2";

const BUFFER_ENDPOINT = "https://api.buffer.com";
const MAX_BODY_BYTES = 120_000;
const ALLOWED_ACTIONS = new Set(["workspace", "posts", "schedule", "editPost"]);

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

function escapeGraphQLString(value: string) {
  return JSON.stringify(value);
}

async function bufferQuery(apiKey: string, query: string) {
  const response = await fetch(BUFFER_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(result.errors) ? result.errors.map((item: { message?: string }) => item.message).filter(Boolean).join("; ") : "";
    throw new Error(detail || `Buffer API returned HTTP ${response.status}.`);
  }
  if (Array.isArray(result.errors) && result.errors.length) {
    throw new Error(result.errors.map((item: { message?: string }) => item.message).filter(Boolean).join("; ") || "Buffer API request failed.");
  }
  return result.data || {};
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = (Deno.env.get("ALLOWED_APP_ORIGINS") || "http://127.0.0.1:8765,http://localhost:8765")
    .split(",").map((value) => value.trim()).filter(Boolean);

  if (request.method === "OPTIONS") {
    if (!allowedOrigins.includes(origin)) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
      }
    });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!allowedOrigins.includes(origin)) return json({ error: `This app origin (${origin || "missing Origin"}) is not allowed. Set ALLOWED_APP_ORIGINS to the exact origin, for example http://127.0.0.1:8765.` }, 403, origin);

  const authorization = request.headers.get("Authorization") || "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const bufferKey = Deno.env.get("BUFFER_API_KEY");
  const allowedUserId = Deno.env.get("BUFFER_ALLOWED_USER_ID");
  if (!supabaseUrl || !supabaseKey) return json({ error: "Supabase Edge Function auth is not configured." }, 500, origin);
  if (!bufferKey || !allowedUserId) return json({ error: "Buffer is not configured yet. Add BUFFER_API_KEY and BUFFER_ALLOWED_USER_ID as Supabase Edge Function secrets." }, 503, origin);
  if (!accessToken) return json({ error: "Sign in to Creator HQ before using Buffer." }, 401, origin);

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
  if (authError || !authData.user) return json({ error: "Your Creator HQ session expired. Sign in again." }, 401, origin);
  if (authData.user.id !== allowedUserId) return json({ error: "Buffer publishing is not enabled for this Creator HQ account." }, 403, origin);

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413, origin);
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || !ALLOWED_ACTIONS.has(payload.action)) return json({ error: "Unknown Buffer action." }, 400, origin);

  try {
    if (payload.action === "workspace") {
      const data = await bufferQuery(bufferKey, `query CreatorHQBufferWorkspace { account { id email organizations { id name } } }`);
      const organizations = data.account?.organizations || [];
      const channelsByOrganization = await Promise.all(organizations.map(async (organization: { id: string; name: string }) => {
        const query = `query CreatorHQBufferChannels { channels(input: { organizationId: ${escapeGraphQLString(organization.id)} }) { id name service } }`;
        const result = await bufferQuery(bufferKey, query);
        return { id: organization.id, name: organization.name, channels: result.channels || [] };
      }));
      return json({ account: { id: data.account?.id, email: data.account?.email }, organizations: channelsByOrganization }, 200, origin);
    }

    if (payload.action === "posts") {
      const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : "";
      const channelId = typeof payload.channelId === "string" ? payload.channelId : "";
      const after = typeof payload.after === "string" && payload.after.length <= 1000 ? payload.after : "";
      if (!organizationId) return json({ error: "Choose a Buffer organization." }, 400, origin);
      const query = `query CreatorHQBufferPosts { posts(first: 50${after ? `, after: ${escapeGraphQLString(after)}` : ""}, input: { organizationId: ${escapeGraphQLString(organizationId)}, filter: { status: [scheduled]${channelId ? `, channelIds: [${escapeGraphQLString(channelId)}]` : ""} } }) { edges { node { id text dueAt status channelId channelService assets { id type source thumbnail mimeType } } } pageInfo { hasNextPage endCursor } } }`;
      const data = await bufferQuery(bufferKey, query);
      return json({ posts: data.posts?.edges?.map((edge: { node: unknown }) => edge.node) || [], hasNextPage: Boolean(data.posts?.pageInfo?.hasNextPage), endCursor: data.posts?.pageInfo?.endCursor || null }, 200, origin);
    }

    if (payload.action === "editPost") {
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const dueAt = typeof payload.dueAt === "string" ? new Date(payload.dueAt) : null;
      if (!id || id.length > 200) return json({ error: "Choose a valid Buffer post." }, 400, origin);
      if (!text || text.length > 5000) return json({ error: "Post copy is required and must be 5,000 characters or fewer." }, 400, origin);
      if (!dueAt || Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) return json({ error: "Choose a future schedule time." }, 400, origin);
      const mutation = `mutation CreatorHQEditBufferPost { editPost(input: { id: ${escapeGraphQLString(id)}, text: ${escapeGraphQLString(text)}, dueAt: ${escapeGraphQLString(dueAt.toISOString())} }) { ... on PostActionSuccess { post { id text dueAt status channelId channelService assets { id type source thumbnail mimeType } } } ... on MutationError { message } } }`;
      const data = await bufferQuery(bufferKey, mutation);
      const post = data.editPost?.post;
      if (!post) return json({ error: data.editPost?.message || "Buffer did not update the scheduled post." }, 502, origin);
      return json({ post }, 200, origin);
    }

    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    const mode = payload.mode === "customScheduled" ? "customScheduled" : "addToQueue";
    if (!targets.length || targets.length > 10) return json({ error: "Select between 1 and 10 Buffer channels." }, 400, origin);
    const channelIds = targets.map((target: { channelId?: unknown }) => typeof target?.channelId === "string" ? target.channelId : "");
    if (channelIds.some((id: string) => !id) || new Set(channelIds).size !== channelIds.length) return json({ error: "Each selected channel must be valid and unique." }, 400, origin);

    let dueAtValue = "";
    if (mode === "customScheduled") {
      const dueAt = typeof payload.dueAt === "string" ? new Date(payload.dueAt) : null;
      if (!dueAt || Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) return json({ error: "Choose a future schedule time." }, 400, origin);
      dueAtValue = dueAt.toISOString();
    }
    const results = [];
    for (const target of targets) {
      const channelId = typeof target.channelId === "string" ? target.channelId : "";
      const text = typeof target.text === "string" ? target.text.trim() : "";
      const assetType = target.assetType === "image" || target.assetType === "video" ? target.assetType : "";
      const assetUrl = typeof target.assetUrl === "string" ? target.assetUrl.trim() : "";
      if (!text) { results.push({ channelId, error: "Post copy is required for this channel." }); continue; }
      if (text.length > 5000) { results.push({ channelId, error: "Post text is too long (maximum 5,000 characters)." }); continue; }
      if (assetType && !assetUrl) { results.push({ channelId, error: "Enter a media URL or choose no media." }); continue; }
      if (assetUrl) {
        let mediaUrl: URL;
        try { mediaUrl = new URL(assetUrl); }
        catch { results.push({ channelId, error: "Enter a valid public HTTPS media URL." }); continue; }
        if (mediaUrl.protocol !== "https:" || mediaUrl.username || mediaUrl.password || !mediaUrl.hostname.includes(".")) {
          results.push({ channelId, error: "Buffer needs a direct, stable, public HTTPS media URL." });
          continue;
        }
      }

      try {
        const scheduling = mode === "customScheduled" ? `mode: customScheduled, dueAt: ${escapeGraphQLString(dueAtValue)}` : "mode: addToQueue";
        const assets = assetType ? `, assets: [{ ${assetType}: { url: ${escapeGraphQLString(assetUrl)} } }]` : "";
        const mutation = `mutation CreatorHQScheduleBufferPost { createPost(input: { text: ${escapeGraphQLString(text)}, channelId: ${escapeGraphQLString(channelId)}, schedulingType: automatic, ${scheduling}${assets} }) { ... on PostActionSuccess { post { id text dueAt status channelId } } ... on MutationError { message } } }`;
        const data = await bufferQuery(bufferKey, mutation);
        const post = data.createPost?.post;
        if (post) results.push({ channelId, post });
        else results.push({ channelId, error: data.createPost?.message || "Buffer did not return a scheduled post." });
      } catch (error) {
        results.push({ channelId, error: error instanceof Error ? error.message : "Buffer request failed." });
      }
    }
    return json({ results }, 200, origin);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Buffer request failed." }, 502, origin);
  }
});
