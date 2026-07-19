import assert from "node:assert/strict";
import test from "node:test";
import {
  createSecretBox,
  decryptSecret,
  encryptSecret,
  isEncryptedEnvelope,
  parseEncryptionKey
} from "./secret-box.mjs";

const TEST_KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);
const TEST_KEY_B64 = TEST_KEY.toString("base64url");

function assertThrowsMessage(fn, message) {
  assert.throws(fn, (error) => {
    assert.equal(String(error && error.message), message);
    return true;
  });
}

test("encrypt/decrypt round trip preserves plaintext", () => {
  const plaintext = "sk-classroom-secret-key";
  const aad = "classroom:cls_123:apiKey";
  const envelope = encryptSecret(plaintext, TEST_KEY, aad);

  assert.ok(isEncryptedEnvelope(envelope));
  assert.equal(decryptSecret(envelope, TEST_KEY, aad), plaintext);
});

test("identical plaintext yields non-deterministic ciphertext", () => {
  const plaintext = "same-secret";
  const aad = "adminProvider:openai:apiKey";
  const first = encryptSecret(plaintext, TEST_KEY, aad);
  const second = encryptSecret(plaintext, TEST_KEY, aad);

  assert.notEqual(first, second);
  assert.equal(decryptSecret(first, TEST_KEY, aad), plaintext);
  assert.equal(decryptSecret(second, TEST_KEY, aad), plaintext);
});

test("wrong key is rejected during decryption", () => {
  const envelope = encryptSecret("secret-value", TEST_KEY, "aad:one");

  assertThrowsMessage(
    () => decryptSecret(envelope, OTHER_KEY, "aad:one"),
    "Credential decryption failed"
  );
});

test("tampered auth tag is rejected", () => {
  const envelope = encryptSecret("secret-value", TEST_KEY, "aad:one");
  const parts = envelope.split(".");
  const tagBytes = Buffer.from(parts[4], "base64url");
  tagBytes[0] ^= 0xff;
  const tamperedEnvelope = [...parts.slice(0, 4), tagBytes.toString("base64url")].join(".");

  assertThrowsMessage(
    () => decryptSecret(tamperedEnvelope, TEST_KEY, "aad:one"),
    "Credential decryption failed"
  );
});

test("swapped AAD is rejected", () => {
  const envelope = encryptSecret("secret-value", TEST_KEY, "classroom:cls_a:apiKey");

  assertThrowsMessage(
    () => decryptSecret(envelope, TEST_KEY, "classroom:cls_b:apiKey"),
    "Credential envelope AAD mismatch"
  );
});

test("isEncryptedEnvelope detects envelopes and never double-encrypts", () => {
  const plaintext = "do-not-wrap-twice";
  const aad = "classroom:cls_dup:apiKey";
  const once = encryptSecret(plaintext, TEST_KEY, aad);
  const twice = encryptSecret(once, TEST_KEY, aad);

  assert.ok(isEncryptedEnvelope(once));
  assert.equal(twice, once);
});

test("empty string stays empty on encrypt and decrypt", () => {
  assert.equal(encryptSecret("", TEST_KEY, "aad"), "");
  assert.equal(decryptSecret("", TEST_KEY, "aad"), "");
  assert.equal(encryptSecret(null, TEST_KEY, "aad"), "");
  assert.equal(decryptSecret(null, TEST_KEY, "aad"), "");
});

test("malformed encryption key is rejected when not 32 bytes", () => {
  const shortKey = Buffer.alloc(16, 9).toString("base64url");

  assertThrowsMessage(
    () => parseEncryptionKey(shortKey),
    "VIBBIT_CREDENTIAL_ENCRYPTION_KEY must be base64/base64url that decodes to exactly 32 bytes."
  );
});

test("createSecretBox: hosted mode requires encryption key", () => {
  assertThrowsMessage(
    () => createSecretBox({ VIBBIT_DEPLOYMENT_MODE: "hosted" }),
    "Hosted mode requires VIBBIT_CREDENTIAL_ENCRYPTION_KEY (32-byte base64/base64url)."
  );
});

test("createSecretBox: self-hosted without key passes through plaintext", () => {
  const box = createSecretBox({ VIBBIT_DEPLOYMENT_MODE: "self-hosted" });

  assert.equal(box.hasKey, false);
  assert.equal(box.encrypt("plain-key", "aad"), "plain-key");
  assert.equal(box.decrypt("plain-key", "aad"), "plain-key");
});

test("createSecretBox: valid hosted key enables encryption", () => {
  const box = createSecretBox({
    VIBBIT_DEPLOYMENT_MODE: "hosted",
    VIBBIT_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64
  });
  const aad = "classroom:cls_hosted:apiKey";
  const envelope = box.encrypt("sk-hosted", aad);

  assert.equal(box.hasKey, true);
  assert.ok(isEncryptedEnvelope(envelope));
  assert.equal(box.decrypt(envelope, aad), "sk-hosted");
});

test("parseEncryptionKey accepts base64 and base64url encodings", () => {
  const fromBase64Url = parseEncryptionKey(TEST_KEY_B64);
  const fromBase64 = parseEncryptionKey(TEST_KEY.toString("base64"));

  assert.deepEqual(fromBase64Url, TEST_KEY);
  assert.deepEqual(fromBase64, TEST_KEY);
});
