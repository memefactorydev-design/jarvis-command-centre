// Guards for the paid endpoints.
// Local mode (npm start): the server listens on 127.0.0.1 only, so no code is needed.
// Hosted mode (Vercel): JARVIS_ACCESS_CODE must be set and sent as x-jarvis-code; plus a per-IP rate limit.
import { createHash, timingSafeEqual } from "node:crypto";

export function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

export function isLocal() {
  return process.env.JARVIS_LOCAL === "1";
}

export function checkAccess(request) {
  if (isLocal()) return null;
  const expected = process.env.JARVIS_ACCESS_CODE;
  if (!expected) return json({ error: "access_code_not_set" }, 503);
  const got = request.headers.get("x-jarvis-code") || "";
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? null : json({ error: "access_code" }, 401);
}

// Best-effort sliding window per instance (Vercel Fluid compute reuses instances, so this holds under normal use).
const buckets = new Map();
export function rateLimit(request, name, max, windowMs) {
  if (isLocal()) return null;
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const key = `${name}|${ip}`;
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    return json({ error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(windowMs / 1000)) });
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();
  return null;
}
