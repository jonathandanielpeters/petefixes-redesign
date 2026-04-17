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

// ── Credentials (wrangler.toml [vars] overrides these defaults) ─────
const DEFAULT_USER = "admin";
const DEFAULT_PASS = "changethings2";

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
  const expectedPass = env.ADMIN_PASS || DEFAULT_PASS;

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
      saveCard, // boolean — save card for future second deposit
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
      note: `Fence estimate: $${(estimateTotal / 100).toLocaleString()}. ${notes || ""}`.trim(),
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

    // 3. Charge the $100 deposit
    const paymentRes = await squareRequest(env, "POST", "/v2/payments", {
      idempotency_key: idempotencyKey + "-pay",
      source_id: paymentSourceId,
      amount_money: {
        amount: 10000, // $100.00 in cents
        currency: "CAD",
      },
      autocomplete: true,
      customer_id: customerId,
      reference_id: `pf-deposit-${Date.now()}`,
      note: `Fence installation deposit — ${fullName} @ ${address}`,
    });
    const paymentId = paymentRes.payment.id;

    // 4. Build Google Calendar event link
    const startDate = preferredDate.replace(/-/g, "");
    const calTitle = encodeURIComponent(
      `Fence Installation — ${fullName}`
    );
    const calDetails = encodeURIComponent(
      `Customer: ${fullName}\nPhone: ${phone}\nEmail: ${email}\nAddress: ${address}\n\nEstimate: $${(estimateTotal / 100).toLocaleString()}\nDeposit Paid: $100.00 (Square #${paymentId})\n${savedCardId ? "Card saved for 2nd deposit\n" : ""}${notes ? "\nNotes: " + notes : ""}`
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
      message: "Deposit of $100 processed successfully!",
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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname === "/api/book-installation") {
      return handleBookInstallation(request, env);
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
