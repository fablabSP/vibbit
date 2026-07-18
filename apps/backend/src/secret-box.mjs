/**
 * AES-256-GCM credential encryption for persisted Vibbit state.
 * Envelope: v1.<aadTag>.<iv>.<ciphertext>.<tag> (base64url parts)
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_PREFIX = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

export function isEncryptedEnvelope(value) {
  const text = String(value || "");
  return text.startsWith(`${ENVELOPE_PREFIX}.`);
}

export function parseEncryptionKey(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const candidates = [
    () => Buffer.from(text, "base64url"),
    () => Buffer.from(text, "base64")
  ];

  for (const decode of candidates) {
    try {
      const key = decode();
      if (key.length === KEY_BYTES) return key;
    } catch {
      // try next encoding
    }
  }

  throw new Error(
    "VIBBIT_CREDENTIAL_ENCRYPTION_KEY must be base64/base64url that decodes to exactly 32 bytes."
  );
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromBase64Url(text) {
  return Buffer.from(String(text || ""), "base64url");
}

function tryDecryptValidEnvelope(value, key, expectedAad) {
  const parts = String(value || "").split(".");
  if (parts.length !== 5 || parts[0] !== ENVELOPE_PREFIX) return null;
  let aadBuffer;
  let iv;
  let ciphertext;
  let tag;
  try {
    aadBuffer = fromBase64Url(parts[1]);
    iv = fromBase64Url(parts[2]);
    ciphertext = fromBase64Url(parts[3]);
    tag = fromBase64Url(parts[4]);
  } catch {
    return null;
  }
  if (aadBuffer.toString("utf8") !== String(expectedAad || "")) return null;
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || !ciphertext.length) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aadBuffer);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function encryptSecret(plaintext, key, aad = "") {
  const value = String(plaintext ?? "");
  if (!value) return "";
  if (!key || key.length !== KEY_BYTES) {
    throw new Error("Encryption key is not configured");
  }

  // Idempotent only for *valid* envelopes for this key+AAD.
  // Plaintext that merely starts with "v1." is always encrypted.
  if (isEncryptedEnvelope(value) && tryDecryptValidEnvelope(value, key, aad) != null) {
    return value;
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const aadBuffer = Buffer.from(String(aad || ""), "utf8");
  cipher.setAAD(aadBuffer);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    toBase64Url(aadBuffer),
    toBase64Url(iv),
    toBase64Url(ciphertext),
    toBase64Url(tag)
  ].join(".");
}

export function decryptSecret(envelope, key, expectedAad = "") {
  const value = String(envelope ?? "");
  if (!value) return "";
  if (!isEncryptedEnvelope(value)) return value;
  if (!key || key.length !== KEY_BYTES) {
    throw new Error("Encrypted credentials require VIBBIT_CREDENTIAL_ENCRYPTION_KEY");
  }

  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== ENVELOPE_PREFIX) {
    // Looks like an envelope prefix but is not a valid ciphertext — treat as plaintext
    // so teacher-entered keys beginning with "v1." can still be migrated/encrypted.
    return value;
  }

  const [, aadB64, ivB64, ciphertextB64, tagB64] = parts;
  let aadBuffer;
  let iv;
  let ciphertext;
  let tag;
  try {
    aadBuffer = fromBase64Url(aadB64);
    iv = fromBase64Url(ivB64);
    ciphertext = fromBase64Url(ciphertextB64);
    tag = fromBase64Url(tagB64);
  } catch {
    return value;
  }

  const expected = String(expectedAad || "");
  if (aadBuffer.toString("utf8") !== expected) {
    throw new Error("Credential envelope AAD mismatch");
  }
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || !ciphertext.length) {
    // Not a valid envelope; leave as plaintext for migration/encrypt-on-save.
    return value;
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aadBuffer);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new Error("Credential decryption failed");
  }
}

export function createSecretBox(envInput = {}) {
  const env = envInput || {};
  const mode = String(env.VIBBIT_DEPLOYMENT_MODE || "self-hosted").trim().toLowerCase();
  const isHosted = mode === "hosted";
  const rawKey = String(env.VIBBIT_CREDENTIAL_ENCRYPTION_KEY || "").trim();

  let key = null;
  if (rawKey) {
    key = parseEncryptionKey(rawKey);
  } else if (isHosted) {
    throw new Error(
      "Hosted mode requires VIBBIT_CREDENTIAL_ENCRYPTION_KEY (32-byte base64/base64url)."
    );
  }

  return {
    isHosted,
    hasKey: Boolean(key),
    encrypt(plaintext, aad) {
      if (!key) return String(plaintext ?? "");
      return encryptSecret(plaintext, key, aad);
    },
    decrypt(value, aad) {
      if (!key) {
        if (isEncryptedEnvelope(value)) {
          throw new Error("Encrypted credentials require VIBBIT_CREDENTIAL_ENCRYPTION_KEY");
        }
        return String(value ?? "");
      }
      return decryptSecret(value, key, aad);
    }
  };
}
