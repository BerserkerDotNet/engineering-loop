import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname, sep, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomToken, timingSafeEqualString, LoopVizError } from "./util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, "ui");

const MAX_BODY_BYTES = 64 * 1024;
const BOOTSTRAP_TTL_MS = 30_000;
const CREDENTIAL_TTL_MS = 10 * 60_000;
const CREDENTIAL_MAX_LIFETIME_MS = 12 * 60 * 60_000;
const CREDENTIAL_RENEW_MS = 60_000;
const NONCE_WINDOW_MS = 5 * 60_000;
const MAX_NONCES = 4096;
const MAX_STREAMS = 16;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  // The canvas is the only intended embedder. Denying framing outright stops a
  // hostile local page from loading the UI and driving it through the user.
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function constantTimeEquals(a, b) {
  return timingSafeEqualString(a, b);
}

/**
 * Local-only HTTP surface for the canvas.
 *
 * Security model (critique 8):
 *  - binds 127.0.0.1 only, on an ephemeral port;
 *  - the canvas URL carries a *one-use* bootstrap token that can only be
 *    exchanged for a short-TTL instance credential, and only once;
 *  - every subsequent request must present the instance credential plus a
 *    fresh nonce, so a captured request cannot be replayed;
 *  - state-changing requests must be same-origin and carry the CSRF header;
 *  - bodies are bounded and the static root cannot be escaped.
 */
