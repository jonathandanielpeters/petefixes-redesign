/**
 * Pete Fixes — Worker entry point
 *
 * Sits in front of static assets. For most routes the Worker is never
 * invoked (run_worker_first only targets /services/fence-admin* and /api/*).
 *
 * Routes:
 *  - /services/fence-admin*  → HTTP Basic Auth then serve static page
 *  - /api/book-installation  → Square payment + Google Calendar booking
 */

// ── Credentials ─────────────────────────────────────────────────────
// ADMIN_USER is set in wrangler.toml [vars]; ADMIN_PASS must be set as a
// Wrangler secret (`wrangler secret put ADMIN_PASS`). If the secret is
// missing, auth fails closed rather than falling back to a known default.
const DEFAULT_USER = "admin";

// ── Paths that require auth ─────────────────────────────────────────
const PROTECTED = [
  "/services/fence-admin",
  "/services/fence-quotes",
  "/services/fence-builder-admin",  // admin version of the Build & Price tool
];

function isProtected(pathname) {
  const clean = pathname.replace(/\.html$/, "").replace(/\/$/, "");
  return PROTECTED.some((p) => clean === p || clean.startsWith(p + "/"));
}

// ── Auth helper ─────────────────────────────────────────────────────
function unauthorized() {
  return new Response("401 — Login required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Pete Fixes Admin", charset="UTF-8"',
      "Content-Type": "text/plain",
    },
  });
}

function checkBasicAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;

  const expectedUser = env.ADMIN_USER || DEFAULT_USER;
  const expectedPass = env.ADMIN_PASS;
  // Fail closed if the secret isn't set — never allow auth with an empty pass.
  if (!expectedPass) return false;

  try {
    const decoded = atob(header.slice(6));
    const [user, ...passParts] = decoded.split(":");
    const pass = passParts.join(":"); // password may contain colons
    return user === expectedUser && pass === expectedPass;
  } catch {
    return false;
  }
}

