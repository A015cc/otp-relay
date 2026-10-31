/**
 * OTP Relay — content script.
 *
 * Receives a code from the service worker and tries to place it into the most
 * likely verification-code field on the page. If no field is found, it shows a
 * small click-to-copy toast instead.
 */
(() => {
  const HOST_ID = "otp-relay-toast-host";
  const PENDING_TTL = 120_000;
  const TEXT_TYPES = new Set(["text", "tel", "number", "search", ""]);

  let pending = null; // { code, at }
  let port = null;

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "otp-keepalive" });
      port.onDisconnect.addListener(() => {
        port = null;
      });
    } catch {
      port = null;
    }
  }

  connectPort();
  setInterval(() => {
    if (!port) {
      connectPort();
      return;
    }
    try {
      port.postMessage({ t: Date.now() });
    } catch {
      port = null;
    }
  }, 20_000);

  function isTextLike(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.disabled || el.readOnly) return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return TEXT_TYPES.has(type);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) > 0.05
    );
  }

  function metaText(el) {
    return [
      el.name,
      el.id,
      el.getAttribute("autocomplete"),
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
      el.getAttribute("data-testid"),
      el.className,
      el.closest("form")?.getAttribute("aria-label") || "",
    ]
      .join(" ")
      .toLowerCase();
  }

  function looksLikeOtp(el) {
    if (el.getAttribute("autocomplete") === "one-time-code") return true;
    return /otp|one[-_ ]?time|verif|auth[-_ ]?code|security[-_ ]?code|sms[-_ ]?code|验证码|校验码|动态码|短信码|verification/.test(
      metaText(el)
    );
  }

  function digitBoxes() {
    const boxes = Array.from(document.querySelectorAll('input[maxlength="1"]')).filter(
      (el) =>
        isVisible(el) &&
        isTextLike(el) &&
        (el.inputMode === "numeric" ||
          el.getAttribute("type") === "tel" ||
          /[0-9]/.test(el.getAttribute("pattern") || "") ||
          looksLikeOtp(el))
    );
    if (boxes.length >= 4 && boxes.length <= 10) return boxes;
    return [];
  }

  function findTarget(code) {
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement &&
      isVisible(active) &&
      isTextLike(active) &&
      (looksLikeOtp(active) ||
        (active.maxLength === code.length && active.inputMode === "numeric"))
    ) {
      return { kind: "single", el: active };
    }

    const oneTime = Array.from(
      document.querySelectorAll('input[autocomplete="one-time-code"]')
    ).filter((el) => isVisible(el) && isTextLike(el));
    if (oneTime.length) return { kind: "single", el: oneTime[0] };

    const boxes = digitBoxes();
    if (boxes.length) return { kind: "digits", els: boxes };

    let best = null;
    let bestScore = 0;
    for (const el of Array.from(document.querySelectorAll("input"))) {
      if (!isVisible(el) || !isTextLike(el) || !looksLikeOtp(el)) continue;
      let score = 1;
      if (el.maxLength === code.length) score += 2;
      else if (el.maxLength >= 4 && el.maxLength <= 8) score += 1;
      if (el.inputMode === "numeric" || el.getAttribute("type") === "tel") score += 1;
      if (el.closest('[role="dialog"], dialog, .modal, .ant-modal')) score += 1;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (best && bestScore >= 2) return { kind: "single", el: best };

    return null;
  }

  function setNativeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillTarget(target, code) {
    if (target.kind === "digits") {
      const els = target.els;
      const digits = code.slice(0, els.length);
      els.forEach((el, index) => {
        el.focus();
        setNativeValue(el, digits[index] || "");
      });
      els[Math.min(digits.length, els.length) - 1]?.focus();
      return true;
    }

    target.el.focus();
    setNativeValue(target.el, code);
    return true;
  }

  function copyText(text) {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.cssText = "position:fixed;opacity:0;top:0;left:0";
        document.documentElement.appendChild(area);
        area.select();
        let ok = false;
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        area.remove();
        return ok;
      });
  }

  function showToast(message, code) {
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    const box = document.createElement("div");
    box.textContent = message;
    box.setAttribute("role", "status");
    box.style.cssText = [
      "font:13px/1.5 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif",
      "color:#fff",
      "background:rgba(24,27,34,.96)",
      "border:1px solid rgba(255,255,255,.14)",
      "border-radius:10px",
      "padding:10px 14px",
      "box-shadow:0 8px 28px rgba(0,0,0,.35)",
      "cursor:pointer",
      "user-select:none",
      "max-width:320px",
    ].join(";");
    box.title = code ? "点击复制验证码" : "";
    box.addEventListener("click", () => {
      if (!code) return;
      copyText(code).then((ok) => {
        box.textContent = ok ? "已复制验证码" : "复制失败，请手动输入";
        setTimeout(() => host.remove(), 1200);
      });
    });

    shadow.appendChild(box);
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 60_000);
  }

  function notifyFilled() {
    if (window.top === window) {
      showToast("已自动填入验证码");
      return;
    }
    try {
      window.top.postMessage({ source: "otp-relay", type: "filled" }, "*");
    } catch {
      // Cross-origin top access is fine for postMessage, but ignore failures.
    }
  }

  function tryFill(code) {
    pending = null;
    const target = findTarget(code);
    if (target) {
      try {
        fillTarget(target, code);
        notifyFilled();
        return true;
      } catch {
        // Fall through to the copy toast.
      }
    }
    if (window.top === window) {
      showToast(`验证码 ${code} 已到达 · 点击复制`, code);
    }
    return false;
  }

  window.addEventListener("message", (event) => {
    if (event.data?.source === "otp-relay" && event.data?.type === "filled") {
      showToast("已自动填入验证码");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !pending) return;
    if (Date.now() - pending.at > PENDING_TTL) {
      pending = null;
      return;
    }
    tryFill(pending.code);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "OTP_CODE" || !message.code) return;
    const code = String(message.code);
    pending = { code, at: Date.now() };
    if (document.visibilityState === "visible") tryFill(code);
  });
})();