export function createLoopbackServer(options) {
  const {
    handlers,
    now = () => Date.now(),
    log = () => {},
    uiDir = UI_DIR,
    credentialTtlMs = CREDENTIAL_TTL_MS,
    credentialMaxLifetimeMs = CREDENTIAL_MAX_LIFETIME_MS,
    bootstrapTtlMs = BOOTSTRAP_TTL_MS,
  } = options;

  const bootstraps = new Map(); // token -> {issuedAt, usedAt}
  const credentials = new Map(); // credential -> {issuedAt, expiresAt, bootstrap}
  const nonces = new Map(); // nonce -> firstSeenMs
  const streams = new Set();
  const staticRoot = resolvePath(uiDir);

  let server = null;
  let port = 0;

  function issueBootstrap() {
    const token = randomToken(24);
    bootstraps.set(token, { issuedAt: now(), usedAt: null });
    sweep();
    return token;
  }

  function sweep() {
    const current = now();
    for (const [token, entry] of bootstraps) {
      if (entry.usedAt !== null || current - entry.issuedAt > bootstrapTtlMs) {
        if (entry.usedAt === null || current - entry.usedAt > bootstrapTtlMs) bootstraps.delete(token);
      }
    }
    for (const [credential, entry] of credentials) {
      if (current > entry.expiresAt) credentials.delete(credential);
    }
    for (const [nonce, seen] of nonces) {
      if (current - seen > NONCE_WINDOW_MS) nonces.delete(nonce);
    }
    while (nonces.size > MAX_NONCES) {
      const oldest = nonces.keys().next().value;
      nonces.delete(oldest);
    }
  }

  function redeemBootstrap(token) {
    sweep();
    const entry = [...bootstraps.entries()].find(([candidate]) => constantTimeEquals(candidate, token));
    if (!entry) return { ok: false, reason: "unknown bootstrap token" };
    const [key, record] = entry;
    if (record.usedAt !== null) return { ok: false, reason: "bootstrap token already redeemed" };
    if (now() - record.issuedAt > bootstrapTtlMs) return { ok: false, reason: "bootstrap token expired" };
    record.usedAt = now();
    const credential = randomToken(32);
    credentials.set(credential, {
      issuedAt: now(),
      expiresAt: now() + credentialTtlMs,
      maxLifetimeMs: credentialMaxLifetimeMs,
      bootstrap: key,
    });
    return { ok: true, credential, expiresInMs: credentialTtlMs, renewAfterMs: Math.min(CREDENTIAL_RENEW_MS, credentialTtlMs / 2) };
  }

  function authenticate(req) {
    sweep();
    const presented = req.headers["x-loopviz-credential"];
    if (typeof presented !== "string" || presented.length === 0) {
      return { ok: false, status: 401, reason: "missing instance credential" };
    }
    const found = [...credentials.entries()].find(([candidate]) => constantTimeEquals(candidate, presented));
    if (!found) return { ok: false, status: 401, reason: "unknown instance credential" };
    const [credential, record] = found;
    if (now() > record.expiresAt) {
      credentials.delete(credential);
      return { ok: false, status: 401, reason: "instance credential expired" };
    }
    // Sliding renewal keeps a live canvas working without a long-lived secret,
    // but never past the hard lifetime: an always-open canvas must re-bootstrap
    // rather than hold one credential indefinitely.
    if (now() - record.issuedAt > record.maxLifetimeMs) {
      credentials.delete(credential);
      return { ok: false, status: 401, reason: "instance credential reached its maximum lifetime" };
    }
    record.expiresAt = now() + credentialTtlMs;
    return { ok: true, credential };
  }

  function checkNonce(req) {
    const nonce = req.headers["x-loopviz-nonce"];
    if (typeof nonce !== "string" || nonce.length < 16) {
      return { ok: false, status: 400, reason: "missing or short request nonce" };
    }
    if (nonces.has(nonce)) return { ok: false, status: 409, reason: "replayed request nonce" };
    nonces.set(nonce, now());
    return { ok: true };
  }

  /**
   * The same-site checks every request must pass, including ones a browser
   * makes without custom headers. Split from the CSRF header check because
   * EventSource cannot set headers, yet must still be refused when a hostile
   * origin opens it.
   */
  function checkSite(req) {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return { ok: false, status: 403, reason: `cross-site request rejected (${site})` };
    }
    if (origin !== undefined) {
      const expected = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      if (!expected.has(origin)) return { ok: false, status: 403, reason: `disallowed origin ${origin}` };
    }
    return { ok: true };
  }

  function checkOrigin(req) {
    const site = checkSite(req);
    if (!site.ok) return site;
    if (req.headers["x-loopviz-csrf"] !== "1") {
      return { ok: false, status: 403, reason: "missing CSRF header" };
    }
    return { ok: true };
  }

  function readBody(req) {
    return new Promise((resolvePromise, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new LoopVizError("body_too_large", `request body exceeded ${MAX_BODY_BYTES} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function serveStatic(req, res, pathname) {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = resolvePath(join(staticRoot, normalize(relative)));
    if (target !== staticRoot && !target.startsWith(staticRoot + sep)) {
      sendJson(res, 403, { error: "path escapes the static root" });
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const body = readFileSync(target);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
      "content-length": body.length,
    });
    res.end(body);
  }

  function broadcast(eventName, payload) {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const stream of [...streams]) {
      try {
        stream.write(frame);
      } catch (error) {
        // A stream that cannot be written to is gone; dropping it here is what
        // keeps the set from growing across canvas reloads.
        log(`dropping closed event stream: ${error.message}`);
        streams.delete(stream);
      }
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = url.pathname;

    if (pathname === "/bootstrap" && req.method === "POST") {
      const origin = checkOrigin(req);
      if (!origin.ok) return sendJson(res, origin.status, { error: origin.reason });
      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      const result = redeemBootstrap(String(body.bootstrap ?? ""));
      if (!result.ok) {
        log(`bootstrap rejected: ${result.reason}`);
        return sendJson(res, 403, { error: result.reason });
      }
      return sendJson(res, 200, {
        credential: result.credential,
        expiresInMs: result.expiresInMs,
        renewAfterMs: result.renewAfterMs,
      });
    }

    if (pathname.startsWith("/api/")) {
      const origin = checkOrigin(req);
      if (!origin.ok) return sendJson(res, origin.status, { error: origin.reason });
      const auth = authenticate(req);
      if (!auth.ok) return sendJson(res, auth.status, { error: auth.reason });
      const nonce = checkNonce(req);
      if (!nonce.ok) return sendJson(res, nonce.status, { error: nonce.reason });

      const name = pathname.slice("/api/".length);
      const handler = handlers[name];
      if (!handler) return sendJson(res, 404, { error: `unknown endpoint ${name}` });

      let input = {};
      if (req.method === "POST") {
        try {
          input = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return sendJson(res, 400, { error: "invalid JSON body" });
        }
      } else {
        input = Object.fromEntries(url.searchParams.entries());
      }
      try {
        const result = await handler(input, { credential: auth.credential });
        return sendJson(res, 200, result ?? {});
      } catch (error) {
        log(`api ${name} failed: ${error.message}`);
        return sendJson(res, error instanceof LoopVizError ? 400 : 500, {
          error: error.message,
          code: error.code ?? "internal_error",
        });
      }
    }

    if (pathname === "/events") {
      // EventSource cannot set headers, so the credential travels as a query
      // parameter here. Every check that does not require a custom header still
      // applies: a hostile origin is refused before the stream is opened.
      const site = checkSite(req);
      if (!site.ok) return sendJson(res, site.status, { error: site.reason });
      const dest = req.headers["sec-fetch-dest"];
      if (dest !== undefined && dest !== "empty") {
        return sendJson(res, 403, { error: `event stream cannot be requested as ${dest}` });
      }
      if (streams.size >= MAX_STREAMS) {
        return sendJson(res, 503, { error: `event stream limit of ${MAX_STREAMS} reached` });
      }
      const presented = url.searchParams.get("credential") ?? "";
      const found = [...credentials.entries()].find(([candidate]) => constantTimeEquals(candidate, presented));
      if (!found || now() > found[1].expiresAt) {
        return sendJson(res, 401, { error: "unknown or expired instance credential" });
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date(now()).toISOString() })}\n\n`);
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return undefined;
    }

    if (req.method === "GET") return serveStatic(req, res, pathname);
    return sendJson(res, 405, { error: "method not allowed" });
  }

  return {
    get port() {
      return port;
    },
    get streamCount() {
      return streams.size;
    },
    issueBootstrap,
    redeemBootstrap,
    broadcast,
    async start() {
      if (server) return port;
      server = createServer((req, res) => {
        handle(req, res).catch((error) => {
          try {
            sendJson(res, 500, { error: error.message });
          } catch {
            /* the socket is already gone */
          }
        });
      });
      await new Promise((done, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", done);
      });
      port = server.address().port;
      return port;
    },
    async stop() {
      for (const stream of [...streams]) {
        try {
          stream.end();
        } catch {
          /* already closed */
        }
      }
      streams.clear();
      if (!server) return;
      await new Promise((done) => server.close(done));
      server = null;
    },
    canvasUrl(bootstrap, params = {}) {
      const url = new URL(`http://127.0.0.1:${port}/index.html`);
      url.searchParams.set("bootstrap", bootstrap);
      for (const [key, value] of Object.entries(params)) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      }
      return url.toString();
    },
  };
}

export const SECURITY = Object.freeze({
  MAX_BODY_BYTES,
  BOOTSTRAP_TTL_MS,
  CREDENTIAL_TTL_MS,
  NONCE_WINDOW_MS,
  CSP,
});
