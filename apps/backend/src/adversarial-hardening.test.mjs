import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";
import {
  createOutboundUrlPolicy,
  fetchWithPinnedAddresses,
  isBlockedIpAddress
} from "./outbound-url-policy.mjs";
import {
  createRateLimitController
} from "./rate-limit.mjs";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedEnvelope,
  parseEncryptionKey
} from "./secret-box.mjs";
import { createDeploymentPolicy } from "./deployment-policy.mjs";
import { JOIN_UNAVAILABLE_MARKER } from "./join-page.mjs";

const TEST_KEY = Buffer.alloc(32, 3);
const ENCRYPTION_KEY = TEST_KEY.toString("base64url");

test("plaintext beginning with v1. is encrypted rather than treated as an envelope", () => {
  const weirdKey = "v1.looks-like-envelope-but-is-plaintext";
  const aad = "credentialProfile:prof_x:apiKey";
  const envelope = encryptSecret(weirdKey, TEST_KEY, aad);

  assert.ok(isEncryptedEnvelope(envelope));
  assert.notEqual(envelope, weirdKey);
  assert.equal(decryptSecret(envelope, TEST_KEY, aad), weirdKey);
});

test("valid envelopes stay idempotent on re-encrypt", () => {
  const aad = "credentialProfile:prof_y:apiKey";
  const once = encryptSecret("sk-real", TEST_KEY, aad);
  const twice = encryptSecret(once, TEST_KEY, aad);
  assert.equal(twice, once);
});

test("CGNAT and hex IPv6-mapped addresses are blocked", () => {
  assert.equal(isBlockedIpAddress("100.64.1.2"), true);
  assert.equal(isBlockedIpAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIpAddress("::ffff:7f00:1"), true);
  assert.equal(isBlockedIpAddress("10.0.0.1"), true);
  assert.equal(isBlockedIpAddress("8.8.8.8"), false);
});

test("hosted mode rejects SERVER_APP_TOKEN at runtime boot", () => {
  assert.throws(
    () => createBackendRuntime({
      env: {
        VIBBIT_DEPLOYMENT_MODE: "hosted",
        VIBBIT_PUBLIC_ORIGIN: "https://vibbit.example",
        VIBBIT_GOOGLE_CLIENT_ID: "cid",
        VIBBIT_GOOGLE_CLIENT_SECRET: "secret",
        VIBBIT_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
        SERVER_APP_TOKEN: "legacy-app-token"
      }
    }),
    /Hosted mode rejects SERVER_APP_TOKEN/
  );
});

test("trusted client IP uses the rightmost X-Forwarded-For hop", async () => {
  const runtime = createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "ABCDE",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TRUST_PROXY: "true",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_OPENAI_API_KEY: "server-key",
      VIBBIT_RATE_CONNECT_PER_IP_PER_MIN: "2",
      VIBBIT_RATE_CONNECT_GLOBAL_PER_MIN: "100"
    },
    teacherPortalState: {},
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  for (let i = 0; i < 2; i += 1) {
    const ok = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `198.51.100.1, 203.0.113.50`
      },
      body: JSON.stringify({ classCode: "ABCDE" })
    }));
    assert.equal(ok.status, 200);
  }

  const limited = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Spoofed leftmost hop must not reset the bucket keyed on the proxy peer.
      "X-Forwarded-For": `1.2.3.4, 203.0.113.50`
    },
    body: JSON.stringify({ classCode: "ABCDE" })
  }));
  assert.equal(limited.status, 429);
});

test("/join is rate-limited per IP", async () => {
  const runtime = createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_OPENAI_API_KEY: "server-key",
      VIBBIT_TRUST_PROXY: "true",
      VIBBIT_RATE_JOIN_PER_IP_PER_MIN: "2",
      VIBBIT_RATE_JOIN_GLOBAL_PER_MIN: "100"
    },
    teacherPortalState: {
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
        cls_join: {
          id: "cls_join",
          teacherId: "local:teacher@school.edu",
          name: "Join class",
          code: "JOIN1",
          credentialProfileId: "",
          enabled: true,
          sessionVersion: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    },
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  const first = await runtime.fetch(new Request("https://example.test/join/JOIN1", {
    headers: { "X-Forwarded-For": "203.0.113.9" }
  }));
  const second = await runtime.fetch(new Request("https://example.test/join/JOIN1", {
    headers: { "X-Forwarded-For": "203.0.113.9" }
  }));
  const third = await runtime.fetch(new Request("https://example.test/join/JOIN1", {
    headers: { "X-Forwarded-For": "203.0.113.9" }
  }));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429);
  assert.match(await third.text(), new RegExp(JOIN_UNAVAILABLE_MARKER));
});

test("generate rate limit keys off canonical session.token", async () => {
  const limits = createRateLimitController({
    VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "1",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "1000",
    VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
    VIBBIT_RATE_CONCURRENT_GLOBAL: "20"
  });

  const first = await limits.reserveGenerate({ sessionToken: "sess-a", classroomId: "cls" });
  assert.equal(first.ok, true);
  first.release();

  const second = await limits.reserveGenerate({ sessionToken: "sess-a", classroomId: "cls" });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "generate_session");
});

test("fetchWithPinnedAddresses refuses empty pin sets", async () => {
  await assert.rejects(
    () => fetchWithPinnedAddresses("https://example.test/v1", { method: "GET" }, []),
    /No pinned addresses/
  );
});

test("assertSafeUrl returns pinned public addresses", async () => {
  const policy = createOutboundUrlPolicy(
    { VIBBIT_DEPLOYMENT_MODE: "self-hosted" },
    { dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }] }
  );
  const safe = await policy.assertSafeUrl("https://api.openai.com/v1", {
    purpose: "classroom API base URL"
  });
  assert.deepEqual(safe.addresses, ["8.8.8.8"]);
});

test("magic-link requires VIBBIT_PUBLIC_ORIGIN even in self-hosted mode", () => {
  assert.throws(
    () => createDeploymentPolicy({
      VIBBIT_DEPLOYMENT_MODE: "self-hosted",
      VIBBIT_MAGIC_LINK_ENABLED: "true",
      VIBBIT_MAGIC_LINK_DEV_CAPTURE: "true"
    }),
    /Magic-link sign-in requires VIBBIT_PUBLIC_ORIGIN/
  );
});

test("parseEncryptionKey still accepts base64url keys", () => {
  assert.deepEqual(parseEncryptionKey(ENCRYPTION_KEY), TEST_KEY);
});
