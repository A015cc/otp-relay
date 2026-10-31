/**
 * OTP Relay — receives verification codes from iOS Shortcuts and pushes them
 * to paired browsers over Server-Sent Events.
 *
 * Design notes:
 * - Codes live in memory only (never written to disk) and expire after OTP_TTL_SECONDS.
 * - Every request needs the shared token. Put the relay on your LAN only.
 * - No dependencies: runs on Bun (or inside the provided Docker image).
 */
import { timingSafeEqual, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8099);
const TOKEN = (process.env.OTP_TOKEN || "").trim();
const TTL_SECONDS = Math.max(30, Number(process.env.OTP_TTL_SECONDS || 180));
const TTL_MS = TTL_SECONDS * 1000;
const MAX_BODY = 4096;
const RATE_LIMIT = 30; // requests per minute per IP

if (TOKEN.length < 16) {
  console.error(
    "[otp-relay] OTP_TOKEN is missing or shorter than 16 characters. Refusing to start."
  );
  process.exit(1);
}

/** @type {{id: string, code: string, receivedAt: number} | null} */
let latest = null;
/** @type {Set<{controller: ReadableStreamDefaultController, timer: any, closed: boolean}>} */
const clients = new Set();
/** @type {Map<string, number[]>} */
const rateBuckets = new Map();
const encoder = new TextEncoder();

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Token, Authorization",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    }),
  });
}

function tokenFrom(req) {
  const url = new URL(req.url);
  const headerToken = req.headers.get("x-token") || "";
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  return headerToken || bearer || url.searchParams.get("token") || "";
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function authorized(req) {
  return safeEqual(tokenFrom(req), TOKEN);
}

function clientIp(req, server) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  try {
    return server.requestIP(req)?.address || "unknown";
  } catch {
    return "unknown";
  }
}

function allowRequest(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = [];
    rateBuckets.set(ip, bucket);
  }
  while (bucket.length && now - bucket[0] > 60_000) bucket.shift();
  if (bucket.length >= RATE_LIMIT) return false;
  bucket.push(now);

  // Opportunistic cleanup so the map cannot grow forever.
  if (rateBuckets.size > 500) {
    for (const [key, times] of rateBuckets) {
      if (!times.length || now - times[times.length - 1] > 120_000) {
        rateBuckets.delete(key);
      }
    }
  }
  return true;
}

function currentPayload() {
  if (!latest) return null;
  const age = Date.now() - latest.receivedAt;
  if (age > TTL_MS) {
    latest = null;
    return null;
  }
  return {
    id: latest.id,
    code: latest.code,
    received_at: latest.receivedAt,
    expires_in: Math.ceil((TTL_MS - age) / 1000),
  };
}

function closeClient(client) {
  if (!client || client.closed) return;
  client.closed = true;
  clients.delete(client);
  if (client.timer) clearInterval(client.timer);
  try {
    client.controller.close();
  } catch {
    // Already closed by the browser.
  }
}

function broadcast() {
  const payload = currentPayload();
  if (!payload) return;
  const chunk = encoder.encode(`event: code\ndata: ${JSON.stringify(payload)}\n\n`);
  for (const client of [...clients]) {
    try {
      client.controller.enqueue(chunk);
    } catch {
      closeClient(client);
    }
  }
}

function sseResponse() {
  /** @type {any} */
  let client;
  const stream = new ReadableStream({
    start(controller) {
      client = { controller, timer: null, closed: false };
      clients.add(client);
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      const initial = currentPayload();
      if (initial) {
        controller.enqueue(
          encoder.encode(`event: code\ndata: ${JSON.stringify(initial)}\n\n`)
        );
      }
      client.timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closeClient(client);
        }
      }, 15_000);
    },
    cancel() {
      closeClient(client);
    },
  });

  return new Response(stream, {
    headers: corsHeaders({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    }),
  });
}

