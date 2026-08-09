// Loopback surface contract tests.
//
// These run against a real listening server so the security controls are proven
// over actual HTTP rather than by reading the handler code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { createLoopbackServer } from "../../extensions/loop-execution-visualizer/src/server.mjs";

function nonce(seed) {
  return `nonce-${seed}-${"0".repeat(16)}`;
}

async function withServer(run, options = {}) {
  const uiDir = mkdtempSync(join(tmpdir(), "loopviz-ui-"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>ui</title>");
  mkdirSync(join(uiDir, "nested"));
  writeFileSync(join(uiDir, "nested", "deep.css"), "body{}");
  const secret = mkdtempSync(join(tmpdir(), "loopviz-secret-"));
  writeFileSync(join(secret, "outside.txt"), "must not be served");

  const calls = [];
  const server = createLoopbackServer({
    uiDir,
    handlers: {
      ping(input) {
        calls.push(input);
        return { ok: true, echo: input };
      },
      boom() {
        throw new Error("handler exploded");
      },
    },
    ...options,
  });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ server, base, port, calls, uiDir, secret });
  } finally {
    await server.stop();
    rmSync(uiDir, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true });
  }
}

const sameOrigin = (port, extra = {}) => ({
  "content-type": "application/json",
  "x-loopviz-csrf": "1",
  "sec-fetch-site": "same-origin",
  origin: `http://127.0.0.1:${port}`,
  ...extra,
});

test("loopback: a bootstrap token is single use and yields an instance credential", async () => {
  await withServer(async ({ server, base, port }) => {
    const token = server.issueBootstrap();

    const first = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: sameOrigin(port),
      body: JSON.stringify({ bootstrap: token }),
    });
    assert.equal(first.status, 200);
    const payload = await first.json();
    assert.match(payload.credential, /^[A-Za-z0-9_-]{20,}$/);
    assert.ok(payload.expiresInMs > 0);

    const replay = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: sameOrigin(port),
      body: JSON.stringify({ bootstrap: token }),
    });
    assert.equal(replay.status, 403);
    assert.match((await replay.json()).error, /already redeemed/);

    const forged = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: sameOrigin(port),
      body: JSON.stringify({ bootstrap: "lvz-not-a-real-token" }),
    });
    assert.equal(forged.status, 403);
  });
});

test("loopback: a bootstrap token expires and cannot be exchanged afterwards", async () => {
  let clock = 1_000_000;
  await withServer(async ({ server, base, port }) => {
    const token = server.issueBootstrap();
    clock += 31_000;
    const response = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: sameOrigin(port),
      body: JSON.stringify({ bootstrap: token }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /expired|unknown/);
  }, { now: () => clock, bootstrapTtlMs: 30_000 });
});

test("loopback: api calls require the credential, a fresh nonce and same-origin proof", async () => {
  await withServer(async ({ server, base, port, calls }) => {
    const token = server.issueBootstrap();
    const { credential } = await (await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: sameOrigin(port),
      body: JSON.stringify({ bootstrap: token }),
    })).json();

    const anonymous = await fetch(`${base}/api/ping`, {
      method: "POST",
      headers: sameOrigin(port, { "x-loopviz-nonce": nonce("a") }),
      body: "{}",
    });
    assert.equal(anonymous.status, 401);

    const authed = sameOrigin(port, { "x-loopviz-credential": credential });

    const noNonce = await fetch(`${base}/api/ping`, { method: "POST", headers: authed, body: "{}" });
    assert.equal(noNonce.status, 400);

    const ok = await fetch(`${base}/api/ping`, {
      method: "POST",
      headers: { ...authed, "x-loopviz-nonce": nonce("b") },
      body: JSON.stringify({ value: 7 }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, echo: { value: 7 } });
    assert.deepEqual(calls, [{ value: 7 }]);

    // The exact same request replayed is refused even though it is valid.
    const replayed = await fetch(`${base}/api/ping`, {
      method: "POST",
      headers: { ...authed, "x-loopviz-nonce": nonce("b") },
      body: JSON.stringify({ value: 7 }),
    });
    assert.equal(replayed.status, 409);
    assert.equal(calls.length, 1, "a replayed request must never reach the handler");

    const crossSite = await fetch(`${base}/api/ping`, {
      method: "POST",
      headers: { ...authed, "sec-fetch-site": "cross-site", "x-loopviz-nonce": nonce("c") },
      body: "{}",
    });
    assert.equal(crossSite.status, 403);

    const foreignOrigin = await fetch(`${base}/api/ping`, {
      method: "POST",
      headers: { ...authed, origin: "http://evil.example", "x-loopviz-nonce": nonce("d") },
      body: "{}",
    });
    assert.equal(foreignOrigin.status, 403);

    const noCsrf = await fetch(`${base}/api/ping`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        "x-loopviz-credential": credential,
        "x-loopviz-nonce": nonce("e"),
      },
      body: "{}",
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(calls.length, 1, "no rejected request may reach a handler");
  });
});

