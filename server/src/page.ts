export function renderPage(siteKey: string): string {
  const safeKey = JSON.stringify(siteKey.replace(/[^A-Za-z0-9_-]/g, ""));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111111">
<title>Verify to join · Kitan</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
  (function () {
    var app = window.Telegram && window.Telegram.WebApp;
    var stored = null;
    try { stored = localStorage.getItem("antfu-design-color-scheme"); } catch {}
    if (stored !== "light" && stored !== "dark") stored = null;
    var scheme = stored || (app && app.colorScheme);
    if (!scheme) {
      scheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.dataset.theme = scheme;
    document.documentElement.classList.toggle("dark", scheme === "dark");
  })();
</script>
<style>
  :root {
    color-scheme: light dark;
    --bg-base: #fff;
    --bg-raised: rgba(255, 255, 255, .65);
    --color-base: #262626;
    --color-muted: #525252;
    --color-faint: #737373;
    --border-base: rgba(153, 153, 153, .22);
    --primary: #49833e;
    --primary-hover: #3b6832;
    --primary-fg: #fff;
    --warning: #b54708;
    --success: #027a48;
    --error: #c01048;
    --font-sans: "DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-mono: "DM Mono", ui-monospace, "SFMono-Regular", "Cascadia Code", Menlo, monospace;
    --ease-out: cubic-bezier(.23, 1, .32, 1);
  }
  :root[data-theme="dark"] {
    --bg-base: #111;
    --bg-raised: rgba(0, 0, 0, .6);
    --color-base: #e5e5e5;
    --color-muted: #a3a3a3;
    --color-faint: #8f8f8f;
    --border-base: rgba(153, 153, 153, .22);
    --primary: #a8cf96;
    --primary-hover: #cde4c2;
    --primary-fg: #111;
    --warning: #fec84b;
    --success: #6ce9a6;
    --error: #fd6f8e;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; padding: 0; }
  body {
    min-height: 100dvh;
    background: var(--bg-base);
    color: var(--color-base);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }
  .page {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    max-width: 480px;
    margin: 0 auto;
    padding: 0 16px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 0;
    border-bottom: 1px solid var(--border-base);
  }
  .brand {
    font-family: var(--font-mono);
    font-size: 14px;
    letter-spacing: -.02em;
    color: var(--color-base);
  }
  .header-note {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 32px 0 24px;
  }
  .intro h1 {
    margin: 0 0 8px;
    font-size: 24px;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -.02em;
  }
  .intro .lede {
    margin: 0;
    color: var(--color-muted);
    font-size: 14px;
    line-height: 1.6;
  }
  .panel {
    border: 1px solid var(--border-base);
    border-radius: 12px;
    background: var(--bg-raised);
    padding: 24px;
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }
  .panel-title {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--border-base);
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .badge::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .panel[data-state="loading"] .badge { color: var(--warning); }
  .panel[data-state="success"] .badge { color: var(--success); }
  .panel[data-state="error"] .badge { color: var(--error); }
  #turnstile {
    min-height: 70px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 16px;
  }
  #status {
    min-height: 2.5em;
    margin: 0 0 16px;
    color: var(--color-muted);
    font-size: 14px;
    line-height: 1.5;
  }
  .button {
    width: 100%;
    min-height: 48px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 16px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--primary);
    color: var(--primary-fg);
    font: 600 14px/1 var(--font-sans);
    cursor: pointer;
    transition:
      transform 150ms var(--ease-out),
      background-color 150ms var(--ease-out);
  }
  .button:active { transform: scale(.98); }
  .button:focus-visible {
    outline: 2px solid var(--color-base);
    outline-offset: 2px;
  }
  .button:disabled {
    cursor: not-allowed;
    opacity: .5;
    transform: none;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  [hidden] { display: none !important; }
  .help {
    margin: 12px 0 0;
    color: var(--color-faint);
    font-size: 12px;
    line-height: 1.5;
  }
  .footer {
    padding: 16px 0 24px;
    color: var(--color-faint);
    font-size: 11px;
    line-height: 1.5;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (hover: hover) and (pointer: fine) {
    .button:hover { background: var(--primary-hover); }
  }
  @media (min-width: 640px) {
    .main { justify-content: center; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
    }
    .button:active { transform: none; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="header">
    <span class="brand">kitan</span>
    <span class="header-note">Join verification</span>
  </header>
  <main class="main">
    <section class="intro" aria-labelledby="title">
      <h1 id="title">Verify to join</h1>
      <p class="lede">Complete the human check. Your join request is approved automatically.</p>
    </section>
    <section class="panel" id="panel" data-state="idle" aria-labelledby="panel-title">
      <div class="panel-head">
        <h2 class="panel-title" id="panel-title">Human check</h2>
        <span class="badge" id="badge">Waiting</span>
      </div>
      <div id="turnstile" aria-label="Human verification challenge"></div>
      <p id="status" role="status" aria-live="polite">Loading the check...</p>
      <button class="button" id="verify" type="button" hidden>
        <span class="spinner" id="spinner" hidden aria-hidden="true"></span>
        <span id="verify-label">Verify and join</span>
      </button>
      <p class="help">If this keeps failing, ask a group admin to approve your request.</p>
    </section>
  </main>
  <footer class="footer">Telegram verifies your account. Cloudflare handles the challenge.</footer>
</div>
<script>
  const SITE_KEY = ${safeKey};
  const tg = window.Telegram && window.Telegram.WebApp;
  const token = new URLSearchParams(location.search).get("token") || "";
  const panel = document.getElementById("panel");
  const badge = document.getElementById("badge");
  const statusEl = document.getElementById("status");
  const button = document.getElementById("verify");
  const spinner = document.getElementById("spinner");
  const label = document.getElementById("verify-label");
  let turnstileToken = "";
  let ready = false;

  function setState(state, text, badgeText) {
    panel.dataset.state = state;
    statusEl.textContent = text;
    badge.textContent = badgeText;
  }

  function setBusy(busy) {
    button.disabled = busy || !ready;
    button.setAttribute("aria-busy", busy ? "true" : "false");
    spinner.hidden = !busy;
    label.textContent = busy ? "Checking..." : ready ? "Verify and join" : "Waiting for check";
  }

  function fail(text) {
    ready = false;
    setState("error", text, "Failed");
    setBusy(false);
  }

  if (!token || !tg || !tg.initData) {
    setState("error", "Open this page from the verification message.", "Blocked");
  }
  else {
    tg.ready();
    if (tg.expand) tg.expand();
    const theme = tg.themeParams || {};
    if (theme.bg_color) document.documentElement.style.setProperty("--bg-base", theme.bg_color);
    if (theme.secondary_bg_color) document.documentElement.style.setProperty("--bg-raised", theme.secondary_bg_color);
    if (theme.text_color) document.documentElement.style.setProperty("--color-base", theme.text_color);
    if (theme.hint_color) {
      document.documentElement.style.setProperty("--color-muted", theme.hint_color);
      document.documentElement.style.setProperty("--color-faint", theme.hint_color);
    }
    button.hidden = false;

    if (!SITE_KEY) {
      ready = true;
      setState("idle", "The challenge is not configured in this development build.", "Ready");
      setBusy(false);
    }
    else {
      setState("loading", "Loading the check...", "Loading");
      setBusy(true);
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.onload = () => {
        if (!window.turnstile) {
          fail("The check could not load. Reload and try again.");
          return;
        }
        turnstile.render(document.getElementById("turnstile"), {
          sitekey: SITE_KEY,
          theme: "auto",
          size: "flexible",
          callback: (value) => {
            turnstileToken = value;
            ready = true;
            setState("idle", "Complete the check, then tap Verify.", "Ready");
            setBusy(false);
          },
          "error-callback": () => fail("The check failed. Reload and try again."),
          "expired-callback": () => {
            turnstileToken = "";
            ready = false;
            setState("idle", "The check expired. Complete it again.", "Waiting");
            setBusy(false);
          },
        });
      };
      script.onerror = () => fail("The check could not load. Reload and try again.");
      document.head.append(script);
    }

    button.addEventListener("click", async () => {
      if (!ready || button.disabled) return;
      setState("loading", "Verifying...", "Checking");
      setBusy(true);
      try {
        const response = await fetch("/api/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            initData: tg.initData,
            turnstileToken,
            token,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || "Verification failed. Try again.");
        }
        ready = false;
        setState("success", "Verified. You can close this window.", "Verified");
        button.disabled = true;
        button.setAttribute("aria-busy", "false");
        spinner.hidden = true;
        label.textContent = "Verified";
        setTimeout(() => { if (tg.close) tg.close(); }, 1200);
      }
      catch (error) {
        setState("error", error instanceof Error ? error.message : "Verification failed. Try again.", "Failed");
        setBusy(false);
      }
    });
  }
</script>
</body>
</html>`;
}
