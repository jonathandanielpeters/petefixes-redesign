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
const PROTECTED = ["/services/fence-admin"];

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
