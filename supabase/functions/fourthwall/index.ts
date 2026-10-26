import { createClient } from "npm:@supabase/supabase-js@2";

const FOURTHWALL_API = "https://api.fourthwall.com/open-api/v1.0";
const MAX_BODY_BYTES = 15_000_000;
const MAX_ARTWORK_BYTES = 10_000_000;
const ALLOWED_ACTIONS = new Set(["workspace", "templates", "template", "createDesign", "availability", "visibility", "archive", "orders", "inventory", "fulfill"]);

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
    .split(",").map((value) => value.trim()).filter(Boolean);
}

async function fourthwallRequest(path: string, method = "GET", body?: unknown) {
  const username = Deno.env.get("FOURTHWALL_API_USERNAME") || "";
  const password = Deno.env.get("FOURTHWALL_API_PASSWORD") || "";
  if (!username || !password) throw new Error("Fourthwall API is not configured. Add FOURTHWALL_API_USERNAME and FOURTHWALL_API_PASSWORD as Supabase Function secrets.");
  const response = await fetch(`${FOURTHWALL_API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`${username}:${password}`)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof result.title === "string" ? result.title : typeof result.message === "string" ? result.message : `Fourthwall returned HTTP ${response.status}.`;
    throw new Error(detail.slice(0, 300));
  }
  return result;
}

function productId(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid Fourthwall product ID.");
  return value;
}

async function listProducts() {
  const [shop, firstPage] = await Promise.all([
    fourthwallRequest("/shops/current"),
    fourthwallRequest("/products?page=0&size=100")
  ]);
  const results = Array.isArray(firstPage?.results) ? [...firstPage.results] : [];
  const totalPages = Math.min(Number(firstPage?.totalPages) || 1, 20);
  for (let page = 1; page < totalPages; page++) {
    const result = await fourthwallRequest(`/products?page=${page}&size=100`);
    if (Array.isArray(result?.results)) results.push(...result.results);
  }
  return { shop, products: results };
}

async function listOrders(page: number, size: number) {
  const params = new URLSearchParams({ page: String(page), size: String(size) });
  return await fourthwallRequest(`/order?${params.toString()}`);
}

async function listProductInventory(id: string) {
  const results: unknown[] = [];
  let page = 0;
  let totalPages = 1;
  do {
    const params = new URLSearchParams({ page: String(page), size: "100" });
    const result = await fourthwallRequest(`/products/${encodeURIComponent(id)}/inventory?${params.toString()}`);
    if (Array.isArray(result?.results)) results.push(...result.results);
    totalPages = Math.min(Number(result?.totalPages) || 1, 20);
    page += 1;
  } while (page < totalPages);
  return { results };
}

async function createFulfillment(payload: Record<string, unknown>) {
  const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
  const trackingNumber = typeof payload.trackingNumber === "string" ? payload.trackingNumber.trim().slice(0, 200) : "";
  const trackingCompany = typeof payload.trackingCompany === "string" ? payload.trackingCompany.trim().slice(0, 100) : "";
  const sourceItems = Array.isArray(payload.items) ? payload.items : [];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) throw new Error("Invalid Fourthwall order ID.");
  if (!trackingNumber || !trackingCompany) throw new Error("Tracking number and carrier are required.");
  if (!sourceItems.length || sourceItems.length > 50) throw new Error("Select between 1 and 50 order items to ship.");
  const items = sourceItems.map((item) => {
    if (!item || typeof item !== "object" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(item.variantId || ""))) throw new Error("Invalid order variant ID.");
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new Error("Shipment quantities must be whole numbers between 1 and 1,000.");
    return { variantId: item.variantId, quantity };
  });
  return await fourthwallRequest("/fulfillments", "POST", {
    orderId,
    items,
    shippingLabel: { trackingNumber, trackingCompany }
  });
}

async function createDesignProduct(payload: Record<string, unknown>) {
  const name = typeof payload.name === "string" ? payload.name.trim().slice(0, 100) : "";
  const description = typeof payload.description === "string" ? payload.description.trim().slice(0, 2000) : "";
  const templateId = typeof payload.productTemplateId === "string" ? payload.productTemplateId : "";
  const region = typeof payload.region === "string" ? payload.region : "";
  const fileName = typeof payload.fileName === "string" ? payload.fileName.slice(0, 160) : "artwork.png";
  const contentType = typeof payload.contentType === "string" ? payload.contentType : "";
  const base64 = typeof payload.imageBase64 === "string" ? payload.imageBase64 : "";
  const width = Number(payload.width);
  const height = Number(payload.height);
  const profitMargin = Number(payload.profitMargin);
  const publishOnCreate = payload.publishOnCreate === true;
  if (!name || !templateId || !region || !base64) throw new Error("Product name, template, artwork, and print region are required.");
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(templateId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(region)) throw new Error("Invalid product template or print region.");
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw new Error("Upload a PNG, JPEG, or WebP artwork image.");
  if (!Number.isInteger(width) || width < 1 || width > 20_000 || !Number.isInteger(height) || height < 1 || height > 20_000) throw new Error("Invalid artwork dimensions.");
  if (base64.length > Math.ceil(MAX_ARTWORK_BYTES * 4 / 3) + 8) throw new Error("Artwork must be 10 MB or smaller.");

  let imageBytes: Uint8Array;
  try {
    const binary = atob(base64);
    if (binary.length > MAX_ARTWORK_BYTES) throw new Error("Artwork must be 10 MB or smaller.");
    imageBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    if (error instanceof Error && error.message.includes("10 MB")) throw error;
    throw new Error("Artwork upload was not valid base64 data.");
  }

  const upload = await fourthwallRequest("/media/upload-url", "POST", { fileName, contentType, size: imageBytes.byteLength });
  const uploadResponse = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "x-goog-content-length-range": `0,${imageBytes.byteLength}` },
    body: imageBytes,
    signal: AbortSignal.timeout(30_000)
  });
  if (!uploadResponse.ok) throw new Error(`Artwork upload failed (HTTP ${uploadResponse.status}).`);

  const image = await fourthwallRequest("/media/images", "POST", { fileUrl: upload.fileUrl, width, height });
  const body: Record<string, unknown> = {
    type: "design",
    productTemplateId: templateId,
    name,
    description,
    regions: [{ region, imageId: image.id, placementStrategy: "AUTO" }],
    publishOnCreate
  };
  if (Number.isFinite(profitMargin) && profitMargin >= 0) body.profitMargin = profitMargin;
  return await fourthwallRequest("/products", "POST", body);
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
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
      }
    });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
  if (!origins.includes(origin)) return json({ error: "This website origin is not allowed. Add it to ALLOWED_APP_ORIGINS." }, 403, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  const allowedUserId = Deno.env.get("FOURTHWALL_ALLOWED_USER_ID") || Deno.env.get("BUFFER_ALLOWED_USER_ID") || "";
  const accessToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!supabaseUrl || !supabaseKey || !allowedUserId) return json({ error: "Fourthwall connection is not configured. Set FOURTHWALL_ALLOWED_USER_ID and the Supabase function environment." }, 503, origin);
  if (!accessToken) return json({ error: "Sign in to Creator HQ to manage your Fourthwall shop." }, 401, origin);
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
  if (authError || !authData.user) return json({ error: "Your Creator HQ session expired. Sign in again." }, 401, origin);
  if (authData.user.id !== allowedUserId) return json({ error: "Fourthwall management is not enabled for this Creator HQ account." }, 403, origin);

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Request is too large. Artwork must be 10 MB or smaller." }, 413, origin);
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || !ALLOWED_ACTIONS.has(payload.action)) return json({ error: "Unknown Fourthwall action." }, 400, origin);

  try {
    if (payload.action === "workspace") return json(await listProducts(), 200, origin);
    if (payload.action === "orders") {
      const page = Math.max(0, Math.min(10_000, Math.floor(Number(payload.page) || 0)));
      const size = Math.max(1, Math.min(100, Math.floor(Number(payload.size) || 50)));
      return json(await listOrders(page, size), 200, origin);
    }
    if (payload.action === "inventory") {
      const id = productId(payload.productId);
      return json(await listProductInventory(id), 200, origin);
    }
    if (payload.action === "fulfill") return json(await createFulfillment(payload), 201, origin);
    if (payload.action === "templates") {
      const page = Math.max(1, Math.min(20, Number(payload.page) || 1));
      return json(await fourthwallRequest(`/product-templates/page/${page}`), 200, origin);
    }
    if (payload.action === "template") {
      const id = productId(payload.productTemplateId);
      return json(await fourthwallRequest(`/product-templates/${encodeURIComponent(id)}`), 200, origin);
    }
    if (payload.action === "createDesign") return json(await createDesignProduct(payload), 201, origin);
    if (payload.action === "availability") {
      const id = productId(payload.productId);
      if (typeof payload.available !== "boolean") return json({ error: "Availability must be true or false." }, 400, origin);
      return json(await fourthwallRequest(`/products/${encodeURIComponent(id)}/availability`, "PUT", { available: payload.available }), 200, origin);
    }
    if (payload.action === "visibility") {
      const id = productId(payload.productId);
      if (!['PUBLIC', 'HIDDEN'].includes(payload.state)) return json({ error: "Visibility must be PUBLIC or HIDDEN." }, 400, origin);
      return json(await fourthwallRequest(`/products/${encodeURIComponent(id)}/state`, "PUT", { state: payload.state }), 200, origin);
    }
    const id = productId(payload.productId);
    await fourthwallRequest(`/products/${encodeURIComponent(id)}`, "DELETE");
    return json({ archived: true, productId: id }, 200, origin);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Fourthwall request failed." }, 502, origin);
  }
});