test("loopback: an unknown endpoint, an oversized body and a failing handler stay explicit", async () => {
  await withServer(async ({ server, base, port }) => {
    const token = server.issueBootstrap();
    const { credential } = await (await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: sameOrigin(port),
      body: JSON.stringify({ bootstrap: token }),
    })).json();
    const authed = sameOrigin(port, { "x-loopviz-credential": credential });

    const missing = await fetch(`${base}/api/nope`, {
      method: "POST",
      headers: { ...authed, "x-loopviz-nonce": nonce("f") },
      body: "{}",
    });
    assert.equal(missing.status, 404);

    const failing = await fetch(`${base}/api/boom`, {
      method: "POST",
      headers: { ...authed, "x-loopviz-nonce": nonce("g") },
      body: "{}",
    });
    assert.equal(failing.status, 500);
    assert.match((await failing.json()).error, /handler exploded/);

    const oversized = await fetch(`${base}/api/ping`, {
      method: "POST",
      headers: { ...authed, "x-loopviz-nonce": nonce("h") },
      body: JSON.stringify({ value: "x".repeat(70 * 1024) }),
    }).catch((error) => ({ status: 0, error }));
    assert.notEqual(oversized.status, 200, "a body above the cap must never succeed");
  });
});

test("loopback: static serving cannot escape the ui root", async () => {
  await withServer(async ({ base }) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");

    const nested = await fetch(`${base}/nested/deep.css`);
    assert.equal(nested.status, 200);
    assert.equal(nested.headers.get("content-type"), "text/css; charset=utf-8");

    for (const attempt of ["/../outside.txt", "/nested/../../outside.txt", "/%2e%2e/outside.txt"]) {
      const response = await fetch(`${base}${attempt}`, { redirect: "manual" });
      assert.ok(
        response.status === 403 || response.status === 404,
        `${attempt} must not be served (got ${response.status})`,
      );
    }
  });
});

test("loopback: the event stream requires a live credential and receives broadcasts", async () => {
  await withServer(async ({ server, base, port }) => {
    const token = server.issueBootstrap();
    const { credential } = await (await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: sameOrigin(port),
      body: JSON.stringify({ bootstrap: token }),
    })).json();

    const anonymous = await fetch(`${base}/events?credential=nope`);
    assert.equal(anonymous.status, 401);

    const controller = new AbortController();
    const stream = await fetch(`${base}/events?credential=${encodeURIComponent(credential)}`, {
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const hello = decoder.decode((await reader.read()).value);
    assert.match(hello, /event: hello/);

    // Wait for the server to register the stream before broadcasting.
    for (let i = 0; i < 50 && server.streamCount === 0; i += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    server.broadcast("run", { runId: "run-1" });
    const frame = decoder.decode((await reader.read()).value);
    assert.match(frame, /event: run/);
    assert.match(frame, /"runId":"run-1"/);

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
