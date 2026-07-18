import assert from "node:assert/strict";
import test from "node:test";
import { createDeploymentPolicy } from "./deployment-policy.mjs";
import { createBackendRuntime } from "./runtime.mjs";
import { isEncryptedEnvelope } from "./secret-box.mjs";
import {
  adminProviderKeyAad,
  classroomKeyAad,
  credentialProfileKeyAad,
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

test("state-codec: credential profile apiKey encrypt/decrypt uses profile AAD", () => {
  const codec = createStateCodec({
    VIBBIT_DEPLOYMENT_MODE: "self-hosted",
    VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64
  });
  const profileId = "cp_teacher_01";
  const plaintextState = {
    credentialProfiles: {
      [profileId]: {
        id: profileId,
        teacherId: "local:teacher@school.edu",
        apiKey: "sk-teacher-classroom"
      }
    }
  };

  const encrypted = codec.encryptTeacherPortalState(plaintextState);
  const storedKey = encrypted.credentialProfiles[profileId].apiKey;

  assert.ok(isEncryptedEnvelope(storedKey));
  assert.equal(
    codec.decryptTeacherPortalState(encrypted).credentialProfiles[profileId].apiKey,
    "sk-teacher-classroom"
  );
  assert.equal(credentialProfileKeyAad(profileId), `credentialProfile:${profileId}:apiKey`);
});

test("state-codec: legacy classroom apiKey still decrypts with classroom AAD", () => {
  const codec = createStateCodec({
    VIBBIT_DEPLOYMENT_MODE: "self-hosted",
    VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64
  });
  const classroomId = "cls_teacher_01";
  const encryptedState = {
    classrooms: {
      [classroomId]: {
        id: classroomId,
        apiKey: codec.secretBox.encrypt("sk-legacy-classroom", classroomKeyAad(classroomId))
      }
    }
  };

  assert.equal(
    codec.decryptTeacherPortalState(encryptedState).classrooms[classroomId].apiKey,
    "sk-legacy-classroom"
  );
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

test("state-codec: teacherPortalNeedsMigration is true for plaintext profile keys and legacy classroom keys", () => {
  const codec = createStateCodec({
    VIBBIT_DEPLOYMENT_MODE: "self-hosted",
    VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64
  });
  const plaintextProfileState = {
    credentialProfiles: {
      cp_plain: {
        id: "cp_plain",
        teacherId: "local:teacher@school.edu",
        apiKey: "sk-still-plaintext"
      }
    }
  };
  const encryptedProfileState = codec.encryptTeacherPortalState(plaintextProfileState);
  const legacyClassroomState = {
    classrooms: {
      cls_plain: {
        id: "cls_plain",
        apiKey: codec.secretBox.encrypt("sk-legacy", classroomKeyAad("cls_plain"))
      }
    }
  };

  assert.equal(codec.teacherPortalNeedsMigration(plaintextProfileState), true);
  assert.equal(codec.teacherPortalNeedsMigration(encryptedProfileState), false);
  assert.equal(codec.teacherPortalNeedsMigration(legacyClassroomState), false);
  assert.equal(codec.adminProviderNeedsMigration({ apiKeys: {} }), false);
});

test("state-codec: plaintext v1. prefix still needs migration", () => {
  const codec = createStateCodec({
    VIBBIT_DEPLOYMENT_MODE: "self-hosted",
    VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64
  });
  const state = {
    credentialProfiles: {
      cp_v1: {
        id: "cp_v1",
        teacherId: "local:teacher@school.edu",
        apiKey: "v1.looks-like-envelope-but-is-plaintext"
      }
    }
  };

  assert.equal(codec.teacherPortalNeedsMigration(state), true);
  const encrypted = codec.encryptTeacherPortalState(state);
  assert.equal(codec.teacherPortalNeedsMigration(encrypted), false);
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
