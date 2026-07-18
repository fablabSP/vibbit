import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";
import { normaliseClassCode } from "./classroom-store.mjs";

const seededTeacher = {
  id: "local:teacher@school.edu",
  email: "teacher@school.edu",
  name: "Ms Tan",
  provider: "local",
  createdAt: "2026-01-01T00:00:00.000Z"
};

const seededClassroom = {
  id: "cls_authority",
  teacherId: "local:teacher@school.edu",
  name: "Authority class",
  code: "AUTHS",
  apiBaseUrl: "https://litellm.example/v1",
  apiKey: "sk-classroom-plaintext",
  model: "claude-sonnet",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

function createSessionAuthorityRuntime({
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
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini",
      ...env
    },
    teacherPortalState,
    persistTeacherPortalState: persist,
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

async function teacherLogin(runtime) {
  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: seededTeacher.email,
    name: seededTeacher.name
  });
  assert.equal(login.response.status, 303);
  return login.cookieHeader;
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

async function generateWithSession(runtime, sessionToken, payload) {
  return runtime.fetch(new Request("https://example.test/vibbit/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`
    },
    body: JSON.stringify(payload)
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

function seededPortalState(classrooms) {
  return {
    teachers: {
      [seededTeacher.id]: seededTeacher
    },
    classrooms
  };
}

test("P1-03: migrated classroom without sessionVersion defaults to version 1 and connects", async () => {
  const { runtime } = createSessionAuthorityRuntime({
    teacherPortalState: seededPortalState({
      cls_authority: { ...seededClassroom }
    })
  });

  const classroom = runtime.teacherPortal.store.getClassroom("cls_authority");
  assert.ok(classroom);
  assert.equal(classroom.sessionVersion, 1);

  const connect = await connectWithCode(runtime, "AUTHS");
  assert.equal(connect.status, 200);
  const body = await connect.json();
  assert.equal(body.ok, true);
  assert.ok(body.sessionToken);
});

test("P1-03: rotate bumps sessionVersion, retires old code, and invalidates old sessions", async () => {
  const { runtime } = createSessionAuthorityRuntime({
    teacherPortalState: seededPortalState({
      cls_authority: seededClassroom
    })
  });

  const connect = await connectWithCode(runtime, "AUTHS");
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  const teacherCookie = await teacherLogin(runtime);
  const rotate = await followTeacherForm(
    runtime,
    "/teacher/classrooms/cls_authority/rotate",
    {},
    teacherCookie
  );
  assert.equal(rotate.response.status, 303);

  const classroom = runtime.teacherPortal.store.getClassroom("cls_authority");
  const storeState = runtime.teacherPortal.store.getState();
  assert.ok(classroom);
  assert.notEqual(classroom.code, "AUTHS");
  assert.equal(classroom.sessionVersion, 2);
  assert.ok(
    storeState.retiredClassCodes[normaliseClassCode("AUTHS")],
    "expected retired old classroom code in store state"
  );

  const oldCodeConnect = await connectWithCode(runtime, "AUTHS");
  assert.equal(oldCodeConnect.status, 401);

  let upstreamCalled = false;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalled = true;
    return mockGenerateResponse();
  });
  try {
    const generate = await generateWithSession(runtime, connected.sessionToken, {
      target: "microbit",
      request: "Show a heart"
    });
    assert.equal(generate.status, 401);
    assert.equal(upstreamCalled, false);

    const reconnect = await connectWithCode(runtime, classroom.code);
    assert.equal(reconnect.status, 200);
  } finally {
    restoreFetch();
  }
});

test("P1-03: disable bumps sessionVersion; re-enable keeps higher version so old sessions stay invalid", async () => {
  const { runtime } = createSessionAuthorityRuntime({
    teacherPortalState: seededPortalState({
      cls_authority: seededClassroom
    })
  });

  const connect = await connectWithCode(runtime, "AUTHS");
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  const teacherCookie = await teacherLogin(runtime);
  const disable = await followTeacherForm(
    runtime,
    "/teacher/classrooms/cls_authority",
    {
      name: seededClassroom.name,
      apiBaseUrl: seededClassroom.apiBaseUrl,
      model: seededClassroom.model
    },
    teacherCookie
  );
  assert.equal(disable.response.status, 303);

  let classroom = runtime.teacherPortal.store.getClassroom("cls_authority");
  assert.equal(classroom.enabled, false);
  assert.equal(classroom.sessionVersion, 2);

  const reconnectWhileDisabled = await connectWithCode(runtime, "AUTHS");
  assert.equal(reconnectWhileDisabled.status, 401);

  let upstreamCalled = false;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalled = true;
    return mockGenerateResponse();
  });
  try {
    const generateWhileDisabled = await generateWithSession(runtime, connected.sessionToken, {
      target: "microbit",
      request: "Show a heart"
    });
    assert.equal(generateWhileDisabled.status, 401);
    assert.equal(upstreamCalled, false);
  } finally {
    restoreFetch();
  }

  const reenable = await followTeacherForm(
    runtime,
    "/teacher/classrooms/cls_authority",
    {
      name: seededClassroom.name,
      apiBaseUrl: seededClassroom.apiBaseUrl,
      model: seededClassroom.model,
      enabled: "1"
    },
    teacherCookie
  );
  assert.equal(reenable.response.status, 303);

  classroom = runtime.teacherPortal.store.getClassroom("cls_authority");
  assert.equal(classroom.enabled, true);
  assert.equal(classroom.sessionVersion, 2, "re-enable must not roll back sessionVersion");

  const restoreFetchAgain = mockUpstreamFetch(async () => {
    upstreamCalled = true;
    return mockGenerateResponse();
  });
  try {
    upstreamCalled = false;
    const generateAfterReenable = await generateWithSession(runtime, connected.sessionToken, {
      target: "microbit",
      request: "Show a heart"
    });
    assert.equal(generateAfterReenable.status, 401);
    assert.equal(upstreamCalled, false);

    const freshConnect = await connectWithCode(runtime, "AUTHS");
    assert.equal(freshConnect.status, 200);
  } finally {
    restoreFetchAgain();
  }
});

