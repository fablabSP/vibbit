import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";
import { MAKECODE_DEFAULT_ORIGINS } from "./deployment-policy.mjs";

const HOSTED_PUBLIC_ORIGIN = "https://vibbit.example";
const FAKE_GOOGLE_CLIENT_ID = "fake-google-client-id";
const FAKE_GOOGLE_CLIENT_SECRET = "fake-google-client-secret";
// 32-byte key, base64url-encoded for hosted fail-closed tests.
const FAKE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");

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
    cls_hosted: {
      id: "cls_hosted",
      teacherId: "local:teacher@school.edu",
      name: "Hosted class",
      code: "HOST1",
      apiBaseUrl: "https://litellm.example/v1",
      apiKey: "sk-classroom-plaintext",
      model: "claude-sonnet",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  }
};

function assertThrowsWithMessage(fn, phrase) {
  assert.throws(fn, (error) => {
    assert.match(String(error && error.message), new RegExp(phrase, "i"));
    return true;
  });
}

function createHostedRuntime({
  env = {},
  teacherPortalState = {}
} = {}) {
  return createBackendRuntime({
    env: {
      VIBBIT_DEPLOYMENT_MODE: "hosted",
      VIBBIT_PUBLIC_ORIGIN: HOSTED_PUBLIC_ORIGIN,
      VIBBIT_GOOGLE_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
      VIBBIT_GOOGLE_CLIENT_SECRET: FAKE_GOOGLE_CLIENT_SECRET,
      VIBBIT_CREDENTIAL_ENCRYPTION_KEY: FAKE_ENCRYPTION_KEY,
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini",
      VIBBIT_CUSTOM_ENDPOINT_ALLOWLIST: "litellm.example",
      ...env
    },
    teacherPortalState,
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });
}

function createSelfHostedRuntime({
  env = {},
  teacherPortalState = {}
} = {}) {
  return createBackendRuntime({
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
    persistTeacherPortalState: async () => {}
  });
}

async function connectWithCode(runtime, classCode, requestUrl = `${HOSTED_PUBLIC_ORIGIN}/vibbit/connect`) {
  return runtime.fetch(new Request(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": classCode
    },
    body: JSON.stringify({ classCode })
  }));
}

function parseRedirectUriFromGoogleAuth(location) {
  const url = new URL(String(location || ""));
  return decodeURIComponent(url.searchParams.get("redirect_uri") || "");
}

test("hosted startup: missing VIBBIT_PUBLIC_ORIGIN fails closed", () => {
  assertThrowsWithMessage(
    () => createHostedRuntime({ env: { VIBBIT_PUBLIC_ORIGIN: "" } }),
    "Hosted mode requires VIBBIT_PUBLIC_ORIGIN"
  );
});

test("hosted startup: HTTP public origin is rejected", () => {
  assertThrowsWithMessage(
    () => createHostedRuntime({ env: { VIBBIT_PUBLIC_ORIGIN: "http://vibbit.example" } }),
    "VIBBIT_PUBLIC_ORIGIN must use https"
  );
});

test("hosted startup: VIBBIT_TEACHER_DEV_LOGIN=true is forbidden", () => {
  assertThrowsWithMessage(
    () => createHostedRuntime({ env: { VIBBIT_TEACHER_DEV_LOGIN: "true" } }),
    "Hosted mode forbids VIBBIT_TEACHER_DEV_LOGIN"
  );
});

test("hosted startup: Google OAuth credentials are required", () => {
  assertThrowsWithMessage(
    () => createHostedRuntime({
      env: {
        VIBBIT_GOOGLE_CLIENT_ID: "",
        VIBBIT_GOOGLE_CLIENT_SECRET: ""
      }
    }),
    "Hosted mode requires VIBBIT_GOOGLE_CLIENT_ID and VIBBIT_GOOGLE_CLIENT_SECRET"
  );
});

test("hosted startup: missing VIBBIT_CREDENTIAL_ENCRYPTION_KEY fails closed", () => {
  assertThrowsWithMessage(
    () => createHostedRuntime({ env: { VIBBIT_CREDENTIAL_ENCRYPTION_KEY: "" } }),
    "Hosted mode requires VIBBIT_CREDENTIAL_ENCRYPTION_KEY"
  );
});

test("hosted startup: explicit wildcard in VIBBIT_ALLOW_ORIGIN is rejected", () => {
  assertThrowsWithMessage(
    () => createHostedRuntime({ env: { VIBBIT_ALLOW_ORIGIN: "https://evil.test,*" } }),
    "Hosted mode rejects wildcard CORS"
  );
});

test("hosted: forged Host header does not change teacher portal public origin display", async () => {
  const runtime = createHostedRuntime();

  const response = await runtime.fetch(new Request("https://evil.test/teacher", {
    headers: { Host: "evil.test" }
  }));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(HOSTED_PUBLIC_ORIGIN.replace(/\./g, "\\.")));
  assert.doesNotMatch(html, /evil\.test/);
});

