import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";
import { JOIN_UNAVAILABLE_MARKER } from "./join-page.mjs";
import { followTeacherForm, getTeacherCsrfToken } from "./teacher-test-helpers.mjs";

function createClassroomRuntime(teacherPortalState = {}) {
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
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });
}

const seededState = {
  teachers: {
    "local:teacher@school.edu": {
      id: "local:teacher@school.edu",
      email: "teacher@school.edu",
      name: "Ms Tan",
      provider: "local",
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  },
  credentialProfiles: {
    prof_join: {
      id: "prof_join",
      teacherId: "local:teacher@school.edu",
      name: "School OpenAI",
      provider: "openai",
      apiKey: "sk-teacher-key",
      customBaseUrl: "",
      defaultModel: "gpt-4o-mini",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  },
  classrooms: {
    cls_join: {
      id: "cls_join",
      teacherId: "local:teacher@school.edu",
      name: "Period 3",
      code: "JOINQ",
      credentialProfileId: "prof_join",
      modelOverride: "",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  },
  retiredClassCodes: {
    RETR1: "2026-01-02T00:00:00.000Z"
  }
};

test("authenticated teacher mutation without csrf fails", async () => {
  const runtime = createClassroomRuntime(seededState);
  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);

  const blocked = await runtime.fetch(new Request("https://example.test/teacher/classrooms", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: login.cookieHeader
    },
    body: new URLSearchParams({
      name: "Another class",
      credentialProfileId: "prof_join",
      modelOverride: ""
    }).toString(),
    redirect: "manual"
  }));
  assert.equal(blocked.status, 303);
  assert.match(blocked.headers.get("location") || "", /error=Invalid%20session%20token/);
});

test("authenticated teacher mutation with csrf succeeds", async () => {
  const runtime = createClassroomRuntime(seededState);
  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);

  const csrfToken = await getTeacherCsrfToken(runtime, login.cookieHeader);
  assert.ok(csrfToken.startsWith("csrf_"));

  const mint = await followTeacherForm(runtime, "/teacher/classrooms", {
    name: "Another class",
    credentialProfileId: "prof_join",
    modelOverride: ""
  }, login.cookieHeader);
  assert.equal(mint.response.status, 303);
  assert.match(mint.response.headers.get("location") || "", /notice=Classroom%20minted/);
});

test("/join/VALID shows classroom code", async () => {
  const runtime = createClassroomRuntime(seededState);
  const response = await runtime.fetch(new Request("https://example.test/join/JOINQ"));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /JOINQ/);
  assert.match(html, /Join this classroom/);
  assert.doesNotMatch(html, new RegExp(JOIN_UNAVAILABLE_MARKER));
});

test("/join/BAD and /join/retired show the same generic unavailable page", async () => {
  const runtime = createClassroomRuntime(seededState);

  const bad = await runtime.fetch(new Request("https://example.test/join/BAD99"));
  assert.equal(bad.status, 200);
  const badHtml = await bad.text();

  const retired = await runtime.fetch(new Request("https://example.test/join/RETR1"));
  assert.equal(retired.status, 200);
  const retiredHtml = await retired.text();

  assert.match(badHtml, new RegExp(JOIN_UNAVAILABLE_MARKER));
  assert.match(retiredHtml, new RegExp(JOIN_UNAVAILABLE_MARKER));
  assert.match(badHtml, /Classroom unavailable/);
  assert.match(retiredHtml, /Classroom unavailable/);
  assert.equal(
    badHtml.match(new RegExp(`${JOIN_UNAVAILABLE_MARKER}[\\s\\S]*`))?.[0],
    retiredHtml.match(new RegExp(`${JOIN_UNAVAILABLE_MARKER}[\\s\\S]*`))?.[0]
  );
});

test("Google callback rejects unverified email", async () => {
  const runtime = createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_GOOGLE_CLIENT_ID: "fake-google-client-id",
      VIBBIT_GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini"
    },
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (target.includes("openidconnect.googleapis.com/v1/userinfo")) {
      return new Response(JSON.stringify({
        sub: "google-user-1",
        email: "teacher@school.edu",
        email_verified: false,
        name: "Ms Tan"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(url);
  };

  try {
    const start = await runtime.fetch(new Request("https://example.test/teacher/auth/google"));
    assert.equal(start.status, 303);
    const setCookie = typeof start.headers.getSetCookie === "function"
      ? start.headers.getSetCookie()
      : [];
    const oauthCookie = setCookie
      .map((item) => String(item).split(";")[0])
      .find((item) => item.startsWith("vibbit_oauth_state="));
    assert.ok(oauthCookie);
    const state = decodeURIComponent(oauthCookie.split("=")[1] || "");

    const callback = await runtime.fetch(new Request(
      `https://example.test/teacher/auth/google/callback?code=fake-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: oauthCookie } }
    ));
    assert.equal(callback.status, 303);
    assert.match(callback.headers.get("location") || "", /error=/);
    assert.match(decodeURIComponent(callback.headers.get("location") || ""), /not verified/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
