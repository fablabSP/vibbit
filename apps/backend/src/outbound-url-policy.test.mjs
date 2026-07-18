import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";
import {
  createOutboundUrlPolicy,
  isBlockedIpAddress
} from "./outbound-url-policy.mjs";

const PUBLIC_DNS_ADDRESS = "203.0.113.10";

/** Documentation-range address; treated as public by the policy. */
const publicDnsLookup = async () => [{ address: PUBLIC_DNS_ADDRESS, family: 4 }];

const privateDnsLookup = async () => [{ address: "10.0.0.5", family: 4 }];

const metadataDnsLookup = async () => [{ address: "169.254.169.254", family: 4 }];

function hostedEnv(overrides = {}) {
  return {
    VIBBIT_DEPLOYMENT_MODE: "hosted",
    VIBBIT_PUBLIC_ORIGIN: "https://vibbit.example",
    VIBBIT_GOOGLE_CLIENT_ID: "fake-google-client-id",
    VIBBIT_GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    VIBBIT_CLASSROOM_ENABLED: "true",
    VIBBIT_CLASSROOM_CODE: "LEGACY",
    VIBBIT_CLASSROOM_CODE_AUTO: "false",
    VIBBIT_OPENAI_API_KEY: "server-fallback-key",
    VIBBIT_PROVIDER: "openai",
    VIBBIT_MODEL: "gpt-4o-mini",
    ...overrides
  };
}

function selfHostedEnv(overrides = {}) {
  return {
    VIBBIT_DEPLOYMENT_MODE: "self-hosted",
    VIBBIT_CLASSROOM_ENABLED: "true",
    VIBBIT_CLASSROOM_CODE: "LEGACY",
    VIBBIT_CLASSROOM_CODE_AUTO: "false",
    VIBBIT_TEACHER_DEV_LOGIN: "true",
    VIBBIT_OPENAI_API_KEY: "server-fallback-key",
    VIBBIT_PROVIDER: "openai",
    VIBBIT_MODEL: "gpt-4o-mini",
    ...overrides
  };
}

const seededTeacher = {
  id: "local:teacher@school.edu",
  email: "teacher@school.edu",
  name: "Ms Tan",
  provider: "local",
  createdAt: "2026-01-01T00:00:00.000Z"
};

async function assertRejectsUrl(policy, url, pattern) {
  await assert.rejects(
    () => policy.assertSafeUrl(url, { purpose: "classroom API base URL" }),
    (error) => {
      assert.match(String(error && error.message), pattern);
      return true;
    }
  );
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

test("rejects http in hosted and default self-hosted", async () => {
  const cases = [
    {
      label: "hosted",
      env: hostedEnv(),
      dnsLookup: publicDnsLookup
    },
    {
      label: "self-hosted default",
      env: selfHostedEnv({ VIBBIT_TEACHER_DEV_LOGIN: undefined }),
      dnsLookup: publicDnsLookup
    }
  ];

  for (const { label, env, dnsLookup } of cases) {
    const policy = createOutboundUrlPolicy(env, { dnsLookup });
    await assertRejectsUrl(policy, "http://api.openai.com/v1", /must use https/i);
    assert.equal(policy.isHosted, label === "hosted");
  }
});

test("rejects userinfo in URL", async () => {
  const policy = createOutboundUrlPolicy(hostedEnv(), { dnsLookup: publicDnsLookup });
  await assertRejectsUrl(
    policy,
    "https://user:secret@api.openai.com/v1",
    /must not include credentials/i
  );
});

test("rejects localhost and metadata hostnames", async () => {
  const policy = createOutboundUrlPolicy(selfHostedEnv(), { dnsLookup: publicDnsLookup });
  const blockedHosts = [
    "https://localhost/v1",
    "https://localhost.localdomain/v1",
    "https://metadata/v1",
    "https://metadata.google.internal/v1"
  ];

  for (const url of blockedHosts) {
    await assertRejectsUrl(policy, url, /host is not allowed/i);
  }
});

test("rejects private and metadata IP literals", async () => {
  const policy = createOutboundUrlPolicy(selfHostedEnv(), { dnsLookup: publicDnsLookup });
  const blockedUrls = [
    "https://127.0.0.1/v1",
    "https://169.254.169.254/v1",
    "https://10.0.0.5/v1",
    "https://192.168.1.20/v1",
    "https://[::1]/v1"
  ];

  for (const url of blockedUrls) {
    await assertRejectsUrl(policy, url, /IP literal|private or local address/i);
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    assert.equal(isBlockedIpAddress(hostname), true, `expected ${hostname} to be blocked`);
  }
});

test("rejects DNS that resolves to private addresses", async () => {
  const policy = createOutboundUrlPolicy(selfHostedEnv(), { dnsLookup: privateDnsLookup });
  await assertRejectsUrl(
    policy,
    "https://innocent-looking.example/v1",
    /resolves to a private or local address/i
  );
});

test("hosted: rejects hosts not on the operator allow-list", async () => {
  const policy = createOutboundUrlPolicy(hostedEnv(), { dnsLookup: publicDnsLookup });
  await assertRejectsUrl(
    policy,
    "https://public-but-unlisted.example/v1",
    /not on the operator allow-list/i
  );
});

test("hosted: allows builtin api.openai.com with public DNS", async () => {
  const policy = createOutboundUrlPolicy(hostedEnv(), { dnsLookup: publicDnsLookup });
  const safe = await policy.assertSafeUrl("https://api.openai.com/v1", {
    purpose: "classroom API base URL"
  });
  assert.equal(safe.hostname, "api.openai.com");
  assert.equal(safe.protocol, "https:");
});

test("hosted: allows custom allow-list entries and wildcard suffixes", async () => {
  const policy = createOutboundUrlPolicy(
    hostedEnv({ VIBBIT_CUSTOM_ENDPOINT_ALLOWLIST: "litellm.example,*.gateway.example" }),
    { dnsLookup: publicDnsLookup }
  );

  for (const url of [
    "https://litellm.example/v1",
    "https://proxy.gateway.example/v1"
  ]) {
    const safe = await policy.assertSafeUrl(url, { purpose: "classroom API base URL" });
    assert.equal(safe.hostname, new URL(url).hostname);
  }
});

test("self-hosted with private endpoints enabled allows http private LAN URLs", async () => {
  const policy = createOutboundUrlPolicy(
    selfHostedEnv({ VIBBIT_ALLOW_PRIVATE_ENDPOINTS: "true" }),
    { dnsLookup: privateDnsLookup }
  );
  const safe = await policy.assertSafeUrl("http://10.0.0.5/v1", {
    purpose: "classroom API base URL"
  });
  assert.equal(safe.hostname, "10.0.0.5");
  assert.equal(safe.protocol, "http:");
  assert.equal(policy.allowPrivateEndpoints, true);
});

test("assertSafeRedirect rejects private redirect targets", async () => {
  const policy = createOutboundUrlPolicy(selfHostedEnv(), { dnsLookup: metadataDnsLookup });
  await assert.rejects(
    () => policy.assertSafeRedirect("https://169.254.169.254/latest/meta-data/", {
      purpose: "classroom API base URL redirect"
    }),
    (error) => {
      assert.match(String(error && error.message), /IP literal|private or local address/i);
      return true;
    }
  );
});

test("integration: teacher mint rejects loopback endpoint and accepts OpenAI", async () => {
  const runtime = createBackendRuntime({
    env: selfHostedEnv(),
    persistTeacherPortalState: async () => {},
    dnsLookup: publicDnsLookup
  });

  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);
  assert.match(login.cookieHeader, /vibbit_teacher_session=/);

  const blockedMint = await followTeacherForm(runtime, "/teacher/classrooms", {
    name: "Blocked class",
    apiBaseUrl: "http://127.0.0.1/v1",
    apiKey: "sk-test",
    model: "gpt-4o-mini"
  }, login.cookieHeader);
  assert.equal(blockedMint.response.status, 303);
  assert.match(
    String(blockedMint.response.headers.get("location") || ""),
    /error=.*(https|IP%20literal|not%20allowed)/i
  );

  const allowedMint = await followTeacherForm(runtime, "/teacher/classrooms", {
    name: "OpenAI class",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-4o-mini"
  }, login.cookieHeader);
  assert.equal(allowedMint.response.status, 303);
  assert.match(
    String(allowedMint.response.headers.get("location") || ""),
    /notice=Classroom%20minted/
  );
});

