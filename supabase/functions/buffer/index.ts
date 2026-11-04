import { createClient } from "npm:@supabase/supabase-js@2";

const BUFFER_ENDPOINT = "https://api.buffer.com";
const MAX_BODY_BYTES = 120_000;
const ALLOWED_ACTIONS = new Set(["workspace", "posts", "schedule", "editPost", "contentPosts"]);

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

  if (new URL(request.url).searchParams.get("action") === "uploadMedia") {
    if (Deno.env.get("BUFFER_MEDIA_UPLOADS_ENABLED") !== "true") return json({ error: "Publishing uploads are not enabled. Use a public media link, or ask the site owner to enable publishing uploads." }, 503, origin);
    try {
      const type = request.headers.get("Content-Type")?.split(";")[0] || "";
      const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
      if (!extensions[type]) return json({ error: "Choose a JPG, PNG, WebP, GIF, MP4, MOV, or WebM file." }, 400, origin);
      if (Number(request.headers.get("Content-Length")) > 50 * 1024 * 1024) return json({ error: "Choose a file under 50 MB." }, 413, origin);
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 50 * 1024 * 1024) return json({ error: "Choose a nonempty file under 50 MB." }, 413, origin);
      let serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      if (!serviceKey) { try { serviceKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch {} }
      if (!serviceKey) throw new Error("Publishing media storage is not configured on the server.");
      const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
      const bucket = "creatorhq-buffer-media";
      const existing = await admin.storage.getBucket(bucket);
      if (existing.error) {
        if (String(existing.error.status) !== "404" && String(existing.error.statusCode) !== "404") throw existing.error;
        const created = await admin.storage.createBucket(bucket, { public: true, fileSizeLimit: 50 * 1024 * 1024, allowedMimeTypes: Object.keys(extensions) });
        if (created.error && !/already exists/i.test(created.error.message)) throw created.error;
      } else if (!existing.data.public) throw new Error("The publishing media bucket must serve public links. Contact the site owner.");
      const path = `${authData.user.id}/${crypto.randomUUID()}.${extensions[type]}`;
      const uploaded = await admin.storage.from(bucket).upload(path, bytes, { contentType: type, upsert: false });
      if (uploaded.error) throw uploaded.error;
      return json({ url: admin.storage.from(bucket).getPublicUrl(path).data.publicUrl, type: type.startsWith("video/") ? "video" : "image" }, 200, origin);
    } catch (error) { return json({ error: error instanceof Error ? error.message : "Media upload failed." }, 502, origin); }
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413, origin);
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request is too large." }, 413, origin);
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (!payload || typeof payload !== "object" || !ALLOWED_ACTIONS.has(payload.action)) return json({ error: "Unknown Buffer action." }, 400, origin);

  try {
    if (payload.action === "workspace") {
      const data = await bufferQuery(bufferKey, `query CreatorHQBufferWorkspace { account { id email organizations { id name } } }`);
      const organizations = data.account?.organizations || [];
      const channelsByOrganization = await Promise.all(organizations.map(async (organization: { id: string; name: string }) => {
        const query = `query CreatorHQBufferChannels { channels(input: { organizationId: ${escapeGraphQLString(organization.id)} }) { id name service timezone isDisconnected isLocked isQueuePaused } }`;
        const result = await bufferQuery(bufferKey, query);
        return { id: organization.id, name: organization.name, channels: result.channels || [] };
      }));
      return json({ account: { id: data.account?.id, email: data.account?.email }, organizations: channelsByOrganization, mediaUploadsEnabled: Deno.env.get("BUFFER_MEDIA_UPLOADS_ENABLED") === "true" }, 200, origin);
    }

    if(payload.action === "contentPosts") {
      const ids=Array.isArray(payload.ids)?payload.ids:[];
      if(!ids.length||ids.length>20||ids.some((id:unknown)=>typeof id!=="string"||!id||id.length>200))return json({error:"Choose between 1 and 20 linked posts."},400,origin);
      const results=await Promise.allSettled(ids.map(async(id:string)=>{
        const data=await bufferQuery(bufferKey,`query { post(input:{id:${escapeGraphQLString(id)}}) { id status dueAt channelId error {message} externalLink } }`);
        if(!data.post)throw new Error("Post unavailable");return data.post;
      }));
      return json({posts:results.filter(result=>result.status==="fulfilled").map(result=>(result as PromiseFulfilledResult<unknown>).value),unresolved:results.filter(result=>result.status==="rejected").length},200,origin);
    }

    if (payload.action === "posts") {
      const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : "";
      const channelId = typeof payload.channelId === "string" ? payload.channelId : "";
      const after = typeof payload.after === "string" && payload.after.length <= 1000 ? payload.after : "";
      if (!organizationId) return json({ error: "Choose a Buffer organization." }, 400, origin);
      const status = ["scheduled", "draft", "error", "sent", "needs_approval"].includes(payload.status) ? payload.status : "scheduled";
      const query = `query CreatorHQBufferPosts { posts(first: 50${after ? `, after: ${escapeGraphQLString(after)}` : ""}, input: { organizationId: ${escapeGraphQLString(organizationId)}, filter: { status: [${status}]${channelId ? `, channelIds: [${escapeGraphQLString(channelId)}]` : ""} } }) { edges { node { id text dueAt status channelId channelService allowedActions error { message } externalLink sentAt assets { id type source thumbnail mimeType } } } pageInfo { hasNextPage endCursor } } }`;
      const data = await bufferQuery(bufferKey, query);
      return json({ posts: data.posts?.edges?.map((edge: { node: unknown }) => edge.node) || [], hasNextPage: Boolean(data.posts?.pageInfo?.hasNextPage), endCursor: data.posts?.pageInfo?.endCursor || null }, 200, origin);
    }

    if (payload.action === "editPost") {
      const id = typeof payload.id === "string" ? payload.id.trim() : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const dueAt = typeof payload.dueAt === "string" ? new Date(payload.dueAt) : null;
      if (!id || id.length > 200) return json({ error: "Choose a valid Buffer post." }, 400, origin);
      if (!text || text.length > 5000) return json({ error: "Post copy is required and must be 5,000 characters or fewer." }, 400, origin);
      const mode = payload.mode || (payload.dueAt ? "customScheduled" : undefined);
      if (mode === "customScheduled" && (!dueAt || Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now())) return json({ error: "Choose a future schedule time." }, 400, origin);
      if (mode && !["customScheduled", "addToQueue", "draft"].includes(mode)) return json({ error: "Choose a valid schedule option." }, 400, origin);
      const scheduling = mode === "draft" ? ", saveToDraft: true" : mode === "addToQueue" ? ", mode: addToQueue" : mode === "customScheduled" ? `, mode: customScheduled, dueAt: ${escapeGraphQLString(dueAt!.toISOString())}` : "";
      const mutation = `mutation CreatorHQEditBufferPost { editPost(input: { id: ${escapeGraphQLString(id)}, text: ${escapeGraphQLString(text)}${scheduling} }) { ... on PostActionSuccess { post { id text dueAt status channelId channelService allowedActions error { message } externalLink sentAt assets { id type source thumbnail mimeType } } } ... on MutationError { message } } }`;
      const data = await bufferQuery(bufferKey, mutation);
      const post = data.editPost?.post;
      if (!post) return json({ error: data.editPost?.message || "Buffer did not update the scheduled post." }, 502, origin);
      return json({ post }, 200, origin);
    }

    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    const mode = payload.mode === "customScheduled" ? "customScheduled" : payload.mode === "draft" ? "draft" : "addToQueue";
    if (!targets.length || targets.length > 10) return json({ error: "Select between 1 and 10 Buffer channels." }, 400, origin);
    const channelIds = targets.map((target: { channelId?: unknown }) => typeof target?.channelId === "string" ? target.channelId : "");
    if (channelIds.some((id: string) => !id) || new Set(channelIds).size !== channelIds.length) return json({ error: "Each selected channel must be valid and unique." }, 400, origin);

    let dueAtValue = "";
    if (mode === "customScheduled") {
      const dueAt = typeof payload.dueAt === "string" ? new Date(payload.dueAt) : null;
      if (!dueAt || Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) return json({ error: "Choose a future schedule time." }, 400, origin);
      dueAtValue = dueAt.toISOString();
    }
    let organizationId = typeof payload.organizationId === "string" ? payload.organizationId : "";
    let channelData;
    if (!organizationId) {
      // Existing deployed clients did not send organizationId. Match their selected channels.
      const accountData = await bufferQuery(bufferKey, "query { account { organizations { id } } }");
      for (const organization of accountData.account?.organizations || []) {
        const candidate = await bufferQuery(bufferKey, `query { channels(input: { organizationId: ${escapeGraphQLString(organization.id)} }) { id service isDisconnected isLocked } }`);
        if (channelIds.every((id: string) => candidate.channels?.some((channel: { id: string }) => channel.id === id))) { organizationId = organization.id; channelData = candidate; break; }
      }
    }
    if (!organizationId) return json({ error: "Choose a Buffer organization." }, 400, origin);
    channelData ||= await bufferQuery(bufferKey, `query { channels(input: { organizationId: ${escapeGraphQLString(organizationId)} }) { id service isDisconnected isLocked } }`);
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
        const channel = (channelData.channels || []).find((item: { id: string }) => item.id === channelId);
        if (!channel || channel.isDisconnected || channel.isLocked) throw new Error("This channel needs attention in Buffer before publishing.");
        const service = channel.service;
        const type = ["post", "reel", "story"].includes(target.postType) ? target.postType : "post";
        let metadata = "";
        if (service === "instagram") {
          if (!assetType) throw new Error("Instagram requires an image or video.");
          metadata = `, metadata: { instagram: { type: ${type}, shouldShareToFeed: true } }`;
        } else if (service === "facebook") metadata = `, metadata: { facebook: { type: ${type} } }`;
        else if (service === "googlebusiness") metadata = ", metadata: { google: { type: whats_new } }";
        else if (service === "youtube") {
          if (assetType !== "video" || !target.videoTitle?.trim()) throw new Error("YouTube needs a video and a title.");
          const category = ["20", "22", "24", "27", "28"].includes(target.categoryId) ? target.categoryId : "20";
          metadata = `, metadata: { youtube: { title: ${escapeGraphQLString(target.videoTitle.trim().slice(0, 100))}, categoryId: ${escapeGraphQLString(category)}, privacy: public, madeForKids: ${target.madeForKids === true} } }`;
        } else if (service === "pinterest") {
          if (assetType !== "image" || !target.boardId?.trim()) throw new Error("Pinterest needs an image and board ID.");
          metadata = `, metadata: { pinterest: { boardServiceId: ${escapeGraphQLString(target.boardId.trim())} } }`;
        } else if (service === "tiktok" && !assetType) throw new Error("TikTok requires an image or video.");
        const scheduling = mode === "customScheduled" ? `mode: customScheduled, dueAt: ${escapeGraphQLString(dueAtValue)}` : mode === "draft" ? "saveToDraft: true, mode: addToQueue" : "mode: addToQueue";
        const assets = assetType ? `, assets: [{ ${assetType}: { url: ${escapeGraphQLString(assetUrl)} } }]` : "";
        const mutation = `mutation CreatorHQScheduleBufferPost { createPost(input: { text: ${escapeGraphQLString(text)}, channelId: ${escapeGraphQLString(channelId)}, schedulingType: automatic, ${scheduling}${assets}${metadata} }) { ... on PostActionSuccess { post { id text dueAt status channelId } } ... on MutationError { message } } }`;
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
