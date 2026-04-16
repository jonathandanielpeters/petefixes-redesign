/**
 * Pete Fixes — Worker entry point
 *
 * Sits in front of static assets. For most routes the Worker is never
 * invoked (run_worker_first only targets /services/fence-admin*).
 *
 * When it IS invoked it checks HTTP Basic Auth before serving the
 * protected page via the ASSETS binding.
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

// ── Worker entry point ──────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
