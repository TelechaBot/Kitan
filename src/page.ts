// The Mini App. One flat screen inside Telegram: which group, the check, and a status
// line. A strict check walks two Turnstile widgets and one sum in a shuffled order, so
// the same screen swaps between them without ever showing two widgets or reusing a
// spent token. Colors come from Telegram's theme variables; the retry action is
// Telegram's native MainButton.
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
  .math { display: flex; flex-direction: column; gap: var(--space-3); }
  .question { margin: 0; font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  #math-form { display: flex; gap: var(--space-2); }
  #math-input {
    flex: 1;
    min-width: 0;
    padding: var(--space-3);
    font: inherit;
    color: var(--fg);
    background: transparent;
    border: 1px solid var(--muted);
    border-radius: 10px;
  }
  #math-input:focus-visible { outline: 2px solid var(--fg); outline-offset: 1px; }
  #math-submit {
    padding: var(--space-3) var(--space-4);
    font: inherit;
    font-weight: 600;
    color: var(--bg);
    background: var(--fg);
    border: 0;
    border-radius: 10px;
  }
  #math-submit:disabled { opacity: .6; }
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
    <div class="math" id="math" hidden>
      <p class="lede" id="math-lede"></p>
      <p class="question" id="math-question"></p>
      <form id="math-form">
        <input id="math-input" type="text" inputmode="numeric" autocomplete="off" pattern="-?[0-9]*" required>
        <button id="math-submit" type="submit"></button>
      </form>
    </div>
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
  // A token from a mute notice: the same check, to lift the mute instead of to join.
  const appeal = /^u[0-9a-f]{24}$/.test(token);
  const named = (text, chat) => text.replace("{chat}", "\\u2068" + chat + "\\u2069");
  const T = Object.assign({}, M, {
    title: (chat) => appeal
      ? (chat ? named(M.appealTitle, chat) : M.appealTitleGeneric)
      : (chat ? named(M.title, chat) : M.titleGeneric),
    expires: (t) => M.expires.replace("{t}", t),
    stepOf: (n, total) => M.stepOf.replace("{n}", String(n)).replace("{total}", String(total)),
  }, appeal ? { lede: M.appealLede, success: M.unmuted, expired: M.appealNone, done: M.unmuted } : {});

  const ICONS = {
    loading: '<circle cx="8" cy="8" r="6" opacity=".25"/><path class="spin" d="M14 8a6 6 0 0 0-6-6"/>',
    success: '<circle cx="8" cy="8" r="6"/><path d="m5.5 8 1.75 1.75L10.5 6.5"/>',
    error: '<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11h.01"/>',
  };

  const app = document.getElementById("app");
  const widgetHost = document.getElementById("widget");
  const mathBox = document.getElementById("math");
  const mathForm = document.getElementById("math-form");
  const mathInput = document.getElementById("math-input");
  const mathQuestion = document.getElementById("math-question");
  const mathSubmit = document.getElementById("math-submit");
  const statusEl = document.getElementById("status");
  const icon = document.getElementById("icon");
  const meta = document.getElementById("meta");
  let step = null;
  let turnstileToken = "";
  let widgetId = null;
  let widgetRendered = false;
  let turnstileReady = false;
  let turnstileFailed = false;
  let openedAt = Date.now();
  let solveMs = null;
  let expiresAt = 0;
  let submitting = false;

  // The check reports its own progress; the status line only speaks for what this page
  // owns: loading, submitting, success, errors, and which step is next.
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

  function stepText() {
    return step ? T.stepOf(step.index + 1, step.total) : "";
  }

  function hideChecks() {
    widgetHost.hidden = true;
    mathBox.hidden = true;
  }

  // Terminal: nothing on this page can fix it.
  function block(text) {
    show("blocked", text);
    retryButton(false);
    meta.hidden = true;
    expiresAt = 0;
    hideChecks();
    document.getElementById("lede").hidden = true;
  }

  // The widget's token is spent once submitted; hide the check until the user retries.
  function fail(text) {
    hideChecks();
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
    if (status === 403 && appeal) return { text: T.appealUsed, terminal: true };
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

  function resetWidget() {
    turnstileToken = "";
    if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
  }

  // Show the Turnstile widget, rendering it once; later visits reset the same widget,
  // so no second widget is ever created and no spent token survives.
  function ensureWidget() {
    if (app.dataset.state === "blocked") return;
    mathBox.hidden = true;
    widgetHost.hidden = false;
    if (!turnstileReady) {
      if (turnstileFailed) fail(T.loadFailed);
      return;
    }
    if (!widgetRendered) {
      renderWidget();
      widgetRendered = true;
    } else {
      resetWidget();
      show("waiting", stepText());
    }
  }

  function showMath(next, warning) {
    widgetHost.hidden = true;
    mathBox.hidden = false;
    document.getElementById("math-lede").textContent = T.mathLede;
    mathQuestion.textContent = next.question + " = ?";
    mathInput.value = "";
    mathInput.placeholder = T.mathPlaceholder;
    mathSubmit.textContent = T.mathSubmit;
    show(warning ? "error" : "waiting", warning ? warning + " (" + T.stepOf(next.index + 1, next.total) + ")" : T.stepOf(next.index + 1, next.total));
    mathInput.focus();
  }

  function applyStep(next, warning) {
    step = next || null;
    if (!step) {
      show("waiting", "");
      ensureWidget();
      return;
    }
    if (step.kind === "math") showMath(step, warning);
    else ensureWidget();
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
      "expired-callback": () => { turnstileToken = ""; show("waiting", stepText()); },
    });
    show("waiting", stepText());
  }

  async function submit() {
    if (submitting) return;
    const math = Boolean(step && step.kind === "math");
    const answer = math ? mathInput.value.trim() : "";
    if (math ? !answer : !turnstileToken) return;
    submitting = true;
    retryButton(false);
    mathSubmit.disabled = true;
    show("loading", T.sending);
    // A Turnstile token is single-use: drop it before the request so a stray callback
    // cannot submit it twice.
    const payload = math ? { answer, solveMs } : { turnstileToken, solveMs };
    if (!math) turnstileToken = "";
    try {
      const result = await api("/api/verify", payload);
      if (result.ok && result.body.done === false && result.body.step) {
        haptic("success");
        applyStep(result.body.step);
        return;
      }
      if (result.ok) {
        show("success", T.success);
        haptic("success");
        meta.hidden = true;
        expiresAt = 0;
        setTimeout(() => tg.close(), 1500);
        return;
      }
      if (result.status === 400 && result.body.step) {
        // A wrong sum: the server sent a fresh question, so ask again in place.
        haptic("error");
        applyStep(result.body.step, T.failed);
        return;
      }
      const error = errorFor(result.status);
      if (error.terminal) block(error.text);
      else fail(error.text);
    } catch {
      fail(T.offline);
    } finally {
      submitting = false;
      mathSubmit.disabled = false;
    }
  }

  function retry() {
    retryButton(false);
    if (step && step.kind === "math") { applyStep(step); return; }
    if (!window.turnstile) { location.reload(); return; }
    ensureWidget();
  }

  mathForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });

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
      applyStep(result.body.step || null);
    }).catch(() => fail(T.offline));

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.onload = () => {
      if (app.dataset.state === "blocked") return;
      turnstileReady = true;
      openedAt = Date.now();
      if (!step || step.kind === "cf") ensureWidget();
    };
    script.onerror = () => {
      turnstileFailed = true;
      if (!step || step.kind === "cf") fail(T.loadFailed);
    };
    document.head.append(script);
  }
</script>
</body>
</html>`;
}
