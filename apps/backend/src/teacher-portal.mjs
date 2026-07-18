import {
  createTeacherId,
  createTeacherPortalStore,
  normaliseApiBaseUrl,
  sanitiseTeacherPortalState,
  TEACHER_PORTAL_DEFAULTS
} from "./classroom-store.mjs";

const TEACHER_SESSION_COOKIE = "vibbit_teacher_session";
const OAUTH_STATE_COOKIE = "vibbit_oauth_state";
const TEACHER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function randomBytes(length) {
  const size = Math.max(1, Number(length) || 1);
  const bytes = new Uint8Array(size);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < size; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseCookies(headerValue) {
  const cookies = {};
  for (const part of String(headerValue || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function serializeCookie(name, value, {
  maxAgeSeconds,
  httpOnly = true,
  sameSite = "Lax",
  path = "/",
  secure = false
} = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`);
  return parts.join("; ");
}

function clearCookie(name, { secure = false, path = "/" } = {}) {
  return serializeCookie(name, "", { maxAgeSeconds: 0, secure, path });
}

function createSessionToken() {
  return "vtt_" + bytesToBase64Url(randomBytes(24));
}

function createTeacherSessionStore(ttlMs = TEACHER_SESSION_TTL_MS) {
  const sessions = new Map();

  const prune = () => {
    const now = Date.now();
    for (const [token, entry] of sessions.entries()) {
      if (!entry || entry.expiresAt <= now) sessions.delete(token);
    }
  };

  return {
    create(meta = {}) {
      prune();
      const token = createSessionToken();
      const expiresAt = Date.now() + ttlMs;
      sessions.set(token, { createdAt: Date.now(), expiresAt, meta });
      return { token, expiresAt };
    },
    get(token) {
      prune();
      const entry = sessions.get(String(token || "").trim());
      if (!entry || entry.expiresAt <= Date.now()) return null;
      return entry;
    },
    destroy(token) {
      sessions.delete(String(token || "").trim());
    }
  };
}

function resolveGoogleConfig(env = {}, deploymentPolicy = null) {
  const clientId = String(env.VIBBIT_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(env.VIBBIT_GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || "").trim();
  const configuredRedirect = String(
    env.VIBBIT_GOOGLE_REDIRECT_URI || env.GOOGLE_REDIRECT_URI || ""
  ).trim();
  const enabled = Boolean(clientId && clientSecret);
  // Dev login defaults off. Hosted policy forbids it; self-hosted needs explicit opt-in.
  const allowDevLogin = deploymentPolicy
    ? Boolean(deploymentPolicy.allowDevLogin)
    : parseBoolean(env.VIBBIT_TEACHER_DEV_LOGIN, false);
  return {
    clientId,
    clientSecret,
    configuredRedirect,
    enabled,
    allowDevLogin
  };
}

function buildGoogleAuthUrl({ clientId, redirectUri, state }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("access_type", "online");
  return url.toString();
}

async function exchangeGoogleCode({ clientId, clientSecret, redirectUri, code }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status})`);
  }
  return response.json();
}

async function fetchGoogleUserInfo(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Google userinfo failed (${response.status})`);
  }
  return response.json();
}

function teacherShell({ title, body, notice = "", error = "" }) {
  const noticeHtml = notice
    ? `<p class="notice">${escapeHtml(notice)}</p>`
    : "";
  const errorHtml = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
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
        --accent-strong: #59b4ff;
        --danger: #ff8f9f;
        --ok: #7dffb2;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font: 16px/1.5 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 10% 0%, #1a2e56 0%, rgba(26, 46, 86, 0) 46%),
          radial-gradient(circle at 100% 100%, #173058 0%, rgba(23, 48, 88, 0) 44%),
          linear-gradient(160deg, var(--bg-2), var(--bg-1));
      }
      main {
        width: min(920px, 94vw);
        margin: 2rem auto 3rem;
        padding: clamp(1.2rem, 2.4vw, 2rem);
        border-radius: 1.1rem;
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: 0 24px 56px rgba(0, 0, 0, 0.36);
      }
      h1 { margin: 0 0 0.35rem; font-size: clamp(1.8rem, 4vw, 2.4rem); }
      h2 { margin: 1.4rem 0 0.5rem; font-size: 1.15rem; }
      p { margin: 0.35rem 0; color: var(--muted); }
      a { color: var(--link); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .top {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .muted { color: var(--muted); }
      .notice, .error {
        margin-top: 0.9rem;
        padding: 0.7rem 0.85rem;
        border-radius: 0.65rem;
        border: 1px solid var(--line);
      }
      .notice { color: var(--ok); background: rgba(125, 255, 178, 0.08); }
      .error { color: var(--danger); background: rgba(255, 143, 159, 0.1); }
      .panel {
        margin-top: 1rem;
        padding: 1rem;
        border-radius: 0.9rem;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(18, 39, 68, 0.8), rgba(13, 28, 50, 0.82));
      }
      label {
        display: grid;
        gap: 0.3rem;
        margin: 0.7rem 0;
        color: var(--muted);
        font-size: 0.95rem;
      }
      input, select, button, textarea {
        font: inherit;
      }
      input, select, textarea {
        width: 100%;
        border-radius: 0.55rem;
        border: 1px solid rgba(126, 200, 255, 0.35);
        background: rgba(8, 18, 34, 0.95);
        color: var(--text);
        padding: 0.55rem 0.7rem;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        align-items: center;
      }
      .actions { margin-top: 0.85rem; }
      button, .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.6rem;
        border: 1px solid transparent;
        padding: 0.55rem 0.85rem;
        font-weight: 600;
        cursor: pointer;
        color: #061a30;
        background: linear-gradient(180deg, var(--accent), var(--accent-strong));
        border-color: rgba(150, 220, 255, 0.45);
      }
      button.secondary, .btn.secondary {
        color: var(--text);
        background: rgba(126, 200, 255, 0.16);
        border-color: rgba(126, 200, 255, 0.4);
      }
      button.danger {
        color: #2a0610;
        background: linear-gradient(180deg, #ffb0bb, #ff8f9f);
      }
      code, .code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        border-radius: 0.4rem;
        padding: 0.12rem 0.34rem;
        background: rgba(8, 18, 34, 0.95);
        border: 1px solid rgba(106, 145, 198, 0.45);
        color: #dbe9ff;
      }
      .code-lg {
        font-size: 1.35rem;
        letter-spacing: 0.12em;
        font-weight: 700;
      }
      .hint { font-size: 0.92rem; }
      .classroom-meta {
        display: grid;
        gap: 0.35rem;
        margin-bottom: 0.6rem;
      }
      @media (max-width: 720px) {
        main { margin-top: 1rem; }
      }
    </style>
  </head>
  <body>
    <main>
      ${body}
      ${noticeHtml}
      ${errorHtml}
    </main>
  </body>
</html>`;
}

function renderLoginPage({ googleEnabled, allowDevLogin, publicOrigin, notice = "", error = "" }) {
  const googleBlock = googleEnabled
    ? `<p><a class="btn" href="/teacher/auth/google">Continue with Google</a></p>`
    : `<p class="hint">Google sign-in is not configured on this server. Set <code>VIBBIT_GOOGLE_CLIENT_ID</code> and <code>VIBBIT_GOOGLE_CLIENT_SECRET</code> to enable it (required for hosted mode).</p>`;

  const devBlock = allowDevLogin
    ? `
      <div class="panel">
        <h2>Local teacher login</h2>
        <p class="hint">Self-hosted opt-in only. Set <code>VIBBIT_TEACHER_DEV_LOGIN=true</code>. Forbidden in hosted mode.</p>
        <form method="post" action="/teacher/dev-login">
          <label>Email
            <input type="email" name="email" required placeholder="teacher@school.edu" autocomplete="username" />
          </label>
          <label>Display name (optional)
            <input type="text" name="name" placeholder="Ms Tan" maxlength="120" />
          </label>
          <div class="actions row">
            <button type="submit">Open teacher portal</button>
          </div>
        </form>
      </div>
    `
    : "";

  const body = `
    <div class="top">
      <div>
        <h1>Teacher portal</h1>
        <p>Sign in, add an OpenAI-compatible API key, and mint a classroom code for your students.</p>
      </div>
      <a class="btn secondary" href="/">Back to Vibbit</a>
    </div>
    <div class="panel">
      <h2>Sign in</h2>
      ${googleBlock}
      <p class="hint">Students only need this server URL (<code>${escapeHtml(publicOrigin)}</code>) and your classroom code.</p>
    </div>
    ${devBlock}
    <div class="panel">
      <h2>Compatible endpoints</h2>
      <p class="hint">Any OpenAI-style <code>/v1/chat/completions</code> endpoint works — OpenAI, OpenRouter, Claude-compatible proxies, or <strong>LiteLLM</strong>.</p>
      <p class="hint">Examples: <code>https://api.openai.com/v1</code>, <code>https://openrouter.ai/api/v1</code>, <code>http://localhost:4000/v1</code></p>
    </div>
  `;

  return teacherShell({ title: "Teacher login", body, notice, error });
}

function renderDashboardPage({
  teacher,
  classrooms,
  publicOrigin,
  notice = "",
  error = ""
}) {
  const classroomCards = classrooms.length
    ? classrooms.map((classroom) => `
      <div class="panel">
        <div class="classroom-meta">
          <strong>${escapeHtml(classroom.name)}</strong>
          <div>Classroom code: <span class="code code-lg">${escapeHtml(classroom.code)}</span></div>
          <div class="hint">Students enter URL <code>${escapeHtml(publicOrigin)}</code> + this code in Vibbit Managed mode.</div>
          <div class="hint">Endpoint: <code>${escapeHtml(classroom.apiBaseUrl)}</code> · Model: <code>${escapeHtml(classroom.model)}</code> · Key: ${classroom.hasApiKey ? "saved" : "<span class=\"error\" style=\"display:inline;padding:0;border:0;background:none\">missing</span>"}</div>
        </div>
        <form method="post" action="/teacher/classrooms/${escapeHtml(classroom.id)}">
          <label>Classroom name
            <input type="text" name="name" value="${escapeHtml(classroom.name)}" maxlength="120" required />
          </label>
          <label>API base URL (OpenAI-compatible)
            <input type="url" name="apiBaseUrl" value="${escapeHtml(classroom.apiBaseUrl)}" required />
          </label>
          <label>API key ${classroom.hasApiKey ? "(leave blank to keep current)" : ""}
            <input type="password" name="apiKey" autocomplete="off" placeholder="${classroom.hasApiKey ? "••••••••" : "sk-..."}" />
          </label>
          <label>Model
            <input type="text" name="model" value="${escapeHtml(classroom.model)}" required />
          </label>
          <label class="row" style="display:flex;gap:0.5rem;align-items:center;">
            <input type="checkbox" name="enabled" value="1" ${classroom.enabled ? "checked" : ""} style="width:auto" />
            Classroom enabled
          </label>
          <div class="actions row">
            <button type="submit">Save classroom</button>
          </div>
        </form>
        <form method="post" action="/teacher/classrooms/${escapeHtml(classroom.id)}/rotate" class="actions">
          <button type="submit" class="secondary">Mint new code</button>
        </form>
        <form method="post" action="/teacher/classrooms/${escapeHtml(classroom.id)}/delete" class="actions" onsubmit="return confirm('Delete this classroom code?');">
          <button type="submit" class="danger">Delete classroom</button>
        </form>
      </div>
    `).join("")
    : `<div class="panel"><p>No classrooms yet. Mint one below.</p></div>`;

  const body = `
    <div class="top">
      <div>
        <h1>Teacher portal</h1>
        <p>Signed in as <strong>${escapeHtml(teacher.name || teacher.email)}</strong> (${escapeHtml(teacher.email)})</p>
      </div>
      <div class="row">
        <a class="btn secondary" href="/">Home</a>
        <form method="post" action="/teacher/logout"><button type="submit" class="secondary">Sign out</button></form>
      </div>
    </div>

    <div class="panel">
      <h2>How students connect</h2>
      <p>In Vibbit, choose <strong>Managed</strong>, then enter:</p>
      <p>Server URL: <code>${escapeHtml(publicOrigin)}</code></p>
      <p>Classroom code: the 5-letter code from a classroom below</p>
    </div>

    <h2>Your classrooms</h2>
    ${classroomCards}

    <div class="panel">
      <h2>Mint a classroom</h2>
      <form method="post" action="/teacher/classrooms">
        <label>Classroom name
          <input type="text" name="name" value="My class" maxlength="120" required />
        </label>
        <label>API base URL (OpenAI / Claude-compatible / LiteLLM)
          <input type="url" name="apiBaseUrl" value="${escapeHtml(TEACHER_PORTAL_DEFAULTS.DEFAULT_OPENAI_BASE_URL)}" required />
        </label>
        <label>API key
          <input type="password" name="apiKey" autocomplete="off" required placeholder="sk-..." />
        </label>
        <label>Model
          <input type="text" name="model" value="${escapeHtml(TEACHER_PORTAL_DEFAULTS.DEFAULT_MODEL)}" required />
        </label>
        <div class="actions row">
          <button type="submit">Mint classroom code</button>
        </div>
      </form>
    </div>
  `;

  return teacherShell({ title: "Teacher portal", body, notice, error });
}

async function readFormBody(request) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return request.json();
  }
  const text = await request.text();
  const params = new URLSearchParams(text);
  const body = {};
  for (const [key, value] of params.entries()) {
    body[key] = value;
  }
  return body;
}