test("integration: generate with blocked classroom endpoint returns 503 without upstream fetch", async () => {
  const runtime = createBackendRuntime({
    env: selfHostedEnv(),
    teacherPortalState: {
      teachers: { [seededTeacher.id]: seededTeacher },
      classrooms: {
        cls_blocked: {
          id: "cls_blocked",
          teacherId: seededTeacher.id,
          name: "Blocked",
          code: "BLOCK",
          apiBaseUrl: "https://innocent-looking.example/v1",
          apiKey: "sk-classroom",
          model: "gpt-4o-mini",
          enabled: true,
          sessionVersion: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    },
    persistTeacherPortalState: async () => {},
    dnsLookup: privateDnsLookup
  });

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": "BLOCK"
    },
    body: JSON.stringify({ classCode: "BLOCK" })
  }));
  assert.equal(connect.status, 200);
  const connected = await connect.json();
  assert.ok(connected.sessionToken);

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("upstream fetch should not run for blocked endpoints");
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
        request: "Blink an LED"
      })
    }));
    assert.equal(generate.status, 503);
    const body = await generate.json();
    assert.match(String(body.error || ""), /private or local address|not allowed/i);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("integration: hosted seeded classroom with allow-listed endpoint can connect", async () => {
  const runtime = createBackendRuntime({
    env: hostedEnv({ VIBBIT_CUSTOM_ENDPOINT_ALLOWLIST: "litellm.example" }),
    teacherPortalState: {
      teachers: { [seededTeacher.id]: seededTeacher },
      classrooms: {
        cls_hosted: {
          id: "cls_hosted",
          teacherId: seededTeacher.id,
          name: "Hosted class",
          code: "HOST1",
          apiBaseUrl: "https://litellm.example/v1",
          apiKey: "sk-classroom",
          model: "gpt-4o-mini",
          enabled: true,
          sessionVersion: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    },
    persistTeacherPortalState: async () => {},
    dnsLookup: publicDnsLookup
  });

  const connect = await runtime.fetch(new Request("https://vibbit.example/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": "HOST1"
    },
    body: JSON.stringify({ classCode: "HOST1" })
  }));
  assert.equal(connect.status, 200);
  const body = await connect.json();
  assert.equal(body.ok, true);
  assert.ok(body.sessionToken);
});