// ── CORS helpers ────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ── Square API helpers ──────────────────────────────────────────────
function squareBaseUrl(env) {
  return env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

async function squareRequest(env, method, path, body) {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN not configured");

  const res = await fetch(`${squareBaseUrl(env)}${path}`, {
    method,
    headers: {
      "Square-Version": "2024-12-18",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    const errMsg =
      data.errors?.[0]?.detail || data.errors?.[0]?.code || "Square API error";
    throw new Error(errMsg);
  }
  return data;
}

// ── Book Installation handler ───────────────────────────────────────
async function handleBookInstallation(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return corsResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await request.json();
    const {
      sourceId, // Square payment token from Web Payments SDK
      firstName,
      lastName,
      email,
      phone,
      address,
      preferredDate, // ISO date string
      estimateTotal, // cents
      estimateSummary, // text summary
      notes, // special requests
      saveCard, // boolean — save card for future remaining balance
      depositAmount, // cents — defaults to 10000 ($100) if not provided
    } = body;

    // Validate required fields
    if (!sourceId) throw new Error("Payment token is required");
    if (!firstName || !lastName) throw new Error("Name is required");
    if (!email) throw new Error("Email is required");
    if (!phone) throw new Error("Phone is required");
    if (!address) throw new Error("Site address is required");
    if (!preferredDate) throw new Error("Preferred date is required");

    const fullName = `${firstName} ${lastName}`;
    const idempotencyKey = crypto.randomUUID();

    // 1. Create Square Customer
    const customerRes = await squareRequest(env, "POST", "/v2/customers", {
      idempotency_key: idempotencyKey + "-cust",
      given_name: firstName,
      family_name: lastName,
      email_address: email,
      phone_number: phone,
      address: { address_line_1: address },
      note: `Fence estimate: $${(estimateTotal / 100).toLocaleString()}. Deposit: $${((depositAmount || 10000) / 100).toFixed(2)}. ${notes || ""}`.trim(),
    });
    const customerId = customerRes.customer.id;

    // 2. Save card on file FIRST (nonce is single-use — must save before charging)
    let savedCardId = null;
    let paymentSourceId = sourceId; // default: pay with the nonce directly

    if (saveCard) {
      const cardRes = await squareRequest(env, "POST", "/v2/cards", {
        idempotency_key: idempotencyKey + "-card",
        source_id: sourceId,
        card: {
          customer_id: customerId,
          cardholder_name: fullName,
        },
      });
      savedCardId = cardRes.card.id;
      paymentSourceId = savedCardId; // charge the saved card instead of the consumed nonce
    }

    // 3. Charge the deposit (default $100, or 50% of estimate if chosen)
    const depAmountCents = depositAmount && depositAmount > 0 ? depositAmount : 10000;
    const depAmountDollars = (depAmountCents / 100).toFixed(2);

    const paymentRes = await squareRequest(env, "POST", "/v2/payments", {
      idempotency_key: idempotencyKey + "-pay",
      source_id: paymentSourceId,
      amount_money: {
        amount: depAmountCents,
        currency: "CAD",
      },
      autocomplete: true,
      customer_id: customerId,
      reference_id: `pf-deposit-${Date.now()}`,
      note: `Fence installation deposit ($${depAmountDollars}) — ${fullName} @ ${address}`,
    });
    const paymentId = paymentRes.payment.id;

    // 4. Build Google Calendar event link
    const startDate = preferredDate.replace(/-/g, "");
    const calTitle = encodeURIComponent(
      `Fence Installation — ${fullName}`
    );
    const calDetails = encodeURIComponent(
      `Customer: ${fullName}\nPhone: ${phone}\nEmail: ${email}\nAddress: ${address}\n\nEstimate: $${(estimateTotal / 100).toLocaleString()}\nDeposit Paid: $${depAmountDollars} (Square #${paymentId})\n${savedCardId ? "Card saved for remaining balance\n" : ""}${notes ? "\nNotes: " + notes : ""}`
    );
    const calLocation = encodeURIComponent(address);
    const googleCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${calTitle}&dates=${startDate}/${startDate}&details=${calDetails}&location=${calLocation}`;

    // 5. Send confirmation emails (fire-and-forget via the existing email infrastructure)
    // We'll return the calendar URL to the client for now — email can be triggered client-side

    return corsResponse({
      ok: true,
      paymentId,
      customerId,
      savedCardId,
      cardSaved: !!savedCardId,
      googleCalendarUrl: googleCalUrl,
      depositAmount: depAmountCents,
      message: `Deposit of $${depAmountDollars} processed successfully!`,
    });
  } catch (err) {
    console.error("[BOOKING]", err.message);
    return corsResponse(
      { ok: false, error: err.message || "Booking failed" },
      400
    );
  }
}

// ── Worker entry point ──────────────────────────────────────────────
// ── Distance Matrix handler (proxies Google Maps API, bypasses CORS) ──
async function handleDistance(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return corsResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const url = new URL(request.url);
    const origin = url.searchParams.get("origin");
    const destination = url.searchParams.get("destination");
    if (!origin || !destination) {
      return corsResponse({ ok: false, error: "Both 'origin' and 'destination' query params required" }, 400);
    }

    // Google Maps API key — same one used for Map Tiles on fence-build-price.
    // Must have Distance Matrix API enabled in Google Cloud Console.
    const apiKey = env.GOOGLE_MAPS_API_KEY || "AIzaSyBE17zClisJ1P4AYoBgyepsAA2SA3g2QNo";
    const gUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&mode=driving&units=metric&key=${apiKey}`;

    const gRes = await fetch(gUrl);
    const gData = await gRes.json();
    if (gData.status !== "OK") {
      return corsResponse({ ok: false, error: "Google API: " + gData.status + (gData.error_message ? " — " + gData.error_message : "") }, 502);
    }
    const row = gData.rows && gData.rows[0];
    const el = row && row.elements && row.elements[0];
    if (!el || el.status !== "OK") {
      return corsResponse({ ok: false, error: "Google API element: " + (el ? el.status : "no element") }, 404);
    }

    return corsResponse({
      ok: true,
      minutes: Math.ceil(el.duration.value / 60),
      km: +(el.distance.value / 1000).toFixed(1),
      durationText: el.duration.text,
      distanceText: el.distance.text,
      originResolved: gData.origin_addresses && gData.origin_addresses[0],
      destinationResolved: gData.destination_addresses && gData.destination_addresses[0],
    });
  } catch (err) {
    return corsResponse({ ok: false, error: err.message || "Distance lookup failed" }, 500);
  }
}

// ── Geocode handler ────────────────────────────────────────────────
// Proxies Google's Geocoding API — same key as /api/distance.  Returns a
// list of address candidates with formatted address, lat/lng, and the
// broken-down address components (so the client can always show the house
// number prominently).  We fall back to the free Nominatim service if
// Google fails (zero results, missing key, billing not enabled, etc.) so
// the address bar never goes completely dead.
async function handleGeocode(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return corsResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return corsResponse({ ok: false, error: "Query 'q' required" }, 400);

    const apiKey = env.GOOGLE_MAPS_API_KEY || "AIzaSyBE17zClisJ1P4AYoBgyepsAA2SA3g2QNo";

    // ── Try Google first ──
    let results = [];
    try {
      // region=ca biases ambiguous results toward Canada; components also restricts
      // to Canada+US (matches the prior nominatim countrycodes=ca,us behaviour).
      const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=ca&components=country:CA|country:US&key=${apiKey}`;
      const gRes = await fetch(gUrl);
      const gData = await gRes.json();
      if (gData.status === "OK" && Array.isArray(gData.results)) {
        results = gData.results.map(r => {
          const c = (type) => {
            const comp = r.address_components.find(c => c.types.includes(type));
            return comp ? comp.long_name : "";
          };
          const houseNumber = c("street_number");
          const street = c("route");
          const city = c("locality") || c("postal_town") || c("administrative_area_level_2");
          const region = c("administrative_area_level_1");
          const country = c("country");
          const postcode = c("postal_code");
          // Build a "primary" line that ALWAYS leads with the house number when present
          const primary = [houseNumber, street].filter(Boolean).join(" ") || (r.formatted_address.split(",")[0] || "").trim();
          const secondary = [city, region, postcode, country].filter(Boolean).join(", ");
          return {
            lat: r.geometry.location.lat,
            lng: r.geometry.location.lng,
            formatted: r.formatted_address,
            houseNumber, street, city, region, postcode, country,
            primary, secondary,
            placeId: r.place_id,
            source: "google"
          };
        });
      }
    } catch (e) { /* fall through to Nominatim */ }

    // ── Nominatim fallback ──
    if (!results.length) {
      try {
        const nUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=5&countrycodes=ca,us`;
        const nRes = await fetch(nUrl, { headers: { "User-Agent": "PeteFixes/1.0 (+https://www.petefixes.ca)", "Accept-Language": "en" } });
        const nData = await nRes.json();
        if (Array.isArray(nData)) {
          results = nData.map(item => {
            const a = item.address || {};
            const houseNumber = a.house_number || "";
            const street = a.road || a.pedestrian || a.footway || "";
            const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || "";
            const region = a.state || a.province || a.state_district || "";
            const country = a.country || (a.country_code ? a.country_code.toUpperCase() : "");
            const postcode = a.postcode || "";
            const primary = [houseNumber, street].filter(Boolean).join(" ") || (item.display_name.split(",")[0] || "").trim();
            const secondary = [city, region, postcode, country].filter(Boolean).join(", ");
            return {
              lat: parseFloat(item.lat),
              lng: parseFloat(item.lon),
              formatted: item.display_name,
              houseNumber, street, city, region, postcode, country,
              primary, secondary,
              source: "nominatim"
            };
          });
        }
      } catch (e) { /* both failed */ }
    }

    return corsResponse({ ok: true, results });
  } catch (err) {
    return corsResponse({ ok: false, error: err.message || "Geocode failed" }, 500);
  }
}

