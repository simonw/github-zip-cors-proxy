// CORS proxy for GitHub source zips.
//
//   GET /{owner}/{repo}/{ref}
//     -> https://codeload.github.com/{owner}/{repo}/zip/{ref}
//
// {ref} is a branch, a tag or a commit SHA, and may contain slashes.
//
// Only requests from allowed browser origins are served, and only for
// repositories belonging to ALLOWED_OWNER (set in wrangler.toml).

const PRODUCTION_ORIGINS = new Set(["https://lite.datasette.io"]);
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const PATH = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._\/-]{1,200})$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

// A branch, tag or SHA: slash-separated parts, none empty and none starting
// with a dot (which also rules out "." and ".." path segments).
export function isValidRef(ref) {
  return ref.split("/").every((part) => part !== "" && !part.startsWith("."));
}

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  return PRODUCTION_ORIGINS.has(origin) || LOCALHOST.test(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    Vary: "Origin",
  };
}

function text(message, status, extraHeaders = {}) {
  return new Response(message + "\n", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...extraHeaders },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (!isAllowedOrigin(origin)) {
      return text("Forbidden: origin not allowed", 403, { Vary: "Origin" });
    }
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...cors, "Access-Control-Max-Age": "86400" },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text("Method not allowed", 405, { ...cors, Allow: "GET, HEAD, OPTIONS" });
    }

    const match = new URL(request.url).pathname.match(PATH);
    if (!match || !isValidRef(match[3])) {
      return text("Expected /{owner}/{repo}/{branch, tag or commit sha}", 400, cors);
    }
    const [, owner, repo, ref] = match;

    const allowedOwner = (env && env.ALLOWED_OWNER) || "simonw";
    if (owner.toLowerCase() !== allowedOwner.toLowerCase()) {
      return text("Forbidden: owner not allowed", 403, cors);
    }

    const upstream = await fetch(
      `https://codeload.github.com/${owner}/${repo}/zip/${ref}`,
      { method: request.method, headers: { "User-Agent": "github-zip-cors-proxy" } }
    );

    if (!upstream.ok) {
      if (upstream.body) await upstream.body.cancel();
      const status = upstream.status === 404 ? 404 : 502;
      return text(`GitHub returned ${upstream.status}`, status, cors);
    }

    const headers = new Headers(cors);
    headers.set("Content-Type", "application/zip");
    // A full SHA always names the same content, so cache it forever. A branch
    // or tag can move, so cache those only briefly.
    headers.set(
      "Cache-Control",
      FULL_SHA.test(ref)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60"
    );
    const length = upstream.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);
    const etag = upstream.headers.get("ETag");
    if (etag) headers.set("ETag", etag);

    return new Response(upstream.body, { status: 200, headers });
  },
};
