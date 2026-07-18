import assert from "node:assert/strict";
import test from "node:test";
import { createDeploymentPolicy } from "./deployment-policy.mjs";
import { createBackendRuntime } from "./runtime.mjs";
import { isEncryptedEnvelope } from "./secret-box.mjs";
import {
  adminProviderKeyAad,
  classroomKeyAad,
  createStateCodec
} from "./state-codec.mjs";

const TEST_KEY_B64 = Buffer.alloc(32, 1).toString("base64url");
const HOSTED_PUBLIC_ORIGIN = "https://vibbit.example";
const HOSTED_ENCRYPTION_PHRASE =
  "Hosted mode requires VIBBIT_CREDENTIAL_ENCRYPTION_KEY (32-byte base64/base64url).";

function hostedEnv(overrides = {}) {
  return {
    VIBBIT_DEPLOYMENT_MODE: "hosted",
    VIBBIT_PUBLIC_ORIGIN: HOSTED_PUBLIC_ORIGIN,
    VIBBIT_GOOGLE_CLIENT_ID: "fake-google-client-id",
    VIBBIT_GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64,
    VIBBIT_CLASSROOM_ENABLED: "true",
    VIBBIT_CLASSROOM_CODE: "LEGACY",
    VIBBIT_CLASSROOM_CODE_AUTO: "false",
    VIBBIT_OPENAI_API_KEY: "server-fallback-key",
    VIBBIT_PROVIDER: "openai",
    VIBBIT_MODEL: "gpt-4o-mini",
    ...overrides
  };
}

function assertThrowsMessage(fn, message) {
  assert.throws(fn, (error) => {
    assert.equal(String(error && error.message), message);
    return true;
  });
}

test("state-codec: teacher classroom apiKey encrypt/decrypt uses classroom AAD", () => {
  const codec = createStateCodec({
    VIBBIT_DEPLOYMENT_MODE: "self-hosted",
    VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64
  });
  const classroomId = "cls_teacher_01";
  const plaintextState = {
    classrooms: {
      [classroomId]: {
        id: classroomId,
        apiKey: "sk-teacher-classroom"
      }
    }
  };

  const encrypted = codec.encryptTeacherPortalState(plaintextState);
  const storedKey = encrypted.classrooms[classroomId].apiKey;

  assert.ok(isEncryptedEnvelope(storedKey));
  assert.equal(
    codec.decryptTeacherPortalState(encrypted).classrooms[classroomId].apiKey,
    "sk-teacher-classroom"
  );
  assert.equal(classroomKeyAad(classroomId), `classroom:${classroomId}:apiKey`);
});

test("state-codec: adminProvider apiKeys encrypt/decrypt per provider AAD", () => {
  const codec = createStateCodec({
    VIBBIT_DEPLOYMENT_MODE: "self-hosted",
    VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64
  });
  const plaintextState = {
    apiKeys: {
      openai: "sk-admin-openai",
      gemini: "sk-admin-gemini"
    }
  };

  const encrypted = codec.encryptAdminProviderState(plaintextState);

  assert.ok(isEncryptedEnvelope(encrypted.apiKeys.openai));
  assert.ok(isEncryptedEnvelope(encrypted.apiKeys.gemini));
  assert.deepEqual(codec.decryptAdminProviderState(encrypted).apiKeys, plaintextState.apiKeys);
  assert.equal(adminProviderKeyAad("openai"), "adminProvider:openai:apiKey");
});

test("state-codec: teacherPortalNeedsMigration is true for plaintext classroom keys", () => {
  const codec = createStateCodec({
    VIBBIT_DEPLOYMENT_MODE: "self-hosted",
    VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64
  });
  const plaintextState = {
    classrooms: {
      cls_plain: {
        id: "cls_plain",
        apiKey: "sk-still-plaintext"
      }
    }
  };
  const encryptedState = codec.encryptTeacherPortalState(plaintextState);

  assert.equal(codec.teacherPortalNeedsMigration(plaintextState), true);
  assert.equal(codec.teacherPortalNeedsMigration(encryptedState), false);
  assert.equal(codec.adminProviderNeedsMigration({ apiKeys: {} }), false);
});

test("createDeploymentPolicy: hosted mode rejects missing encryption key", () => {
  assertThrowsMessage(
    () => createDeploymentPolicy(hostedEnv({ VIBBIT_CREDENTIAL_ENCRYPTION_KEY: "" })),
    HOSTED_ENCRYPTION_PHRASE
  );
});

test("createBackendRuntime: hosted mode rejects missing encryption key", () => {
  assertThrowsMessage(
    () => createBackendRuntime({
      env: hostedEnv({ VIBBIT_CREDENTIAL_ENCRYPTION_KEY: "" })
    }),
    HOSTED_ENCRYPTION_PHRASE
  );
});

test("createBackendRuntime: hosted mode starts with valid encryption key", () => {
  const runtime = createBackendRuntime({
    env: hostedEnv({ VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64 }),
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  assert.equal(runtime.config.deployment.isHosted, true);
});