// ── /api/config — Cloud-stored admin config ─────────────────────────
// GET: any visitor (customer Build & Price + admin) reads the latest config
// PUT: auth-protected (same Basic Auth as the admin page) — saves a new config
// Storage: Cloudflare KV namespace bound as CONFIG_KV. One key per deployment.
//   "config:default"        — the canonical config served by GET when no id
//   "config:<deploymentId>" — alternate configs (e.g. "pete-fixes-wpg")
async function handleConfig(request, env) {
  if (!env.CONFIG_KV) {
    return corsResponse({ ok: false, error: "CONFIG_KV not bound" }, 500);
  }
  const url = new URL(request.url);
  const deployId = (url.searchParams.get("id") || "default").replace(/[^a-z0-9-]/gi, "");
  const key = "config:" + deployId;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (request.method === "GET") {
    const value = await env.CONFIG_KV.get(key);
    if (!value) {
      return corsResponse({ ok: false, error: "not_found", id: deployId }, 404);
    }
    // Return the raw config JSON for the client. Cache-busted by the client
    // via ?v=<timestamp> so we set a short TTL to allow propagation.
    return new Response(value, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=10",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (request.method === "PUT") {
    if (!checkBasicAuth(request, env)) {
      return unauthorized();
    }
    let body;
    try {
      body = await request.text();
      // Parse to validate it's well-formed JSON; sniff size up front
      if (body.length > 5 * 1024 * 1024) {
        return corsResponse({ ok: false, error: "config too large (>5MB)" }, 413);
      }
      JSON.parse(body);
    } catch (e) {
      return corsResponse({ ok: false, error: "invalid JSON: " + (e.message || "parse failed") }, 400);
    }
    await env.CONFIG_KV.put(key, body);
    return corsResponse({ ok: true, id: deployId, savedAt: new Date().toISOString(), size: body.length });
  }

  return corsResponse({ ok: false, error: "method not allowed" }, 405);
}

// ── /api/quotes — Submitted estimate dashboard ──────────────────────
// POST   /api/quotes        : open (any visitor) — saves a submitted estimate
// GET    /api/quotes        : auth — lists all saved quotes (newest first)
// GET    /api/quotes/:id    : auth — fetches one quote with full payload
// DELETE /api/quotes/:id    : auth — deletes a quote
//
// Storage: same KV namespace as admin config, prefix "quote:".  KV's
// list({prefix}) is enough to drive the dashboard list view; for richer
// queries we'd graduate to D1 but KV keeps the deploy story simple.
function makeQuoteId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return "q_" + ts + "_" + rand;
}

