// The Mini App. One flat screen inside Telegram: which group, the Turnstile
// widget, one status line. Colors come from Telegram's theme variables; the
// retry action is Telegram's native MainButton.
import { MESSAGES, selectLang } from "./i18n";

const MESSAGES_JSON = JSON.stringify(MESSAGES).replace(/</g, "\\u003c");

export function renderPage(siteKey: string): string {
  const safeKey = JSON.stringify(siteKey.replace(/[^A-Za-z0-9_-]/g, ""));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Kitan</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--tg-theme-bg-color, #fff);
    --fg: var(--tg-theme-text-color, #1c1c1e);
    --muted: var(--tg-theme-hint-color, #6d6d72);
    --success: #34a853;
    --danger: var(--tg-theme-destructive-text-color, #e53935);
    --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px; --space-8: 32px;
    --font: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB",
      "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: var(--tg-theme-bg-color, #1c1c1d);
      --fg: var(--tg-theme-text-color, #f2f2f7);
      --muted: var(--tg-theme-hint-color, #98989f);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    min-height: 100dvh;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.5 var(--font);
    -webkit-font-smoothing: antialiased;
  }
  main {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    max-width: 28rem;
    margin: 0 auto;
    padding: var(--space-8) var(--space-4);
  }
  .intro { display: flex; flex-direction: column; gap: var(--space-2); }
  h1 {
    margin: 0;
    font-size: 24px;
    line-height: 1.3;
    font-weight: 600;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .lede { margin: 0; color: var(--muted); font-size: 14px; text-wrap: pretty; }
  .check { display: flex; flex-direction: column; gap: var(--space-3); }
  #widget:empty { display: none; }
  .status {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    min-height: 24px;
    margin: 0;
  }
  .status svg { flex: none; width: 16px; height: 16px; margin-top: var(--space-1); color: var(--muted); }
  [data-state="success"] .status svg { color: var(--success); }
  /* A retryable failure stays calm; red is for dead ends the user must leave the page to fix. */
  [data-state="blocked"] .status svg { color: var(--danger); }
  .status span { text-wrap: pretty; }
  :lang(ja) { word-break: auto-phrase; }
  .meta { margin: 0; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .spin { animation: spin .8s linear infinite; transform-origin: center; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main id="app" data-state="loading">
  <div class="intro">
    <h1 id="title"></h1>
    <p class="lede" id="lede"></p>
    <p class="meta" id="meta" hidden></p>
  </div>
  <div class="check">
    <div id="widget"></div>
    <p class="status" id="status-line" role="status" aria-live="polite">
      <svg id="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>
      <span id="status"></span>
    </p>
  </div>
</main>
<script>
  const SITE_KEY = ${safeKey};
  const tg = window.Telegram && window.Telegram.WebApp;
  const token = new URLSearchParams(location.search).get("token") || "";
  const MESSAGES = ${MESSAGES_JSON};
  const selectLang = ${selectLang.toString()};
  const lang = selectLang(
    (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code) || navigator.language,
    Object.keys(MESSAGES),
  );
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  const M = MESSAGES[lang];
  const T = Object.assign({}, M, {
    title: (chat) => chat ? M.title.replace("{chat}", "\\u2068" + chat + "\\u2069") : M.titleGeneric,
    expires: (t) => M.expires.replace("{t}", t),
  });

  const ICONS = {
    loading: '<circle cx="8" cy="8" r="6" opacity=".25"/><path class="spin" d="M14 8a6 6 0 0 0-6-6"/>',
    success: '<circle cx="8" cy="8" r="6"/><path d="m5.5 8 1.75 1.75L10.5 6.5"/>',
    error: '<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11h.01"/>',
  };

  const app = document.getElementById("app");
  const statusEl = document.getElementById("status");
  const icon = document.getElementById("icon");
  const meta = document.getElementById("meta");
  let turnstileToken = "";
  let widgetId = null;
  let openedAt = Date.now();
  let solveMs = null;
  let expiresAt = 0;
  let submitting = false;

  // The Turnstile widget reports its own progress; the status line only speaks
  // for what this page owns: loading, submitting, success, errors.
  function show(state, text) {
    app.dataset.state = state;
    statusEl.textContent = text;
    icon.innerHTML = ICONS[state === "blocked" ? "error" : state] || "";
    document.getElementById("status-line").hidden = !text;
  }

  function haptic(type) {
    try { tg.HapticFeedback.notificationOccurred(type); } catch {}
  }

  function retryButton(visible) {
    if (!tg || !tg.MainButton) return;
    if (visible) tg.MainButton.setParams({ text: T.retry, is_visible: true, is_active: true });
    else tg.MainButton.hide();
  }

  // Terminal: nothing on this page can fix it.
  function block(text) {
    show("blocked", text);
    retryButton(false);
    meta.hidden = true;
    expiresAt = 0;
    document.getElementById("widget").hidden = true;
    document.getElementById("lede").hidden = true;
  }

  // The widget's token is spent once submitted; hide it until the user retries.
  function fail(text) {
    document.getElementById("widget").hidden = true;
    show("error", text);
    haptic("error");
    retryButton(true);
  }

  function tick() {
    if (!expiresAt) return;
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (left === 0) { block(T.expired); return; }
    meta.textContent = T.expires(Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0"));
    meta.hidden = false;
  }

  function errorFor(status) {
    if (status === 404 || status === 410) return { text: T.expired, terminal: true };
    if (status === 409) return { text: T.done, terminal: true };
    if (status === 400) return { text: T.failed, terminal: false };
    return { text: T.busy, terminal: false };
  }

  async function api(path, extra) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ initData: tg.initData, token }, extra)),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  }

  async function submit() {
    if (submitting || !turnstileToken) return;
    submitting = true;
    retryButton(false);
    show("loading", T.sending);
    try {
      const result = await api("/api/verify", { turnstileToken, solveMs });
      if (result.ok) {
        show("success", T.success);
        haptic("success");
        meta.hidden = true;
        expiresAt = 0;
        setTimeout(() => tg.close(), 1500);
        return;
      }
      const error = errorFor(result.status);
      if (error.terminal) block(error.text);
      else fail(error.text);
    } catch {
      fail(T.offline);
    } finally {
      submitting = false;
    }
  }

  function resetWidget() {
    turnstileToken = "";
    if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
  }

  function retry() {
    retryButton(false);
    if (!window.turnstile) { location.reload(); return; }
    document.getElementById("widget").hidden = false;
    show("waiting", "");
    resetWidget();
  }

  function renderWidget() {
    widgetId = window.turnstile.render("#widget", {
      sitekey: SITE_KEY,
      theme: tg.colorScheme === "dark" ? "dark" : "light",
      size: "flexible",
      callback: (value) => {
        turnstileToken = value;
        if (solveMs === null) solveMs = Date.now() - openedAt;
        submit();
      },
      "error-callback": () => { fail(T.loadFailed); return true; },
      "expired-callback": () => { turnstileToken = ""; show("waiting", ""); },
    });
    show("waiting", "");
  }

  if (!tg || !tg.initData) {
    document.getElementById("title").textContent = T.title("");
    block(T.outside);
  } else {
    tg.ready();
    tg.expand();
    tg.MainButton.onClick(retry);
    document.getElementById("title").textContent = T.title(
      (tg.initDataUnsafe.chat && tg.initDataUnsafe.chat.title) || "",
    );
    document.getElementById("lede").textContent = T.lede;
    show("loading", T.loading);

    api("/api/open", {}).then((result) => {
      if (!result.ok) { block(errorFor(result.status).text); return; }
      if (result.body.chat_title) document.getElementById("title").textContent = T.title(result.body.chat_title);
      expiresAt = result.body.expires_at || 0;
      tick();
      setInterval(tick, 1000);
    }).catch(() => fail(T.offline));

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.onload = () => {
      if (app.dataset.state === "blocked") return;
      openedAt = Date.now();
      renderWidget();
    };
    script.onerror = () => fail(T.loadFailed);
    document.head.append(script);
  }
</script>
</body>
</html>`;
}
