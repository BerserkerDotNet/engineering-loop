import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const SCHEMA_VERSION = "1";

/** Deterministic JSON with sorted object keys, used for checksums. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function newUuid() {
  return randomUUID();
}

export function isoNow(clock = Date.now) {
  return new Date(clock()).toISOString();
}

export function isoAt(ms) {
  return new Date(ms).toISOString();
}

/** Truncates while recording that truncation happened, so nothing silently disappears. */
export function clamp(text, max) {
  if (typeof text !== "string") return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 24))}\n…[truncated ${text.length - max} chars]`;
}

const ID_SAFE = /[^A-Za-z0-9._:-]+/g;

/** Produces a contract-legal identifier from arbitrary text. */
export function toId(text, fallback = "unknown") {
  const cleaned = String(text ?? "").trim().replace(ID_SAFE, "-").replace(/^-+/, "").slice(0, 128);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Constant-time string comparison for credentials.
 *
 * Both sides are hashed first so the comparison is over fixed-width buffers and
 * neither the length nor the content of a secret leaks through timing.
 */
export function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** Cryptographically random URL-safe token. */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function pad(number, width) {
  return String(number).padStart(width, "0");
}

/** Errors that carry a stable machine-readable code. */
export class LoopVizError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "LoopVizError";
    this.code = code;
    this.details = details ?? null;
  }
}