test("P1-03: delete retires classroom code and invalidates existing student sessions", async () => {
  const { runtime } = createSessionAuthorityRuntime({
    teacherPortalState: seededPortalState({
      cls_authority: seededClassroom
    })
  });

  const connect = await connectWithCode(runtime, "AUTHS");
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  const teacherCookie = await teacherLogin(runtime);
  const deleted = await followTeacherForm(
    runtime,
    "/teacher/classrooms/cls_authority/delete",
    {},
    teacherCookie
  );
  assert.equal(deleted.response.status, 303);

  const storeState = runtime.teacherPortal.store.getState();
  assert.equal(storeState.classrooms.cls_authority, undefined);
  assert.ok(
    storeState.retiredClassCodes[normaliseClassCode("AUTHS")],
    "expected deleted classroom code to be retired"
  );

  const reconnect = await connectWithCode(runtime, "AUTHS");
  assert.equal(reconnect.status, 401);

  let upstreamCalled = false;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalled = true;
    return mockGenerateResponse();
  });
  try {
    const generate = await generateWithSession(runtime, connected.sessionToken, {
      target: "microbit",
      request: "Show a heart"
    });
    assert.equal(generate.status, 401);
    assert.equal(upstreamCalled, false);
  } finally {
    restoreFetch();
  }
});

test("P1-03: classroom generate without overrides uses the classroom model", async () => {
  const { runtime } = createSessionAuthorityRuntime({
    teacherPortalState: seededPortalState({
      cls_authority: seededClassroom
    })
  });

  const connect = await connectWithCode(runtime, "AUTHS");
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  let seenUrl = "";
  let seenAuth = "";
  let seenModel = "";
  const restoreFetch = mockUpstreamFetch(async (url, init = {}) => {
    seenUrl = String(url);
    seenAuth = String((init.headers && init.headers.Authorization) || "");
    try {
      const parsed = JSON.parse(String(init.body || "{}"));
      seenModel = parsed.model || "";
    } catch {
      seenModel = "";
    }
    return mockGenerateResponse();
  });

  try {
    const generate = await generateWithSession(runtime, connected.sessionToken, {
      target: "microbit",
      request: "Show a heart"
    });
    assert.equal(generate.status, 200);
    const result = await generate.json();
    assert.match(String(result.code || ""), /showIcon/);
    assert.equal(seenUrl, "https://litellm.example/v1/chat/completions");
    assert.equal(seenAuth, "Bearer sk-classroom-plaintext");
    assert.equal(seenModel, "claude-sonnet");
  } finally {
    restoreFetch();
  }
});

test("P1-03: classroom generate with provider override returns 400 and skips upstream", async () => {
  const { runtime } = createSessionAuthorityRuntime({
    teacherPortalState: seededPortalState({
      cls_authority: seededClassroom
    })
  });

  const connect = await connectWithCode(runtime, "AUTHS");
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  let upstreamCalled = false;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalled = true;
    return mockGenerateResponse();
  });

  try {
    const generate = await generateWithSession(runtime, connected.sessionToken, {
      target: "microbit",
      request: "Show a heart",
      provider: "openai",
      model: "gpt-4o-override"
    });
    assert.equal(generate.status, 400);
    const body = await generate.json();
    assert.match(String(body.error || ""), /cannot override/i);
    assert.equal(upstreamCalled, false);
  } finally {
    restoreFetch();
  }
});

test("P1-03: legacy self-hosted class-code session may still override model", async () => {
  const { runtime } = createSessionAuthorityRuntime({
    teacherPortalState: seededPortalState({
      cls_authority: seededClassroom
    })
  });

  const connect = await connectWithCode(runtime, "LEGACY");
  const connected = await connect.json();
  assert.equal(connect.status, 200);

  let seenModel = "";
  const restoreFetch = mockUpstreamFetch(async (_url, init = {}) => {
    try {
      const parsed = JSON.parse(String(init.body || "{}"));
      seenModel = parsed.model || "";
    } catch {
      seenModel = "";
    }
    return mockGenerateResponse();
  });

  try {
    const generate = await generateWithSession(runtime, connected.sessionToken, {
      target: "microbit",
      request: "Show a heart",
      model: "gpt-4o-legacy-override"
    });
    assert.equal(generate.status, 200);
    assert.equal(seenModel, "gpt-4o-legacy-override");
  } finally {
    restoreFetch();
  }
});
