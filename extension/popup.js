const DEFAULTS = { serverUrl: "", token: "", enabled: true };
const $ = (id) => document.getElementById(id);

let currentCode = "";
let refreshTimer = null;

function normalizeBase(raw) {
  let value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = "http://" + value;
  return value;
}

function setMessage(text, kind = "") {
  const el = $("msg");
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function renderStatus(status) {
  const dot = $("dot");
  const state = $("state");
  const configured = Boolean(status?.serverUrl);
  dot.className = "dot " + (status?.connected ? "on" : configured ? "off" : "");
  state.textContent = status?.connected
    ? "已连接"
    : configured
      ? "未连接"
      : "未配置";

  if (status?.latest?.code) {
    currentCode = status.latest.code;
    $("latestCode").textContent = currentCode;
    $("latestBox").hidden = false;
  } else {
    currentCode = "";
    $("latestBox").hidden = true;
  }
}

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    renderStatus(status);
  } catch {
    renderStatus(null);
  }
}

async function init() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $("serverUrl").value = cfg.serverUrl || "";
  $("token").value = cfg.token || "";
  $("enabled").checked = cfg.enabled !== false;

  await refreshStatus();
  // If the service worker restarted, pull the latest code from the NAS.
  try {
    const result = await chrome.runtime.sendMessage({ type: "FETCH_LATEST", push: false });
    if (result?.latest?.code) {
      currentCode = result.latest.code;
      $("latestCode").textContent = currentCode;
      $("latestBox").hidden = false;
    }
  } catch {
    // Ignore; status display already covers connectivity.
  }

  refreshTimer = setInterval(refreshStatus, 2000);
}

$("saveBtn").addEventListener("click", async () => {
  const serverUrl = normalizeBase($("serverUrl").value);
  const token = $("token").value.trim();
  const enabled = $("enabled").checked;

  if (!serverUrl) {
    setMessage("请填写 NAS 地址，例如 http://192.168.1.10:8099", "err");
    return;
  }
  try {
    new URL(serverUrl);
  } catch {
    setMessage("地址格式不对，需要 http:// 或 https:// 开头", "err");
    return;
  }
  if (token.length < 16) {
    setMessage("令牌至少 16 个字符，需与服务端 OTP_TOKEN 完全一致", "err");
    return;
  }

  await chrome.storage.local.set({ serverUrl, token, enabled });
  $("serverUrl").value = serverUrl;
  setMessage("已保存，正在连接…", "ok");

  try {
    await chrome.runtime.sendMessage({ type: "RECONNECT" });
  } catch {
    // The next status refresh will show the real state.
  }
  setTimeout(refreshStatus, 600);
});

$("testBtn").addEventListener("click", async () => {
  const serverUrl = normalizeBase($("serverUrl").value);
  const token = $("token").value.trim();

  // Test what is currently in the fields, without requiring a save first.
  await chrome.storage.local.set({ serverUrl, token, enabled: $("enabled").checked });
  try {
    await chrome.runtime.sendMessage({ type: "RECONNECT" });
  } catch {
    // Ignore.
  }

  $("testBtn").disabled = true;
  setMessage("测试中…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "TEST" });
    if (result?.ok) {
      setMessage(`连接正常${result.ms != null ? `（${result.ms} ms）` : ""}`, "ok");
    } else {
      setMessage(result?.error || "连接失败", "err");
    }
  } catch {
    setMessage("扩展后台没有响应，试试重新加载扩展", "err");
  } finally {
    $("testBtn").disabled = false;
    refreshStatus();
  }
});

$("copyBtn").addEventListener("click", async () => {
  if (!currentCode) return;
  try {
    await navigator.clipboard.writeText(currentCode);
    $("copyBtn").textContent = "已复制";
  } catch {
    $("copyBtn").textContent = "复制失败";
  }
  setTimeout(() => {
    $("copyBtn").textContent = "复制";
  }, 1200);
});

$("enabled").addEventListener("change", async () => {
  await chrome.storage.local.set({ enabled: $("enabled").checked });
});

window.addEventListener("unload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
});

init();
