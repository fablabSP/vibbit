import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";
import { normaliseApiBaseUrl } from "./classroom-store.mjs";

function createClassroomRuntime(teacherPortalState = {}) {
  let savedPortalState = teacherPortalState;
  return createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini"
    },
    teacherPortalState,
    persistTeacherPortalState: async (next) => {
      savedPortalState = next;
    },
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });
}

async function followTeacherForm(runtime, path, body, cookie = "") {
  const response = await runtime.fetch(new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: new URLSearchParams(body).toString(),
    redirect: "manual"
  }));
  const setCookie = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [];
  const cookieHeader = setCookie
    .map((item) => String(item).split(";")[0])
    .filter(Boolean)
    .join("; ");
  return { response, cookieHeader };
}

test("normaliseApiBaseUrl adds /v1 for OpenAI-compatible and LiteLLM roots", () => {
  assert.equal(normaliseApiBaseUrl("https://api.openai.com"), "https://api.openai.com/v1");
  assert.equal(normaliseApiBaseUrl("http://localhost:4000"), "http://localhost:4000/v1");
  assert.equal(normaliseApiBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
});

test("teacher can sign in locally, mint a classroom, and students can connect", async () => {
  const runtime = createClassroomRuntime();

  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);
  assert.match(login.cookieHeader, /vibbit_teacher_session=/);

  const mint = await followTeacherForm(runtime, "/teacher/classrooms", {
    name: "Period 3",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "sk-teacher-key",
    model: "gpt-4o-mini"
  }, login.cookieHeader);
  assert.equal(mint.response.status, 303);

  const dashboard = await runtime.fetch(new Request("https://example.test/teacher", {
    headers: { Cookie: login.cookieHeader }
  }));
  assert.equal(dashboard.status, 200);
  const html = await dashboard.text();
  assert.match(html, /Period 3/);
  assert.match(html, /Classroom code:/);
  const codeMatch = html.match(/class="code code-lg">([A-Z]{5})</);
  assert.ok(codeMatch, "expected minted classroom code in dashboard");
  const classCode = codeMatch[1];

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": classCode
    },
    body: JSON.stringify({ classCode })
  }));
  assert.equal(connect.status, 200);
  const connected = await connect.json();
  assert.equal(connected.ok, true);
  assert.ok(connected.sessionToken);
  assert.equal(connected.defaultModel, "gpt-4o-mini");
});

test("legacy class code still connects when teacher classrooms exist", async () => {
  const runtime = createClassroomRuntime();
  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": "LEGACY"
    },
    body: JSON.stringify({ classCode: "LEGACY" })
  }));
  assert.equal(connect.status, 200);
  const body = await connect.json();
  assert.equal(body.ok, true);
  assert.ok(body.sessionToken);
});

test("teacher classroom generate uses classroom base URL and API key", async () => {
  const runtime = createClassroomRuntime({
    teachers: {
      "local:teacher@school.edu": {
        id: "local:teacher@school.edu",
        email: "teacher@school.edu",
        name: "Ms Tan",
        provider: "local",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    },
    classrooms: {
      cls_demo: {
        id: "cls_demo",
        teacherId: "local:teacher@school.edu",
        name: "Demo",
        code: "ZZZZZ",
        apiBaseUrl: "https://litellm.example/v1",
        apiKey: "sk-classroom",
        model: "claude-sonnet",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  });

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": "ZZZZZ"
    },
    body: JSON.stringify({ classCode: "ZZZZZ" })
  }));
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenAuth = "";
  let seenModel = "";
  globalThis.fetch = async (url, init = {}) => {
    seenUrl = String(url);
    seenAuth = String((init.headers && init.headers.Authorization) || "");
    try {
      const parsed = JSON.parse(String(init.body || "{}"));
      seenModel = parsed.model || "";
    } catch {
      seenModel = "";
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            feedback: ["ok"],
            code: "basic.showIcon(IconNames.Heart)"
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const generate = await runtime.fetch(new Request("https://example.test/vibbit/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connected.sessionToken}`
      },
      body: JSON.stringify({
        target: "microbit",
        request: "Show a heart"
      })
    }));
    assert.equal(generate.status, 200);
    const result = await generate.json();
    assert.match(String(result.code || ""), /showIcon/);
    assert.equal(seenUrl, "https://litellm.example/v1/chat/completions");
    assert.equal(seenAuth, "Bearer sk-classroom");
    assert.equal(seenModel, "claude-sonnet");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("teacher portal page uses relative favicon link", async () => {
  const runtime = createClassroomRuntime();
  const response = await runtime.fetch(new Request("https://example.test/teacher"));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /href="favicon\.svg"/);
  assert.doesNotMatch(body, /href="\/favicon\.svg"/);
});