test("hosted: Google OAuth redirect uses configured VIBBIT_PUBLIC_ORIGIN", async () => {
  const runtime = createHostedRuntime();

  const response = await runtime.fetch(new Request("https://evil.test/teacher/auth/google", {
    headers: { Host: "evil.test" },
    redirect: "manual"
  }));
  assert.equal(response.status, 303);
  const location = String(response.headers.get("location") || "");
  assert.match(location, /accounts\.google\.com/);
  const redirectUri = parseRedirectUriFromGoogleAuth(location);
  assert.equal(redirectUri, `${HOSTED_PUBLIC_ORIGIN}/teacher/auth/google/callback`);
  assert.doesNotMatch(redirectUri, /evil\.test/);
});

test("hosted: VIBBIT_ALLOW_ORIGIN=* is replaced with MakeCode defaults (not literal wildcard)", () => {
  const runtime = createHostedRuntime({ env: { VIBBIT_ALLOW_ORIGIN: "*" } });
  assert.equal(runtime.config.allowOrigin, MAKECODE_DEFAULT_ORIGINS.join(","));
});

test("hosted: allowed MakeCode origin is echoed in CORS on OPTIONS and /healthz", async () => {
  const runtime = createHostedRuntime();
  const allowedOrigin = MAKECODE_DEFAULT_ORIGINS[0];

  const options = await runtime.fetch(new Request(`${HOSTED_PUBLIC_ORIGIN}/healthz`, {
    method: "OPTIONS",
    headers: { Origin: allowedOrigin }
  }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), allowedOrigin);

  const healthz = await runtime.fetch(new Request(`${HOSTED_PUBLIC_ORIGIN}/healthz`, {
    headers: { Origin: allowedOrigin }
  }));
  assert.equal(healthz.status, 200);
  assert.equal(healthz.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
});

test("hosted: disallowed origin receives no Access-Control-Allow-Origin", async () => {
  const runtime = createHostedRuntime();
  const disallowedOrigin = "https://evil.makecode.test";

  const options = await runtime.fetch(new Request(`${HOSTED_PUBLIC_ORIGIN}/healthz`, {
    method: "OPTIONS",
    headers: { Origin: disallowedOrigin }
  }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), null);

  const healthz = await runtime.fetch(new Request(`${HOSTED_PUBLIC_ORIGIN}/healthz`, {
    headers: { Origin: disallowedOrigin }
  }));
  assert.equal(healthz.status, 200);
  assert.equal(healthz.headers.get("Access-Control-Allow-Origin"), null);
});

test("hosted: legacy VIBBIT_CLASSROOM_CODE cannot connect", async () => {
  const runtime = createHostedRuntime({
    teacherPortalState: seededTeacherClassroom
  });

  const connect = await connectWithCode(runtime, "LEGACY");
  assert.equal(connect.status, 401);
  const body = await connect.json();
  assert.match(String(body.error || ""), /Invalid class code/i);
});

test("hosted: teacher-minted classroom code still connects", async () => {
  const runtime = createHostedRuntime({
    teacherPortalState: seededTeacherClassroom
  });

  const connect = await connectWithCode(runtime, "HOST1");
  assert.equal(connect.status, 200);
  const body = await connect.json();
  assert.equal(body.ok, true);
  assert.ok(body.sessionToken);
});

test("hosted: legacy admin routes return 404 unavailable", async () => {
  const runtime = createHostedRuntime({
    env: { VIBBIT_ADMIN_TOKEN: "secret-admin-token" }
  });
  const unavailable = /Admin panel is unavailable in hosted mode/i;

  const adminGet = await runtime.fetch(new Request(`${HOSTED_PUBLIC_ORIGIN}/admin?admin=secret-admin-token`));
  assert.equal(adminGet.status, 404);
  assert.match(String((await adminGet.json()).error || ""), unavailable);

  const adminStatus = await runtime.fetch(new Request(`${HOSTED_PUBLIC_ORIGIN}/admin/status?admin=secret-admin-token`));
  assert.equal(adminStatus.status, 404);
  assert.match(String((await adminStatus.json()).error || ""), unavailable);

  const adminConfig = await runtime.fetch(new Request(`${HOSTED_PUBLIC_ORIGIN}/admin/config?admin=secret-admin-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openai", apiKey: "sk-test" })
  }));
  assert.equal(adminConfig.status, 404);
  assert.match(String((await adminConfig.json()).error || ""), unavailable);
});

test("self-hosted: explicit VIBBIT_TEACHER_DEV_LOGIN=true and legacy code still work", async () => {
  const runtime = createSelfHostedRuntime({
    env: { VIBBIT_TEACHER_DEV_LOGIN: "true" },
    teacherPortalState: seededTeacherClassroom
  });

  assert.equal(runtime.teacherPortal.allowDevLogin, true);

  const connect = await connectWithCode(runtime, "LEGACY", "https://example.test/vibbit/connect");
  assert.equal(connect.status, 200);
  const body = await connect.json();
  assert.equal(body.ok, true);
  assert.ok(body.sessionToken);
});

test("self-hosted: dev login defaults off without VIBBIT_TEACHER_DEV_LOGIN", () => {
  const runtime = createSelfHostedRuntime({
    env: {
      VIBBIT_GOOGLE_CLIENT_ID: "",
      VIBBIT_GOOGLE_CLIENT_SECRET: ""
    }
  });

  assert.equal(runtime.teacherPortal.allowDevLogin, false);
  assert.equal(runtime.teacherPortal.googleEnabled, false);
});
