import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";

function createBaselineRuntime({
  env = {},
  teacherPortalState = {},
  persistTeacherPortalState
} = {}) {
  const persistedStates = [];
  const persist = persistTeacherPortalState || (async (next) => {
    persistedStates.push(structuredClone(next));
  });

  const runtime = createBackendRuntime({
    env: {
      VIBBIT_DEPLOYMENT_MODE: "self-hosted",
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini",
      ...env
    },
    teacherPortalState,
    persistTeacherPortalState: persist,
    // Deterministic public DNS for custom classroom endpoints in tests.
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  return { runtime, persistedStates };
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

async function connectWithCode(runtime, classCode) {
  return runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": classCode
    },
    body: JSON.stringify({ classCode })
  }));
}

function mockUpstreamFetch(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function mockGenerateResponse() {
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
}

const seededTeacherClassroom = {
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
    cls_baseline: {
      id: "cls_baseline",
      teacherId: "local:teacher@school.edu",
      name: "Baseline",
      code: "BASE1",
      apiBaseUrl: "https://litellm.example/v1",
      apiKey: "sk-classroom-plaintext",
      model: "claude-sonnet",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  }
};

test("baseline: dev-login defaults off when Google OAuth env vars are unset", async () => {
  const { runtime } = createBaselineRuntime({
    env: {
      VIBBIT_GOOGLE_CLIENT_ID: "",
      VIBBIT_GOOGLE_CLIENT_SECRET: ""
    }
  });

  assert.equal(runtime.teacherPortal.googleEnabled, false);
  assert.equal(runtime.teacherPortal.allowDevLogin, false);

  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);
  assert.match(String(login.response.headers.get("location") || ""), /error=/);
  assert.equal(login.cookieHeader.includes("vibbit_teacher_session="), false);
});

test("baseline: explicit VIBBIT_TEACHER_DEV_LOGIN enables local teacher login", async () => {
  const { runtime } = createBaselineRuntime({
    env: { VIBBIT_TEACHER_DEV_LOGIN: "true" }
  });

  assert.equal(runtime.teacherPortal.allowDevLogin, true);

  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);
  assert.match(login.cookieHeader, /vibbit_teacher_session=/);
});

test("baseline: legacy VIBBIT_CLASSROOM_CODE still connects when teacher classrooms exist", async () => {
  const { runtime } = createBaselineRuntime({
    teacherPortalState: seededTeacherClassroom
  });

  const connect = await connectWithCode(runtime, "LEGACY");
  assert.equal(connect.status, 200);
  const body = await connect.json();
  assert.equal(body.ok, true);
  assert.ok(body.sessionToken);
});

test("P1-03: classroom sessions reject student model overrides before upstream", async () => {
  const { runtime } = createBaselineRuntime({
    teacherPortalState: seededTeacherClassroom
  });

  const connect = await connectWithCode(runtime, "BASE1");
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  let upstreamCalled = false;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalled = true;
    return mockGenerateResponse();
  });

  try {
    const generate = await runtime.fetch(new Request("https://example.test/vibbit/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connected.sessionToken}`
      },
      body: JSON.stringify({
        target: "microbit",
        request: "Show a heart",
        model: "gpt-4o-override"
      })
    }));
    assert.equal(generate.status, 400);
    const body = await generate.json();
    assert.match(String(body.error || ""), /cannot override/i);
    assert.equal(upstreamCalled, false);
  } finally {
    restoreFetch();
  }
});

test("P1-03: rotated classroom code invalidates an existing student session", async () => {
  const { runtime } = createBaselineRuntime({
    env: { VIBBIT_TEACHER_DEV_LOGIN: "true" },
    teacherPortalState: seededTeacherClassroom
  });

  const connect = await connectWithCode(runtime, "BASE1");
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);

  const rotate = await followTeacherForm(
    runtime,
    "/teacher/classrooms/cls_baseline/rotate",
    {},
    login.cookieHeader
  );
  assert.equal(rotate.response.status, 303);

  const classroom = runtime.teacherPortal.store.getClassroom("cls_baseline");
  assert.ok(classroom);
  assert.notEqual(classroom.code, "BASE1");
  assert.equal(classroom.sessionVersion, 2);

  const oldCodeConnect = await connectWithCode(runtime, "BASE1");
  assert.equal(oldCodeConnect.status, 401);

  let upstreamCalled = false;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalled = true;
    return mockGenerateResponse();
  });
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
    assert.equal(generate.status, 401);
    assert.equal(upstreamCalled, false);

    const reconnect = await connectWithCode(runtime, classroom.code);
    assert.equal(reconnect.status, 200);
  } finally {
    restoreFetch();
  }
});

test("baseline: disabled classroom rejects connect and invalidates existing session generate", async () => {
  const { runtime } = createBaselineRuntime({
    env: { VIBBIT_TEACHER_DEV_LOGIN: "true" },
    teacherPortalState: seededTeacherClassroom
  });

  const connect = await connectWithCode(runtime, "BASE1");
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);

  const disable = await followTeacherForm(
    runtime,
    "/teacher/classrooms/cls_baseline",
    {
      name: "Baseline",
      apiBaseUrl: "https://litellm.example/v1",
      model: "claude-sonnet"
    },
    login.cookieHeader
  );
  assert.equal(disable.response.status, 303);

  const classroom = runtime.teacherPortal.store.getClassroom("cls_baseline");
  assert.equal(classroom.enabled, false);

  const reconnect = await connectWithCode(runtime, "BASE1");
  assert.equal(reconnect.status, 401);
  const reconnectBody = await reconnect.json();
  assert.match(String(reconnectBody.error || ""), /Invalid class code/i);

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
  assert.equal(generate.status, 401);
  const generateBody = await generate.json();
  assert.match(String(generateBody.error || ""), /no longer valid/i);
});

test("baseline: persisted teacher portal state stores credential profile apiKey in plaintext", async () => {
  const persistedStates = [];
  const { runtime } = createBaselineRuntime({
    env: { VIBBIT_TEACHER_DEV_LOGIN: "true" },
    persistTeacherPortalState: async (next) => {
      persistedStates.push(structuredClone(next));
    }
  });

  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);

  const createProfile = await followTeacherForm(runtime, "/teacher/profiles", {
    name: "School OpenAI",
    provider: "openai",
    apiKey: "sk-teacher-plaintext-key",
    defaultModel: "gpt-4o-mini",
    makeDefault: "1"
  }, login.cookieHeader);
  assert.equal(createProfile.response.status, 303);

  const profile = runtime.teacherPortal.store.listCredentialProfilesForTeacher("local:teacher@school.edu")[0];
  assert.ok(profile);

  const mint = await followTeacherForm(runtime, "/teacher/classrooms", {
    name: "Period 3",
    credentialProfileId: profile.id
  }, login.cookieHeader);
  assert.equal(mint.response.status, 303);
  assert.ok(persistedStates.length > 0);

  const latest = persistedStates[persistedStates.length - 1];
  const profiles = Object.values(latest.credentialProfiles || {});
  assert.ok(profiles.length > 0);
  const saved = profiles.find((item) => item.apiKey === "sk-teacher-plaintext-key");
  assert.ok(saved, "expected plaintext apiKey in persisted teacher portal state");
  assert.equal(saved.apiKey, "sk-teacher-plaintext-key");
});