function extractCode(body) {
  const raw = body?.code;
  if (typeof raw === "string" && /^[0-9]{4,8}$/.test(raw.trim())) {
    return raw.trim();
  }

  // Clients may post the whole SMS. Prefer a number that sits next to a
  // verification-code keyword; fall back to the first standalone 4-8 digits.
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text) return "";

  const afterKeyword =
    /(?:验证码|校验码|动态码|动态密码|短信码|verification\s*code|security\s*code|one[-\s]?time\s*(?:code|password)|otp|passcode|\bcode\b)\D{0,24}?(\d{4,8})(?!\d)/i;
  const beforeKeyword =
    /(?<!\d)(\d{4,8})(?!\d)\D{0,16}?(?:是|为)?\s*(?:您的|你的)?\s*(?:验证码|校验码|动态码|verification\s*code|security\s*code|otp|passcode|\bcode\b)/i;

  const match =
    text.match(afterKeyword) ||
    text.match(beforeKeyword) ||
    text.match(/(?<![0-9])[0-9]{4,8}(?![0-9])/);
  return match ? match[1] || match[0] : "";
}

async function handlePost(req, server) {
  if (!authorized(req)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!allowRequest(clientIp(req, server))) {
    return jsonResponse({ ok: false, error: "rate limited" }, 429);
  }
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return jsonResponse({ ok: false, error: "content-type must be application/json" }, 415);
  }

  const text = await req.text();
  if (text.length > MAX_BODY) {
    return jsonResponse({ ok: false, error: "body too large" }, 413);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  const code = extractCode(body);
  if (!code) {
    console.log("[otp-relay] message received but no 4-8 digit code found");
    return jsonResponse({ ok: false, error: "no 4-8 digit code found" }, 400);
  }

  latest = { id: randomUUID(), code, receivedAt: Date.now() };
  console.log(`[otp-relay] code received (${code.length} digits)`);
  broadcast();

  return jsonResponse({ ok: true, id: latest.id, expires_in: TTL_SECONDS });
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OTP Relay</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1115;color:#e6e8ee;
       display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}
  .card{background:#171a21;border:1px solid #272b35;border-radius:14px;padding:28px 32px;max-width:520px}
  h1{font-size:20px;margin:0 0 8px}
  p{color:#9aa3b2;line-height:1.6;margin:8px 0}
  code{background:#222733;padding:2px 6px;border-radius:5px}
  .ok{color:#5bd6a2}
</style></head>
<body><div class="card">
  <h1>OTP Relay <span class="ok">正在运行</span></h1>
  <p>接收 iPhone 快捷指令发来的验证码，并通过 SSE 推送给浏览器扩展。</p>
  <p>验证码只保存在内存中，默认 ${TTL_SECONDS} 秒后过期，不写磁盘。</p>
  <p>接口：<code>POST /api/code</code> · <code>GET /api/events</code> · <code>GET /api/latest</code></p>
</div></body></html>`;

async function handleGet(req, server) {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/") {
    return new Response(INDEX_HTML, {
      headers: corsHeaders({ "Content-Type": "text/html; charset=utf-8" }),
    });
  }

  if (url.pathname === "/api/events") {
    if (!authorized(req)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    return sseResponse();
  }

  if (url.pathname === "/api/latest") {
    if (!authorized(req)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const payload = currentPayload();
    if (!payload) return new Response(null, { status: 204, headers: corsHeaders() });
    return jsonResponse(payload);
  }

  return jsonResponse({ ok: false, error: "not found" }, 404);
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255,
  async fetch(req) {
    try {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if (req.method === "POST" && new URL(req.url).pathname === "/api/code") {
        return await handlePost(req, server);
      }
      if (req.method === "GET") {
        return await handleGet(req, server);
      }
      return jsonResponse({ ok: false, error: "method not allowed" }, 405);
    } catch (error) {
      console.error("[otp-relay] request failed:", error?.message || error);
      return jsonResponse({ ok: false, error: "internal error" }, 500);
    }
  },
});

console.log(`[otp-relay] listening on http://0.0.0.0:${PORT}`);
console.log(`[otp-relay] codes expire after ${TTL_SECONDS}s`);
