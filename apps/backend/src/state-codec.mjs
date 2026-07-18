/**
 * Persist/load codec that encrypts credential fields at rest.
 * Runtime always sees plaintext; disk sees envelopes when a key is configured.
 */

import { createSecretBox, isEncryptedEnvelope } from "./secret-box.mjs";

function cloneJson(value) {
  return structuredClone(value);
}

export function classroomKeyAad(classroomId) {
  return `classroom:${String(classroomId || "").trim()}:apiKey`;
}

export function adminProviderKeyAad(provider) {
  return `adminProvider:${String(provider || "").trim()}:apiKey`;
}

export function createStateCodec(envInput = {}, secretBox = createSecretBox(envInput)) {
  function decryptTeacherPortalState(input) {
    const state = cloneJson(input && typeof input === "object" ? input : {});
    const classrooms = state.classrooms && typeof state.classrooms === "object" ? state.classrooms : {};
    for (const classroom of Object.values(classrooms)) {
      if (!classroom || typeof classroom !== "object") continue;
      const aad = classroomKeyAad(classroom.id);
      classroom.apiKey = secretBox.decrypt(classroom.apiKey || "", aad);
    }
    return state;
  }

  function encryptTeacherPortalState(input) {
    const state = cloneJson(input && typeof input === "object" ? input : {});
    const classrooms = state.classrooms && typeof state.classrooms === "object" ? state.classrooms : {};
    for (const classroom of Object.values(classrooms)) {
      if (!classroom || typeof classroom !== "object") continue;
      const aad = classroomKeyAad(classroom.id);
      const plaintext = String(classroom.apiKey || "");
      classroom.apiKey = plaintext ? secretBox.encrypt(plaintext, aad) : "";
    }
    return state;
  }

  function decryptAdminProviderState(input) {
    const state = cloneJson(input && typeof input === "object" ? input : {});
    const apiKeys = state.apiKeys && typeof state.apiKeys === "object" ? state.apiKeys : {};
    const nextKeys = {};
    for (const [provider, value] of Object.entries(apiKeys)) {
      nextKeys[provider] = secretBox.decrypt(value || "", adminProviderKeyAad(provider));
    }
    state.apiKeys = nextKeys;
    return state;
  }

  function encryptAdminProviderState(input) {
    const state = cloneJson(input && typeof input === "object" ? input : {});
    const apiKeys = state.apiKeys && typeof state.apiKeys === "object" ? state.apiKeys : {};
    const nextKeys = {};
    for (const [provider, value] of Object.entries(apiKeys)) {
      const plaintext = String(value || "");
      nextKeys[provider] = plaintext ? secretBox.encrypt(plaintext, adminProviderKeyAad(provider)) : "";
    }
    state.apiKeys = nextKeys;
    return state;
  }

  function teacherPortalNeedsMigration(input) {
    const classrooms = input && input.classrooms && typeof input.classrooms === "object"
      ? Object.values(input.classrooms)
      : [];
    return classrooms.some((classroom) => {
      const key = classroom && classroom.apiKey ? String(classroom.apiKey) : "";
      return Boolean(key) && !isEncryptedEnvelope(key);
    });
  }

  function adminProviderNeedsMigration(input) {
    const apiKeys = input && input.apiKeys && typeof input.apiKeys === "object"
      ? Object.values(input.apiKeys)
      : [];
    return apiKeys.some((value) => {
      const key = String(value || "");
      return Boolean(key) && !isEncryptedEnvelope(key);
    });
  }

  return {
    secretBox,
    decryptTeacherPortalState,
    encryptTeacherPortalState,
    decryptAdminProviderState,
    encryptAdminProviderState,
    teacherPortalNeedsMigration,
    adminProviderNeedsMigration
  };
}