function redirectResponse(location, { cookies = [], origin = "", corsHeaders = {} } = {}) {
  const headers = new Headers({
    Location: location,
    ...corsHeaders
  });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

function htmlResponse(status, html, { cookies = [], corsHeaders = {} } = {}) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    ...corsHeaders
  });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(html, { status, headers });
}

export function createTeacherPortal({
  env = {},
  initialState = {},
  persistState,
  respondCorsHeaders = () => ({}),
  deploymentPolicy = null
} = {}) {
  const google = resolveGoogleConfig(env, deploymentPolicy);
  const store = createTeacherPortalStore(sanitiseTeacherPortalState(initialState), {
    persist: persistState
  });
  const sessions = createTeacherSessionStore();
  const oauthStates = new Map();

  const isSecureRequest = (requestUrl) => {
    if (deploymentPolicy && deploymentPolicy.publicOrigin) {
      return String(deploymentPolicy.publicOrigin).startsWith("https://");
    }
    return String(requestUrl.protocol || "").startsWith("https");
  };

  const getTeacherFromRequest = (request) => {
    const cookies = parseCookies(request.headers.get("cookie"));
    const token = cookies[TEACHER_SESSION_COOKIE];
    const session = sessions.get(token);
    if (!session || !session.meta || !session.meta.teacherId) return null;
    return store.getTeacher(session.meta.teacherId);
  };

  const startTeacherSession = (teacher, requestUrl) => {
    const session = sessions.create({ teacherId: teacher.id });
    const secure = isSecureRequest(requestUrl);
    return serializeCookie(TEACHER_SESSION_COOKIE, session.token, {
      maxAgeSeconds: Math.floor(TEACHER_SESSION_TTL_MS / 1000),
      secure
    });
  };

  const clearTeacherSessionCookie = (requestUrl) => clearCookie(TEACHER_SESSION_COOKIE, {
    secure: isSecureRequest(requestUrl)
  });

  const resolveRedirectUri = (publicOrigin) => {
    if (google.configuredRedirect) return google.configuredRedirect;
    const origin = (deploymentPolicy && deploymentPolicy.publicOrigin)
      || publicOrigin
      || "";
    return `${String(origin).replace(/\/+$/, "")}/teacher/auth/google/callback`;
  };

  const handle = async (request, {
    pathname,
    origin,
    publicOrigin,
    requestUrl
  }) => {
    const corsHeaders = respondCorsHeaders(origin) || {};
    const notice = String(requestUrl.searchParams.get("notice") || "").trim();
    const error = String(requestUrl.searchParams.get("error") || "").trim();

    if (pathname === "/teacher" && request.method === "GET") {
      const teacher = getTeacherFromRequest(request);
      if (!teacher) {
        const html = renderLoginPage({
          googleEnabled: google.enabled,
          allowDevLogin: google.allowDevLogin,
          publicOrigin,
          notice,
          error
        });
        return htmlResponse(200, html, { corsHeaders });
      }
      const classrooms = store.listClassroomsForTeacher(teacher.id).map(store.publicClassroomView);
      const html = renderDashboardPage({
        teacher,
        classrooms,
        publicOrigin,
        notice,
        error
      });
      return htmlResponse(200, html, { corsHeaders });
    }

    if (pathname === "/teacher/auth/google" && request.method === "GET") {
      if (!google.enabled) {
        return redirectResponse("/teacher?error=Google%20sign-in%20is%20not%20configured", { corsHeaders });
      }
      const state = bytesToBase64Url(randomBytes(18));
      oauthStates.set(state, { createdAt: Date.now() });
      const redirectUri = resolveRedirectUri(publicOrigin);
      const authUrl = buildGoogleAuthUrl({
        clientId: google.clientId,
        redirectUri,
        state
      });
      const secure = isSecureRequest(requestUrl);
      return redirectResponse(authUrl, {
        cookies: [
          serializeCookie(OAUTH_STATE_COOKIE, state, {
            maxAgeSeconds: 600,
            secure
          })
        ],
        corsHeaders
      });
    }

    if (pathname === "/teacher/auth/google/callback" && request.method === "GET") {
      if (!google.enabled) {
        return redirectResponse("/teacher?error=Google%20sign-in%20is%20not%20configured", { corsHeaders });
      }
      try {
        const code = String(requestUrl.searchParams.get("code") || "").trim();
        const state = String(requestUrl.searchParams.get("state") || "").trim();
        const cookies = parseCookies(request.headers.get("cookie"));
        const expectedState = cookies[OAUTH_STATE_COOKIE];
        if (!code || !state || !expectedState || state !== expectedState || !oauthStates.has(state)) {
          throw new Error("Invalid OAuth state");
        }
        oauthStates.delete(state);

        const redirectUri = resolveRedirectUri(publicOrigin);
        const tokenPayload = await exchangeGoogleCode({
          clientId: google.clientId,
          clientSecret: google.clientSecret,
          redirectUri,
          code
        });
        const accessToken = String(tokenPayload.access_token || "").trim();
        if (!accessToken) throw new Error("Missing Google access token");
        const profile = await fetchGoogleUserInfo(accessToken);
        const email = String(profile.email || "").trim().toLowerCase();
        const subject = String(profile.sub || email).trim();
        if (!email || !subject) throw new Error("Google account did not return an email");

        const teacher = await store.upsertTeacher({
          id: createTeacherId("google", subject),
          email,
          name: String(profile.name || "").trim(),
          picture: String(profile.picture || "").trim(),
          provider: "google"
        });
        const sessionCookie = startTeacherSession(teacher, requestUrl);
        const secure = isSecureRequest(requestUrl);
        return redirectResponse("/teacher?notice=Signed%20in%20with%20Google", {
          cookies: [
            sessionCookie,
            clearCookie(OAUTH_STATE_COOKIE, { secure })
          ],
          corsHeaders
        });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Google sign-in failed");
        return redirectResponse(`/teacher?error=${message}`, {
          cookies: [clearCookie(OAUTH_STATE_COOKIE, { secure: isSecureRequest(requestUrl) })],
          corsHeaders
        });
      }
    }

    if (pathname === "/teacher/dev-login" && request.method === "POST") {
      if (!google.allowDevLogin) {
        return redirectResponse("/teacher?error=Local%20teacher%20login%20is%20disabled", { corsHeaders });
      }
      try {
        const body = await readFormBody(request);
        const email = String(body.email || "").trim().toLowerCase();
        const name = String(body.name || "").trim();
        if (!email || !email.includes("@")) throw new Error("A valid email is required");
        const teacher = await store.upsertTeacher({
          id: createTeacherId("local", email),
          email,
          name: name || email.split("@")[0],
          provider: "local"
        });
        const sessionCookie = startTeacherSession(teacher, requestUrl);
        return redirectResponse("/teacher?notice=Signed%20in", {
          cookies: [sessionCookie],
          corsHeaders
        });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Login failed");
        return redirectResponse(`/teacher?error=${message}`, { corsHeaders });
      }
    }

    if (pathname === "/teacher/logout" && request.method === "POST") {
      const cookies = parseCookies(request.headers.get("cookie"));
      sessions.destroy(cookies[TEACHER_SESSION_COOKIE]);
      return redirectResponse("/teacher?notice=Signed%20out", {
        cookies: [clearTeacherSessionCookie(requestUrl)],
        corsHeaders
      });
    }

    if (pathname === "/teacher/classrooms" && request.method === "POST") {
      const teacher = getTeacherFromRequest(request);
      if (!teacher) return redirectResponse("/teacher?error=Please%20sign%20in", { corsHeaders });
      try {
        const body = await readFormBody(request);
        await store.createClassroom(teacher.id, {
          name: body.name,
          apiBaseUrl: normaliseApiBaseUrl(body.apiBaseUrl),
          apiKey: body.apiKey,
          model: body.model
        });
        return redirectResponse("/teacher?notice=Classroom%20minted", { corsHeaders });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Could not mint classroom");
        return redirectResponse(`/teacher?error=${message}`, { corsHeaders });
      }
    }

    const classroomMatch = pathname.match(/^\/teacher\/classrooms\/([^/]+)(?:\/(rotate|delete))?$/);
    if (classroomMatch && request.method === "POST") {
      const teacher = getTeacherFromRequest(request);
      if (!teacher) return redirectResponse("/teacher?error=Please%20sign%20in", { corsHeaders });
      const classroomId = decodeURIComponent(classroomMatch[1]);
      const action = classroomMatch[2] || "update";
      try {
        if (action === "rotate") {
          await store.rotateClassroomCode(teacher.id, classroomId);
          return redirectResponse("/teacher?notice=New%20classroom%20code%20minted", { corsHeaders });
        }
        if (action === "delete") {
          await store.deleteClassroom(teacher.id, classroomId);
          return redirectResponse("/teacher?notice=Classroom%20deleted", { corsHeaders });
        }
        const body = await readFormBody(request);
        await store.updateClassroom(teacher.id, classroomId, {
          name: body.name,
          apiBaseUrl: body.apiBaseUrl,
          apiKey: body.apiKey,
          model: body.model,
          enabled: body.enabled != null
        });
        return redirectResponse("/teacher?notice=Classroom%20saved", { corsHeaders });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Classroom update failed");
        return redirectResponse(`/teacher?error=${message}`, { corsHeaders });
      }
    }

    return null;
  };

  return {
    handle,
    store,
    googleEnabled: google.enabled,
    allowDevLogin: google.allowDevLogin,
    getStartupLines(listenUrl) {
      const lines = [
        `[Vibbit backend] Teacher portal -> ${(listenUrl || "<your-server-url>")}/teacher`
      ];
      if (google.enabled) {
        lines.push("[Vibbit backend] Teacher Google sign-in enabled");
      } else if (google.allowDevLogin) {
        lines.push("[Vibbit backend] Teacher local/dev login enabled (set Google OAuth env vars for production)");
      }
      lines.push(`[Vibbit backend] Teacher classrooms=${store.countClassrooms()}`);
      return lines;
    }
  };
}