async function handleQuotes(request, env, idFromPath) {
  if (!env.CONFIG_KV) {
    return corsResponse({ ok: false, error: "CONFIG_KV not bound" }, 500);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // POST /api/quotes — anyone (the customer Build & Price submits here)
  if (request.method === "POST" && !idFromPath) {
    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse({ ok: false, error: "invalid JSON" }, 400);
    }
    const id = makeQuoteId();
    const record = {
      id,
      createdAt: new Date().toISOString(),
      status: "new",
      // Customer-submitted info — flat for easy listing
      customer: body.customer || {},
      // Estimate details — total, title, breakdown summary, fence stats
      estimate: body.estimate || {},
      // Drawing payload — base64 serialized state, restorable via
      // /services/fence-build-price.html?config=<this>
      drawing: body.drawing || "",
      // Optional: inline preview image so the dashboard doesn't have to
      // re-render every drawing. ~50–100 KB per quote.
      drawingPng: body.drawingPng || null,
      // Where the quote was submitted from (deployment) — useful when
      // the same KV is shared across sites or environments.
      deploymentId: body.deploymentId || "default",
      // Source URL the customer submitted from
      sourceUrl: body.sourceUrl || "",
    };
    // Total payload guard — KV's per-value limit is 25 MB but a single
    // dashboard list call would be slow if quotes balloon. Reject big.
    const json = JSON.stringify(record);
    if (json.length > 5 * 1024 * 1024) {
      return corsResponse({ ok: false, error: "quote payload too large (>5MB)" }, 413);
    }
    await env.CONFIG_KV.put("quote:" + id, json, {
      // Index metadata so list() can render a useful summary without
      // having to fetch each quote's full body.
      metadata: {
        createdAt: record.createdAt,
        customerName: ((record.customer.firstName || "") + " " + (record.customer.lastName || "")).trim(),
        customerEmail: record.customer.email || "",
        customerPhone: record.customer.phone || "",
        address: record.customer.address || "",
        total: record.estimate.total || 0,
        title: record.estimate.title || "",
        status: record.status,
        deploymentId: record.deploymentId,
      },
    });
    return corsResponse({ ok: true, id, createdAt: record.createdAt });
  }

  // Auth required for every other operation.
  if (!checkBasicAuth(request, env)) return unauthorized();

  // GET /api/quotes — list all (newest first), summary only
  if (request.method === "GET" && !idFromPath) {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 1000);
    const list = await env.CONFIG_KV.list({ prefix: "quote:", limit });
    const rows = list.keys
      .map(k => ({ id: k.name.replace(/^quote:/, ""), ...(k.metadata || {}) }))
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return corsResponse({ ok: true, quotes: rows, complete: list.list_complete });
  }

  // GET /api/quotes/:id — full payload for the dashboard's view-modal
  if (request.method === "GET" && idFromPath) {
    const value = await env.CONFIG_KV.get("quote:" + idFromPath);
    if (!value) return corsResponse({ ok: false, error: "not_found" }, 404);
    return new Response(value, {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  // DELETE /api/quotes/:id
  if (request.method === "DELETE" && idFromPath) {
    await env.CONFIG_KV.delete("quote:" + idFromPath);
    return corsResponse({ ok: true, id: idFromPath });
  }

  // PUT /api/quotes/:id — admin-only edit (custom parts + labour, status,
  // notes). Merges into the existing record so we don't have to round-trip
  // every field on every save.
  if (request.method === "PUT" && idFromPath) {
    const existing = await env.CONFIG_KV.get("quote:" + idFromPath);
    if (!existing) return corsResponse({ ok: false, error: "not_found" }, 404);
    let patch;
    try { patch = await request.json(); }
    catch { return corsResponse({ ok: false, error: "invalid JSON" }, 400); }
    let record;
    try { record = JSON.parse(existing); }
    catch { return corsResponse({ ok: false, error: "stored record corrupt" }, 500); }
    // Whitelisted top-level patch fields. Don't let admins overwrite
    // immutable provenance (id, createdAt, source).
    const allowed = ["status", "adminNotes", "adminExtras", "drawing", "drawingPng", "estimate", "customer"];
    Object.keys(patch).forEach(k => {
      if (allowed.indexOf(k) !== -1) record[k] = patch[k];
    });
    record.updatedAt = new Date().toISOString();
    record.updatedBy = "admin";
    const json = JSON.stringify(record);
    if (json.length > 5 * 1024 * 1024) {
      return corsResponse({ ok: false, error: "quote payload too large (>5MB)" }, 413);
    }
    await env.CONFIG_KV.put("quote:" + idFromPath, json, {
      metadata: {
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        customerName: ((record.customer && (record.customer.firstName || "")) + " " + (record.customer && (record.customer.lastName || ""))).trim(),
        customerEmail: (record.customer && record.customer.email) || "",
        customerPhone: (record.customer && record.customer.phone) || "",
        address: (record.customer && record.customer.address) || "",
        total: (record.estimate && record.estimate.total) || 0,
        title: (record.estimate && record.estimate.title) || "",
        status: record.status || "new",
        deploymentId: record.deploymentId || "default",
      },
    });
    return corsResponse({ ok: true, id: idFromPath, updatedAt: record.updatedAt });
  }

  return corsResponse({ ok: false, error: "method not allowed" }, 405);
}

// ── /api/scan-price — pull a product page and extract its price ─────
// Admin-side scraper for the lumber price chart.  Given a product URL,
// fetch the page server-side (browsers can't cross-origin) and try a
// chain of extractors:
//   1. JSON-LD: <script type="application/ld+json"> with @type Product
//      and offers.price (most reliable on modern e-commerce sites)
//   2. Microdata: <meta itemprop="price">
//   3. Open Graph product tags: <meta property="product:price:amount">
//   4. Twitter price meta (some retailers use it as a fallback)
//   5. Regex over $XX.XX patterns near "price" / "Sale" keywords
// Returns { ok, price, currency, productName, source, fetchedAt } or
// { ok:false, error }.  Auth-protected so the endpoint can't be used as
// a free open scraper.
async function handleScanPrice(request, env) {
  if (!checkBasicAuth(request, env)) return unauthorized();
  const url = new URL(request.url);
  const target = url.searchParams.get("url") || "";
  if (!/^https?:\/\//i.test(target)) {
    return corsResponse({ ok: false, error: "url must start with http:// or https://" }, 400);
  }
  let html = "";
  try {
    const res = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-CA,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      return corsResponse({ ok: false, error: "upstream HTTP " + res.status, status: res.status }, 200);
    }
    html = await res.text();
  } catch (e) {
    return corsResponse({ ok: false, error: "fetch failed: " + (e.message || e) }, 200);
  }

  let price = null;
  let currency = null;
  let productName = null;
  let source = null;

  // 1. JSON-LD
  const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while (!price && (m = ldRegex.exec(html)) !== null) {
    try {
      const json = JSON.parse(m[1].trim());
      const candidates = Array.isArray(json) ? json : (json["@graph"] ? json["@graph"] : [json]);
      for (const node of candidates) {
        if (!node || typeof node !== "object") continue;
        const type = node["@type"];
        const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
        if (!isProduct) continue;
        productName = productName || node.name || null;
        const offers = node.offers;
        const offerList = Array.isArray(offers) ? offers : (offers ? [offers] : []);
        for (const off of offerList) {
          if (!off) continue;
          const p = off.price ?? off.lowPrice ?? off.priceSpecification?.price;
          if (p != null) {
            price = Number(String(p).replace(/[^0-9.]/g, ""));
            currency = off.priceCurrency || off.priceSpecification?.priceCurrency || currency;
            source = "json-ld";
            break;
          }
        }
        if (price != null) break;
      }
    } catch { /* keep scanning */ }
  }

  // 2. Microdata
  if (price == null) {
    const meta = html.match(/<meta[^>]+itemprop=["']price["'][^>]+content=["']([\d.]+)["']/i)
              || html.match(/<meta[^>]+content=["']([\d.]+)["'][^>]+itemprop=["']price["']/i);
    if (meta) {
      price = Number(meta[1]);
      source = "microdata";
      const cur = html.match(/<meta[^>]+itemprop=["']priceCurrency["'][^>]+content=["']([^"']+)["']/i);
      if (cur) currency = cur[1];
    }
  }

  // 3. Open Graph product tags
  if (price == null) {
    const og = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/i)
            || html.match(/<meta[^>]+content=["']([\d.]+)["'][^>]+property=["']product:price:amount["']/i);
    if (og) {
      price = Number(og[1]);
      source = "open-graph";
      const cur = html.match(/<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["']/i);
      if (cur) currency = cur[1];
    }
  }

  // 4. Twitter price meta
  if (price == null) {
    const tw = html.match(/<meta[^>]+name=["']twitter:data1["'][^>]+content=["']\$?([\d,.]+)["']/i);
    if (tw) {
      price = Number(tw[1].replace(/,/g, ""));
      source = "twitter";
    }
  }

  // 5. Regex fallback — look for a "Sale" / "price" anchor with a $XX.XX
  if (price == null) {
    const m1 = html.match(/(?:price|sale)[^<>$]{0,40}\$\s?([\d,]+\.\d{2})/i)
            || html.match(/data-price=["']\$?([\d,]+\.\d{2})["']/i)
            || html.match(/\$\s?([\d,]+\.\d{2})/);
    if (m1) {
      price = Number(m1[1].replace(/,/g, ""));
      source = "regex";
    }
  }

  // Product name fallback — <title> or <h1>
  if (!productName) {
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (title) productName = title[1].trim().slice(0, 160);
  }

  if (price == null || !isFinite(price) || price <= 0) {
    return corsResponse({ ok: false, error: "couldn't extract a price from this page", productName, fetchedAt: new Date().toISOString() }, 200);
  }
  return corsResponse({ ok: true, price, currency: currency || "CAD", productName: productName || null, source, fetchedAt: new Date().toISOString() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname === "/api/book-installation") {
      return handleBookInstallation(request, env);
    }
    if (url.pathname === "/api/distance") {
      return handleDistance(request, env);
    }
    if (url.pathname === "/api/geocode") {
      return handleGeocode(request, env);
    }
    if (url.pathname === "/api/config") {
      return handleConfig(request, env);
    }
    if (url.pathname === "/api/scan-price") {
      return handleScanPrice(request, env);
    }
    // Quotes dashboard — exact "/api/quotes" or "/api/quotes/<id>"
    if (url.pathname === "/api/quotes") {
      return handleQuotes(request, env, null);
    }
    const quoteIdMatch = url.pathname.match(/^\/api\/quotes\/([a-z0-9_-]+)$/i);
    if (quoteIdMatch) {
      return handleQuotes(request, env, quoteIdMatch[1]);
    }

    // Only enforce auth on protected paths
    if (isProtected(url.pathname)) {
      if (!checkBasicAuth(request, env)) {
        return unauthorized();
      }
    }

    // Serve the static asset
    return env.ASSETS.fetch(request);
  },
};
