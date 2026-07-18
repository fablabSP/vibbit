import { normaliseClassCode } from "./classroom-store.mjs";

export const JOIN_UNAVAILABLE_MARKER = "data-join-unavailable";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const JOIN_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};

function joinShell({ title, body }) {
  return `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="favicon.svg" />
    <title>${escapeHtml(title)} · Vibbit</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-1: #0b1220;
        --bg-2: #121f38;
        --panel: rgba(13, 27, 49, 0.96);
        --text: #e8eefc;
        --muted: #b9c9e5;
        --link: #7ec8ff;
        --line: rgba(158, 186, 228, 0.28);
        --accent: #77c7ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font: 18px/1.5 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 10% 0%, #1a2e56 0%, rgba(26, 46, 86, 0) 46%),
          radial-gradient(circle at 100% 100%, #173058 0%, rgba(23, 48, 88, 0) 44%),
          linear-gradient(160deg, var(--bg-2), var(--bg-1));
      }
      main {
        width: min(960px, 94vw);
        margin: 2rem auto 3rem;
        padding: clamp(1.4rem, 3vw, 2.4rem);
        border-radius: 1.1rem;
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: 0 24px 56px rgba(0, 0, 0, 0.36);
        text-align: center;
      }
      h1 { margin: 0 0 0.5rem; font-size: clamp(2rem, 5vw, 3rem); }
      p { margin: 0.5rem 0; color: var(--muted); }
      a { color: var(--link); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .code-display {
        margin: 1.4rem 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: clamp(3.5rem, 14vw, 7rem);
        font-weight: 800;
        letter-spacing: 0.18em;
        color: var(--accent);
      }
      .server-url {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: clamp(1.1rem, 3vw, 1.5rem);
        padding: 0.5rem 0.8rem;
        border-radius: 0.6rem;
        border: 1px solid var(--line);
        background: rgba(8, 18, 34, 0.95);
        display: inline-block;
      }
      .steps {
        margin-top: 1.6rem;
        text-align: left;
        max-width: 38rem;
        margin-left: auto;
        margin-right: auto;
      }
      .steps ol { margin: 0.4rem 0 0; padding-left: 1.2rem; }
      .steps li { margin: 0.45rem 0; }
      .links { margin-top: 1.4rem; display: flex; flex-wrap: wrap; gap: 0.8rem; justify-content: center; }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.6rem;
        border: 1px solid rgba(126, 200, 255, 0.4);
        padding: 0.55rem 0.9rem;
        font-weight: 600;
        color: var(--text);
        background: rgba(126, 200, 255, 0.16);
      }
    </style>
  </head>
  <body>
    <main>
      ${body}
    </main>
  </body>
</html>`;
}

export function resolveJoinAvailability(store, rawCode) {
  const code = normaliseClassCode(rawCode);
  if (!code || code.length !== 5) {
    return { available: false };
  }
  const state = store.getState();
  if (state.retiredClassCodes && state.retiredClassCodes[code]) {
    return { available: false };
  }
  const classroom = store.findClassroomByCode(code);
  if (classroom) {
    return { available: true, code, classroom };
  }
  return { available: false };
}

export function renderJoinUnavailablePage() {
  const body = `
    <div ${JOIN_UNAVAILABLE_MARKER}>
      <h1>Classroom unavailable</h1>
      <p>This classroom code is not available. Check the code with your teacher or try again later.</p>
    </div>
  `;
  return joinShell({ title: "Classroom unavailable", body });
}

export function renderJoinAvailablePage({
  code,
  publicOrigin,
  bookmarkletPath = "/bookmarklet",
  extensionPath = "/download/vibbit-extension.zip"
}) {
  const body = `
    <h1>Join this classroom</h1>
    <p>Class code</p>
    <div class="code-display">${escapeHtml(code)}</div>
    <p>Server URL</p>
    <div class="server-url">${escapeHtml(publicOrigin)}</div>
    <div class="steps">
      <p><strong>How to connect</strong></p>
      <ol>
        <li>Open a MakeCode project in your browser.</li>
        <li>Install the <a href="${escapeHtml(extensionPath)}">Vibbit extension</a> or use the <a href="${escapeHtml(bookmarkletPath)}">bookmarklet</a>.</li>
        <li>Choose <strong>Managed</strong> and enter the server URL and class code shown above.</li>
      </ol>
    </div>
    <div class="links">
      <a class="btn" href="${escapeHtml(extensionPath)}">Download extension</a>
      <a class="btn" href="${escapeHtml(bookmarkletPath)}">Get bookmarklet</a>
    </div>
  `;
  return joinShell({ title: "Join classroom", body });
}

export function joinHtmlResponse(status, html, { corsHeaders = {} } = {}) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    ...JOIN_SECURITY_HEADERS,
    ...corsHeaders
  });
  return new Response(html, { status, headers });
}
