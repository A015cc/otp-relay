/**
 * OTP Relay — extension service worker.
 *
 * Holds one long-lived SSE connection to the NAS relay. Content scripts in open
 * tabs keep this worker alive with a heartbeat port, so a code arriving while a
 * browser window is open is pushed to the active tab immediately.
 */
const DEFAULTS = { serverUrl: "", token: "", enabled: true };
const MAX_RETRY = 30_000;

let cfg = { ...DEFAULTS };
let connected = false;
let latest = null; // { id, code, at, expiresAt }
let lastPushCode = "";
let lastPushAt = 0;
let session = 0;
let abortController = null;
let retryDelay = 1000;

function normalizeBase(raw) {
  let value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = "http://" + value;
  return value;
}

function hasConfig() {
  return cfg.enabled && normalizeBase(cfg.serverUrl) && cfg.token;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  cfg = { ...DEFAULTS, ...stored };
}

function handleCode(data, push = true) {
  const code = String(data?.code || "").trim();
  if (!/^[0-9]{4,8}$/.test(code)) return;
  const id = String(data?.id || "");
  const now = Date.now();
  const ttl = Number(data?.expires_in) > 0 ? Number(data.expires_in) : 180;
  const receivedAt = Number(data?.received_at) || now;

  latest = { id, code, at: now, expiresAt: now + ttl * 1000 };
  chrome.storage.session.set({ latest }).catch(() => {});

  if (!push) return;

  // Replaying an old code when the worker reconnects would fill the wrong page.
  // Keep it available in the popup, but only push codes that just arrived.
  if (now - receivedAt > 120_000) return;
  if (code === lastPushCode && now - lastPushAt < 15_000) return;
  lastPushCode = code;
  lastPushAt = now;

  // Only touch the active tab: the code should never be sprayed into every page.
  chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then((tabs) => {
      const tab = tabs && tabs[0];
      if (!tab?.id) return;
      chrome.tabs
        .sendMessage(tab.id, { type: "OTP_CODE", code, id })
        .catch(() => {});
    })
    .catch(() => {});
}

function parseEventBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") dataLines.push(value);
  }
  if (event !== "code" || !dataLines.length) return;
  try {
    handleCode(JSON.parse(dataLines.join("\n")));
  } catch {
    // Ignore malformed events.
  }
}

async function streamOnce(signal) {
  const base = normalizeBase(cfg.serverUrl);
  const response = await fetch(`${base}/api/events`, {
    headers: { "X-Token": cfg.token },
    signal,
    cache: "no-store",
  });
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok || !response.body) throw new Error(`http ${response.status}`);

  connected = true;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      parseEventBlock(block);
    }
  }
}

async function connect() {
  await loadConfig();
  session += 1;
  const mySession = session;

  if (abortController) abortController.abort();
  abortController = null;
  connected = false;

  if (!hasConfig()) return;

  const controller = new AbortController();
  abortController = controller;
  retryDelay = 1000;

  (async () => {
    while (session === mySession) {
      try {
        await streamOnce(controller.signal);
      } catch {
        // Network died, token rejected, NAS rebooted — retry with backoff.
      }
      if (session !== mySession || controller.signal.aborted) break;
      connected = false;
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY);
    }
  })();
}

async function fetchLatest(push = true) {
  if (!hasConfig()) return null;
  try {
    const base = normalizeBase(cfg.serverUrl);
    const response = await fetch(`${base}/api/latest`, {
      headers: { "X-Token": cfg.token },
      cache: "no-store",
    });
    if (response.status === 204) return latest;
    if (!response.ok) return latest;
    const data = await response.json();
    if (data?.code) handleCode(data, push);
    return latest;
  } catch {
    return latest;
  }
}

async function testConnection() {
  const base = normalizeBase(cfg.serverUrl);
  if (!base) return { ok: false, error: "请先填写 NAS 地址" };
  if (!cfg.token) return { ok: false, error: "请先填写访问令牌" };

  const started = Date.now();
  try {
    const health = await fetch(`${base}/health`, { cache: "no-store" });
    if (!health.ok) return { ok: false, error: `服务返回 HTTP ${health.status}` };

    const latestResponse = await fetch(`${base}/api/latest`, {
      headers: { "X-Token": cfg.token },
      cache: "no-store",
    });
    if (latestResponse.status === 401) return { ok: false, error: "令牌不正确（401）" };
    if (!latestResponse.ok && latestResponse.status !== 204) {
      return { ok: false, error: `接口返回 HTTP ${latestResponse.status}` };
    }
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: `连不上：${error?.message || "网络错误"}` };
  }
}

function isFresh(code) {
  return Boolean(code) && Date.now() < (code.expiresAt || code.at + 180_000);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATUS") {
    sendResponse({
      connected,
      latest: isFresh(latest) ? latest : null,
      serverUrl: cfg.serverUrl,
      tokenSet: Boolean(cfg.token),
      enabled: cfg.enabled,
    });
    return false;
  }

  if (message?.type === "FETCH_LATEST") {
    fetchLatest(Boolean(message.push)).then((code) =>
      sendResponse({ latest: isFresh(code) ? code : null })
    );
    return true;
  }

  if (message?.type === "TEST") {
    testConnection().then(sendResponse);
    return true;
  }

  if (message?.type === "RECONNECT") {
    connect().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "CLEAR") {
    latest = null;
    chrome.storage.session.remove("latest").catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.serverUrl || changes.token || changes.enabled) connect();
});

// Content-script heartbeats reset the service worker idle timer, so the SSE
// connection survives while at least one tab is open.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "otp-keepalive") return;
  port.onMessage.addListener(() => {});
});

// Fallback paths: if the worker was asleep when a code arrived, catch up on
// wake / tab switch / navigation.
chrome.tabs.onActivated.addListener(() => fetchLatest());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete") fetchLatest();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "otp-poll") fetchLatest();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("otp-poll", { periodInMinutes: 1 });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("otp-poll", { periodInMinutes: 1 });
  connect();
});

// Runs on every service-worker start, including wake-ups from events.
connect();
