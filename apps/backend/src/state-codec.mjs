/**
 * Persist/load codec that encrypts credential fields at rest.
 * Runtime always sees plaintext; disk sees envelopes when a key is configured.
 */

import { createSecretBox } from "./secret-box.mjs";

function cloneJson(value) {
  return structuredClone(value);
}

export function classroomKeyAad(classroomId) {
  return `classroom:${String(classroomId || "").trim()}:apiKey`;
}

export function credentialProfileKeyAad(profileId) {
  return `credentialProfile:${String(profileId || "").trim()}:apiKey`;
}

export function adminProviderKeyAad(provider) {
  return `adminProvider:${String(provider || "").trim()}:apiKey`;
}

export function createStateCodec(envInput = {}, secretBox = createSecretBox(envInput)) {
  function decryptTeacherPortalState(input) {
    const state = cloneJson(input && typeof input === "object" ? input : {});
    const credentialProfiles = state.credentialProfiles && typeof state.credentialProfiles === "object"
      ? state.credentialProfiles
      : {};
    for (const profile of Object.values(credentialProfiles)) {
      if (!profile || typeof profile !== "object") continue;
      const aad = credentialProfileKeyAad(profile.id);
      profile.apiKey = secretBox.decrypt(profile.apiKey || "", aad);
    }
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
    const credentialProfiles = state.credentialProfiles && typeof state.credentialProfiles === "object"
      ? state.credentialProfiles
      : {};
    for (const profile of Object.values(credentialProfiles)) {
      if (!profile || typeof profile !== "object") continue;
      const aad = credentialProfileKeyAad(profile.id);
      const plaintext = String(profile.apiKey || "");
      profile.apiKey = plaintext ? secretBox.encrypt(plaintext, aad) : "";
    }
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
    const credentialProfiles = input && input.credentialProfiles && typeof input.credentialProfiles === "object"
      ? Object.values(input.credentialProfiles)
      : [];
    const profileNeedsMigration = credentialProfiles.some((profile) => {
      const key = profile && profile.apiKey ? String(profile.apiKey) : "";
      if (!key) return false;
      const aad = credentialProfileKeyAad(profile.id);
      return !secretBox.isValidEnvelope(key, aad);
    });
    if (profileNeedsMigration) return true;

    const classrooms = input && input.classrooms && typeof input.classrooms === "object"
      ? Object.values(input.classrooms)
      : [];
    return classrooms.some((classroom) => {
      const key = classroom && classroom.apiKey ? String(classroom.apiKey) : "";
      if (!key) return false;
      const aad = classroomKeyAad(classroom.id);
      return !secretBox.isValidEnvelope(key, aad);
    });
  }

  function adminProviderNeedsMigration(input) {
    const apiKeys = input && input.apiKeys && typeof input.apiKeys === "object"
      ? Object.entries(input.apiKeys)
      : [];
    return apiKeys.some(([provider, value]) => {
      const key = String(value || "");
      if (!key) return false;
      return !secretBox.isValidEnvelope(key, adminProviderKeyAad(provider));
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
