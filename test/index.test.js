// Run with: node --test test/index.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { isAllowedOrigin, isAllowedOwner, isValidRef } from "../src/index.js";

const SHA = "be0ce3e85f3b7d8e811ab01db4f0dc304f09b025";
const ENV = { ALLOWED_OWNERS: "simonw, datasette" };
const GOOD = "https://lite.datasette.io";

let upstreamCalls = [];
function mockUpstream(status = 200) {
  upstreamCalls = [];
  globalThis.fetch = async (url) => {
    upstreamCalls.push(url);
    return new Response(status === 200 ? "zipbytes" : "nope", {
      status,
      headers: { ETag: '"abc"' },
    });
  };
}

function get(path, origin, method = "GET") {
  const headers = origin ? { Origin: origin } : {};
  return worker.fetch(new Request("https://proxy.example" + path, { method, headers }), ENV);
}

test("origin matching", () => {
  for (const ok of [
    GOOD,
    "http://localhost",
    "http://localhost:8000",
    "http://localhost:65535",
    "http://127.0.0.1:5173",
  ]) assert.equal(isAllowedOrigin(ok), true, ok);
  for (const bad of [
    null,
    "",
    "null",
    "http://lite.datasette.io",
    "https://lite.datasette.io.evil.com",
    "https://evil.com",
    "http://localhost.evil.com",
    "http://localhost:8000.evil.com",
    "http://localhost:8000/path",
    "https://localhost:8000",
    "http://evil.com/http://localhost:8000",
  ]) assert.equal(isAllowedOrigin(bad), false, String(bad));
});

test("allowed origin gets the zip with CORS headers", async () => {
  mockUpstream();
  const r = await get(`/simonw/datasette/${SHA}`, GOOD);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), GOOD);
  assert.equal(r.headers.get("Vary"), "Origin");
  assert.equal(r.headers.get("Content-Type"), "application/zip");
  assert.match(r.headers.get("Cache-Control"), /immutable/);
  assert.equal(await r.text(), "zipbytes");
  assert.deepEqual(upstreamCalls, [
    `https://codeload.github.com/simonw/datasette/zip/${SHA}`,
  ]);
});

test("localhost on any port is echoed back", async () => {
  mockUpstream();
  const r = await get(`/simonw/datasette/${SHA}`, "http://localhost:9999");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "http://localhost:9999");
});

test("bad or missing origin is refused without calling GitHub", async () => {
  mockUpstream();
  for (const origin of [undefined, "https://example.com"]) {
    const r = await get(`/simonw/datasette/${SHA}`, origin);
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(upstreamCalls.length, 0);
});

test("branches and tags are proxied with a short cache", async () => {
  for (const ref of ["main", "1.0a19", "0.65.x", "refs/heads/main", "feature/thing", SHA.slice(0, 7)]) {
    mockUpstream();
    const r = await get(`/simonw/datasette/${ref}`, GOOD);
    assert.equal(r.status, 200, ref);
    assert.equal(r.headers.get("Cache-Control"), "public, max-age=60", ref);
    assert.deepEqual(upstreamCalls, [
      `https://codeload.github.com/simonw/datasette/zip/${ref}`,
    ]);
  }
});

test("ref validation", () => {
  for (const ok of ["main", "1.0a19", "a/b/c", "refs/tags/1.0"]) assert.equal(isValidRef(ok), true, ok);
  for (const bad of ["", "a//b", "a/", "/a", "..", "a/../b", ".hidden", "a/.b"]) assert.equal(isValidRef(bad), false, bad);
});

test("other owners and bad paths are refused without calling GitHub", async () => {
  mockUpstream();
  assert.equal((await get(`/python/cpython/${SHA}`, GOOD)).status, 403);
  assert.equal((await get(`/simonw/datasette`, GOOD)).status, 400);
  assert.equal((await get(`/simonw/datasette/`, GOOD)).status, 400);
  assert.equal((await get(`/simonw/datasette/a//b`, GOOD)).status, 400);
  assert.equal((await get(`/simonw/datasette/main/`, GOOD)).status, 400);
  assert.equal((await get(`/simonw/datasette/.git`, GOOD)).status, 400);
  assert.equal((await get(`/simonw/datasette/a%20b`, GOOD)).status, 400);
  assert.equal((await get(`/simonw/datasette/${"a".repeat(201)}`, GOOD)).status, 400);
  assert.equal((await get(`/`, GOOD)).status, 400);
  assert.equal(upstreamCalls.length, 0);
});

test("owner check is case-insensitive", async () => {
  mockUpstream();
  assert.equal((await get(`/SimonW/datasette/${SHA}`, GOOD)).status, 200);
  assert.equal((await get(`/Datasette/datasette-arrows/${SHA}`, GOOD)).status, 200);
});

test("multiple allowed owners", async () => {
  mockUpstream();
  assert.equal((await get(`/datasette/datasette-arrows/main`, GOOD)).status, 200);
  assert.equal(upstreamCalls[0], "https://codeload.github.com/datasette/datasette-arrows/zip/main");
  assert.equal((await get(`/evil/datasette/main`, GOOD)).status, 403);
  assert.equal(isAllowedOwner("datasette", "simonw,datasette"), true);
  assert.equal(isAllowedOwner("datasett", "simonw,datasette"), false);
  assert.equal(isAllowedOwner("simonw,datasette", "simonw,datasette"), false);
  assert.equal(isAllowedOwner("", "simonw,"), false);
  // Defaults to simonw and datasette when unset
  assert.equal(isAllowedOwner("datasette"), true);
});

test("methods", async () => {
  mockUpstream();
  const pre = await get(`/simonw/datasette/${SHA}`, GOOD, "OPTIONS");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), GOOD);
  assert.equal((await get(`/simonw/datasette/${SHA}`, GOOD, "POST")).status, 405);
  assert.equal(upstreamCalls.length, 0);
});

test("upstream errors are mapped and not cached", async () => {
  mockUpstream(404);
  const missing = await get(`/simonw/datasette/${SHA}`, GOOD);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("Cache-Control"), null);
  assert.equal(missing.headers.get("Access-Control-Allow-Origin"), GOOD);
  mockUpstream(500);
  assert.equal((await get(`/simonw/datasette/${SHA}`, GOOD)).status, 502);
});
