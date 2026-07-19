import {
  defaultModelForCredentialProvider,
  inferCredentialProfileFromLegacyEndpoint,
  normaliseCredentialProvider,
  normaliseOpenAiCompatibleBaseUrl,
  providerDisplayName
} from "./provider-registry.mjs";

const CLASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CLASS_CODE_LENGTH = 10;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

function randomBytes(length) {
  const size = Math.max(1, Number(length) || 1);
  const bytes = new Uint8Array(size);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < size; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function normaliseClassCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, CLASS_CODE_LENGTH);
}

export function formatClassCode(value) {
  const code = normaliseClassCode(value);
  if (code.length === CLASS_CODE_LENGTH) {
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  }
  return code;
}

export function isCompleteClassCode(value) {
  return normaliseClassCode(value).length === CLASS_CODE_LENGTH;
}

export function generateClassCode(length = CLASS_CODE_LENGTH) {
  const size = Math.max(CLASS_CODE_LENGTH, Math.min(CLASS_CODE_LENGTH, Number(length) || CLASS_CODE_LENGTH));
  const bytes = randomBytes(size);
  let code = "";
  for (let i = 0; i < size; i += 1) {
    code += CLASS_CODE_ALPHABET[bytes[i] % CLASS_CODE_ALPHABET.length];
  }
  return code;
}

export function createClassroomId() {
  return "cls_" + bytesToBase64Url(randomBytes(12));
}

export function createTeacherId(provider, subject) {
  const safeProvider = String(provider || "local").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "local";
  const safeSubject = String(subject || "").trim().slice(0, 180);
  return `${safeProvider}:${safeSubject}`;
}

export function isCredentialProfileReady(profile) {
  return Boolean(
    profile
    && String(profile.apiKey || "").trim()
    && profile.lastTestOk === true
  );
}

export function normaliseApiBaseUrl(value) {
  return normaliseOpenAiCompatibleBaseUrl(value);
}

export function createCredentialProfileId() {
  return "cp_" + bytesToBase64Url(randomBytes(12));
}

function migratedCredentialProfileIdForClassroom(classroomId) {
  const safeId = String(classroomId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 72);
  return `cp_migrated_${safeId || "legacy"}`;
}

export function createEmptyTeacherPortalState() {
  return {
    teachers: {},
    classrooms: {},
    credentialProfiles: {},
    retiredClassCodes: {}
  };
}

function parseSessionVersion(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(parsed));
}

function sanitiseRetiredClassCodes(input) {
  const source = input && typeof input === "object" ? input : {};
  const retired = {};
  for (const [rawCode, rawAt] of Object.entries(source)) {
    const code = normaliseClassCode(rawCode);
    if (!code) continue;
    const retiredAt = String(rawAt || "").trim() || new Date().toISOString();
    retired[code] = retiredAt;
  }
  return retired;
}

function sanitiseTeacher(input) {
  const source = input && typeof input === "object" ? input : {};
  const id = String(source.id || "").trim().slice(0, 220);
  const email = String(source.email || "").trim().toLowerCase().slice(0, 320);
  if (!id || !email) return null;
  return {
    id,
    email,
    name: String(source.name || "").trim().slice(0, 160),
    picture: String(source.picture || "").trim().slice(0, 1024),
    provider: String(source.provider || "local").trim().slice(0, 40) || "local",
    defaultCredentialProfileId: String(source.defaultCredentialProfileId || "").trim().slice(0, 80),
    createdAt: String(source.createdAt || "").trim() || new Date().toISOString(),
    lastLoginAt: String(source.lastLoginAt || "").trim() || ""
  };
}

function sanitiseCredentialProfile(input) {
  const source = input && typeof input === "object" ? input : {};
  const id = String(source.id || "").trim().slice(0, 80);
  const teacherId = String(source.teacherId || "").trim().slice(0, 220);
  if (!id || !teacherId) return null;
  const provider = normaliseCredentialProvider(source.provider);
  const rawCustomBaseUrl = String(source.customBaseUrl || source.apiBaseUrl || "").trim();
  return {
    id,
    teacherId,
    name: String(source.name || "Credential profile").trim().slice(0, 120) || "Credential profile",
    provider,
    apiKey: String(source.apiKey || "").trim().slice(0, 4096),
    customBaseUrl: provider === "custom" && rawCustomBaseUrl
      ? normaliseApiBaseUrl(rawCustomBaseUrl)
      : "",
    defaultModel: String(source.defaultModel || defaultModelForCredentialProvider(provider))
      .trim()
      .slice(0, 160) || defaultModelForCredentialProvider(provider),
    createdAt: String(source.createdAt || "").trim() || new Date().toISOString(),
    updatedAt: String(source.updatedAt || "").trim() || new Date().toISOString(),
    lastTestedAt: String(source.lastTestedAt || "").trim(),
    lastTestOk: source.lastTestOk == null ? null : source.lastTestOk === true
  };
}

function sanitiseClassroom(input) {
  const source = input && typeof input === "object" ? input : {};
  const id = String(source.id || "").trim().slice(0, 80);
  const teacherId = String(source.teacherId || "").trim().slice(0, 220);
  const code = normaliseClassCode(source.code || "");
  if (!id || !teacherId || !code) return null;
  const apiKey = String(source.apiKey || "").trim().slice(0, 4096);
  return {
    id,
    teacherId,
    name: String(source.name || "Classroom").trim().slice(0, 120) || "Classroom",
    code,
    credentialProfileId: String(source.credentialProfileId || "").trim().slice(0, 80),
    modelOverride: String(source.modelOverride || "").trim().slice(0, 160),
    apiBaseUrl: String(source.apiBaseUrl || "").trim()
      ? normaliseApiBaseUrl(source.apiBaseUrl)
      : "",
    apiKey,
    legacyModel: String(source.model || source.legacyModel || "").trim().slice(0, 160),
    enabled: source.enabled !== false,
    sessionVersion: parseSessionVersion(source.sessionVersion),
    createdAt: String(source.createdAt || "").trim() || new Date().toISOString(),
    updatedAt: String(source.updatedAt || "").trim() || new Date().toISOString()
  };
}

function sortByCreatedAt(a, b) {
  return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

function buildTeacherProfileIndex(credentialProfiles) {
  const profileIdsByTeacher = {};
  for (const profile of Object.values(credentialProfiles || {})) {
    if (!profileIdsByTeacher[profile.teacherId]) profileIdsByTeacher[profile.teacherId] = [];
    profileIdsByTeacher[profile.teacherId].push(profile.id);
  }
  for (const teacherId of Object.keys(profileIdsByTeacher)) {
    profileIdsByTeacher[teacherId].sort((leftId, rightId) => {
      const left = credentialProfiles[leftId];
      const right = credentialProfiles[rightId];
      return sortByCreatedAt(left || {}, right || {});
    });
  }
  return profileIdsByTeacher;
}

function migrateTeacherPortalState({ teachers, classrooms, credentialProfiles, retiredClassCodes }) {
  const nextTeachers = { ...teachers };
  const nextClassrooms = {};
  const nextProfiles = { ...credentialProfiles };

  for (const classroom of Object.values(classrooms)) {
    if (!classroom) continue;
    const nextClassroom = { ...classroom };
    const explicitProfile = nextClassroom.credentialProfileId
      ? nextProfiles[nextClassroom.credentialProfileId]
      : null;
    const hasOwnedExplicitProfile = Boolean(
      explicitProfile && explicitProfile.teacherId === nextClassroom.teacherId
    );
    const legacyApiKey = String(nextClassroom.apiKey || "").trim();

    if (legacyApiKey) {
      const inferred = inferCredentialProfileFromLegacyEndpoint(
        nextClassroom.apiBaseUrl || DEFAULT_OPENAI_BASE_URL
      );
      const profileId = hasOwnedExplicitProfile
        ? explicitProfile.id
        : migratedCredentialProfileIdForClassroom(nextClassroom.id);
      const existingProfile = nextProfiles[profileId];
      const mergedProfile = sanitiseCredentialProfile({
        ...(existingProfile || {}),
        id: profileId,
        teacherId: nextClassroom.teacherId,
        name: (existingProfile && existingProfile.name) || nextClassroom.name,
        provider: (existingProfile && existingProfile.provider) || inferred.provider,
        apiKey: (existingProfile && existingProfile.apiKey) || legacyApiKey,
        customBaseUrl: (existingProfile && existingProfile.customBaseUrl) || inferred.customBaseUrl,
        defaultModel: (existingProfile && existingProfile.defaultModel)
          || nextClassroom.modelOverride
          || nextClassroom.legacyModel
          || defaultModelForCredentialProvider(inferred.provider),
        createdAt: (existingProfile && existingProfile.createdAt) || nextClassroom.createdAt,
        updatedAt: (existingProfile && existingProfile.updatedAt) || nextClassroom.updatedAt,
        // Previously working legacy classroom keys are treated as tested.
        lastTestedAt: (existingProfile && existingProfile.lastTestedAt)
          || nextClassroom.updatedAt
          || nextClassroom.createdAt
          || "",
        lastTestOk: existingProfile && existingProfile.lastTestOk != null
          ? existingProfile.lastTestOk
          : true
      });
      if (mergedProfile) {
        nextProfiles[mergedProfile.id] = mergedProfile;
        nextClassroom.credentialProfileId = mergedProfile.id;
      }
      nextClassroom.apiKey = "";
      nextClassroom.legacyModel = "";
    }

    nextClassrooms[nextClassroom.id] = nextClassroom;
  }

  const profileIdsByTeacher = buildTeacherProfileIndex(nextProfiles);

  for (const teacher of Object.values(nextTeachers)) {
    if (!teacher) continue;
    const defaultProfile = teacher.defaultCredentialProfileId
      ? nextProfiles[teacher.defaultCredentialProfileId]
      : null;
    if (defaultProfile && defaultProfile.teacherId === teacher.id) continue;
    const teacherProfiles = profileIdsByTeacher[teacher.id] || [];
    teacher.defaultCredentialProfileId = teacherProfiles[0] || "";
  }

  for (const classroom of Object.values(nextClassrooms)) {
    if (!classroom) continue;
    const explicitProfile = classroom.credentialProfileId
      ? nextProfiles[classroom.credentialProfileId]
      : null;
    if (classroom.credentialProfileId && (!explicitProfile || explicitProfile.teacherId !== classroom.teacherId)) {
      classroom.credentialProfileId = "";
    }
  }

  return {
    teachers: nextTeachers,
    classrooms: nextClassrooms,
    credentialProfiles: nextProfiles,
    retiredClassCodes
  };
}

export function sanitiseTeacherPortalState(input) {
  const source = input && typeof input === "object" ? input : {};
  const teachers = {};
  const classrooms = {};
  const credentialProfiles = {};

  const sourceTeachers = source.teachers && typeof source.teachers === "object" ? source.teachers : {};
  for (const value of Object.values(sourceTeachers)) {
    const teacher = sanitiseTeacher(value);
    if (teacher) teachers[teacher.id] = teacher;
  }

  const sourceProfiles = source.credentialProfiles && typeof source.credentialProfiles === "object"
    ? source.credentialProfiles
    : {};
  for (const value of Object.values(sourceProfiles)) {
    const profile = sanitiseCredentialProfile(value);
    if (profile && teachers[profile.teacherId]) {
      credentialProfiles[profile.id] = profile;
    } else if (profile && !Object.keys(teachers).length) {
      credentialProfiles[profile.id] = profile;
    }
  }

  const sourceClassrooms = source.classrooms && typeof source.classrooms === "object" ? source.classrooms : {};
  for (const value of Object.values(sourceClassrooms)) {
    const classroom = sanitiseClassroom(value);
    if (classroom && teachers[classroom.teacherId]) {
      classrooms[classroom.id] = classroom;
    } else if (classroom && !Object.keys(teachers).length) {
      // Allow orphan classrooms only when teachers map is empty during migration/tests.
      classrooms[classroom.id] = classroom;
    }
  }

  return migrateTeacherPortalState({
    teachers,
    classrooms,
    credentialProfiles,
    retiredClassCodes: sanitiseRetiredClassCodes(source.retiredClassCodes)
  });
}

export function createTeacherPortalStore(initialState = {}, { persist } = {}) {
  let state = sanitiseTeacherPortalState(initialState);
  const persistState = typeof persist === "function"
    ? persist
    : (() => Promise.resolve());

  const save = async () => {
    await persistState(state);
  };

  const findTeacherByEmail = (email) => {
    const normalised = String(email || "").trim().toLowerCase();
    if (!normalised) return null;
    return Object.values(state.teachers).find((teacher) => teacher.email === normalised) || null;
  };

  const upsertTeacher = async (teacherInput) => {
    const requestedId = String(teacherInput && teacherInput.id || "").trim();
    const email = String(teacherInput && teacherInput.email || "").trim().toLowerCase();
    const byId = requestedId ? state.teachers[requestedId] : null;
    // Only verified Google / magic-link sign-in may reclaim an existing email identity.
    // Local/dev login must never open another teacher's portal by typing their email.
    const mayLinkByEmail = teacherInput && teacherInput.linkByVerifiedEmail === true;
    const byEmail = mayLinkByEmail ? findTeacherByEmail(email) : null;
    if (byId && byEmail && byId.id !== byEmail.id) {
      throw new Error("Teacher identity conflict for this email");
    }
    const existingTeacher = byId || byEmail;
    const teacher = sanitiseTeacher({
      ...existingTeacher,
      ...teacherInput,
      id: existingTeacher ? existingTeacher.id : requestedId,
      email: email || (existingTeacher && existingTeacher.email) || "",
      provider: existingTeacher
        ? existingTeacher.provider
        : (teacherInput && teacherInput.provider),
      name: String(teacherInput && teacherInput.name || "").trim()
        || (existingTeacher && existingTeacher.name)
        || "",
      picture: String(teacherInput && teacherInput.picture || "").trim()
        || (existingTeacher && existingTeacher.picture)
        || "",
      defaultCredentialProfileId: (
        teacherInput && teacherInput.defaultCredentialProfileId
      ) || (existingTeacher && existingTeacher.defaultCredentialProfileId) || "",
      lastLoginAt: new Date().toISOString(),
      createdAt: (existingTeacher && existingTeacher.createdAt)
        || teacherInput.createdAt
        || new Date().toISOString()
    });
    if (!teacher) throw new Error("Invalid teacher record");
    state = {
      ...state,
      teachers: {
        ...state.teachers,
        [teacher.id]: teacher
      }
    };
    await save();
    return teacher;
  };

  const getTeacher = (teacherId) => state.teachers[String(teacherId || "").trim()] || null;

  const getCredentialProfile = (profileId) => state.credentialProfiles[String(profileId || "").trim()] || null;

  const listCredentialProfilesForTeacher = (teacherId) => {
    const id = String(teacherId || "").trim();
    return Object.values(state.credentialProfiles)
      .filter((profile) => profile.teacherId === id)
      .sort(sortByCreatedAt);
  };

  const listClassroomsForTeacher = (teacherId) => {
    const id = String(teacherId || "").trim();
    return Object.values(state.classrooms)
      .filter((classroom) => classroom.teacherId === id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  };

  const getEffectiveCredentialProfileForTeacher = (teacherId, explicitProfileId = "") => {
    const teacher = getTeacher(teacherId);
    if (!teacher) return null;
    const requestedId = String(explicitProfileId || "").trim();
    if (requestedId) {
      const profile = getCredentialProfile(requestedId);
      return profile && profile.teacherId === teacher.id ? profile : null;
    }
    const defaultProfile = teacher.defaultCredentialProfileId
      ? getCredentialProfile(teacher.defaultCredentialProfileId)
      : null;
    return defaultProfile && defaultProfile.teacherId === teacher.id ? defaultProfile : null;
  };

  const getEffectiveCredentialProfileForClassroom = (classroomInput) => {
    const classroom = typeof classroomInput === "string"
      ? getClassroom(classroomInput)
      : classroomInput;
    if (!classroom) return null;
    return getEffectiveCredentialProfileForTeacher(classroom.teacherId, classroom.credentialProfileId);
  };

  const getEffectiveModelForClassroom = (classroomInput) => {
    const classroom = typeof classroomInput === "string"
      ? getClassroom(classroomInput)
      : classroomInput;
    if (!classroom) return "";
    const profile = getEffectiveCredentialProfileForClassroom(classroom);
    return String(
      classroom.modelOverride
      || (profile && profile.defaultModel)
      || (profile ? defaultModelForCredentialProvider(profile.provider) : DEFAULT_MODEL)
    ).trim();
  };

  const findClassroomByCode = (code) => {
    const normalised = normaliseClassCode(code);
    if (!normalised) return null;
    return Object.values(state.classrooms).find((classroom) => (
      classroom.enabled && classroom.code === normalised
    )) || null;
  };

  const getClassroom = (classroomId) => state.classrooms[String(classroomId || "").trim()] || null;

  const ensureTeacherOwnsProfile = (teacherId, profileId) => {
    const requestedId = String(profileId || "").trim();
    if (!requestedId) return null;
    const profile = getCredentialProfile(requestedId);
    if (!profile || profile.teacherId !== String(teacherId || "").trim()) {
      throw new Error("Credential profile not found");
    }
    return profile;
  };

  const ensureEffectiveProfileSelection = (teacherId, requestedProfileId = "") => {
    if (String(requestedProfileId || "").trim()) {
      ensureTeacherOwnsProfile(teacherId, requestedProfileId);
      return;
    }
    const teacher = getTeacher(teacherId);
    if (!teacher || !teacher.defaultCredentialProfileId) {
      throw new Error("Choose a credential profile or set a teacher default first");
    }
    const defaultProfile = getCredentialProfile(teacher.defaultCredentialProfileId);
    if (!defaultProfile || defaultProfile.teacherId !== teacher.id) {
      throw new Error("Teacher default credential profile is missing");
    }
  };

  const isCodeRetired = (code) => {
    const normalised = normaliseClassCode(code);
    return Boolean(normalised && state.retiredClassCodes[normalised]);
  };

  const isCodeTaken = (code, exceptClassroomId = "") => {
    const normalised = normaliseClassCode(code);
    if (!normalised) return false;
    if (isCodeRetired(normalised)) return true;
    return Object.values(state.classrooms).some((classroom) => (
      classroom.code === normalised && classroom.id !== exceptClassroomId
    ));
  };

  const mintUniqueCode = (exceptClassroomId = "") => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const code = generateClassCode();
      if (!isCodeTaken(code, exceptClassroomId)) return code;
    }
    throw new Error("Unable to mint a unique classroom code");
  };

  const retireCode = (code, retiredAt = new Date().toISOString()) => {
    const normalised = normaliseClassCode(code);
    if (!normalised) return state.retiredClassCodes;
    return {
      ...state.retiredClassCodes,
      [normalised]: retiredAt
    };
  };

  const assertCredentialProfileReady = (teacherId, profileId = "") => {
    const profile = getEffectiveCredentialProfileForTeacher(teacherId, profileId);
    if (!profile) {
      throw new Error("Choose a tested AI account before creating a classroom");
    }
    if (!isCredentialProfileReady(profile)) {
      throw new Error("Test the AI account successfully before using it in a classroom");
    }
    return profile;
  };

  const createCredentialProfile = async (teacherId, input = {}) => {
    const teacher = getTeacher(teacherId);
    if (!teacher) throw new Error("Teacher not found");
    const provider = normaliseCredentialProvider(input.provider);
    const profile = sanitiseCredentialProfile({
      id: createCredentialProfileId(),
      teacherId: teacher.id,
      name: input.name || "Credential profile",
      provider,
      apiKey: input.apiKey || "",
      customBaseUrl: provider === "custom" ? input.customBaseUrl || "" : "",
      defaultModel: input.defaultModel || defaultModelForCredentialProvider(provider),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastTestedAt: input.lastTestedAt || "",
      lastTestOk: input.lastTestOk == null ? null : input.lastTestOk === true
    });
    if (!profile) throw new Error("Invalid credential profile");
    if (profile.provider === "custom" && !profile.customBaseUrl) {
      throw new Error("Custom provider requires a custom base URL");
    }
    const shouldBecomeDefault = input.makeDefault === true || input.makeDefault === "1"
      || !teacher.defaultCredentialProfileId;
    if (shouldBecomeDefault && !isCredentialProfileReady(profile)) {
      throw new Error("Test the AI account successfully before setting it as the default");
    }
    const nextTeacher = shouldBecomeDefault
      ? { ...teacher, defaultCredentialProfileId: profile.id }
      : teacher;
    state = {
      ...state,
      credentialProfiles: {
        ...state.credentialProfiles,
        [profile.id]: profile
      },
      teachers: {
        ...state.teachers,
        [teacher.id]: nextTeacher
      }
    };
    await save();
    return profile;
  };

  const updateCredentialProfile = async (teacherId, profileId, input = {}) => {
    const teacher = getTeacher(teacherId);
    const existing = ensureTeacherOwnsProfile(teacherId, profileId);
    if (!teacher || !existing) throw new Error("Credential profile not found");
    const provider = normaliseCredentialProvider(input.provider || existing.provider);
    const providerChanged = input.provider != null
      && normaliseCredentialProvider(input.provider) !== normaliseCredentialProvider(existing.provider);
    const nextApiKey = input.apiKey != null && String(input.apiKey).trim()
      ? String(input.apiKey).trim()
      : (providerChanged ? "" : existing.apiKey);
    const nextCustomBaseUrl = provider === "custom"
      ? (input.customBaseUrl != null ? input.customBaseUrl : existing.customBaseUrl)
      : "";
    const nextDefaultModel = input.defaultModel != null
      ? String(input.defaultModel || "").trim()
      : existing.defaultModel;
    const apiKeyChanged = nextApiKey !== String(existing.apiKey || "");
    const customUrlChanged = provider === "custom"
      && normaliseApiBaseUrl(nextCustomBaseUrl) !== normaliseApiBaseUrl(existing.customBaseUrl || "");
    const modelChanged = nextDefaultModel !== String(existing.defaultModel || "");
    // Provider / key / custom URL / model form the tested tuple.
    const testedTupleChanged = providerChanged || apiKeyChanged || customUrlChanged || modelChanged;
    const profile = sanitiseCredentialProfile({
      ...existing,
      name: input.name != null ? input.name : existing.name,
      provider,
      apiKey: nextApiKey,
      customBaseUrl: nextCustomBaseUrl,
      defaultModel: nextDefaultModel,
      updatedAt: new Date().toISOString(),
      lastTestedAt: input.lastTestedAt != null
        ? input.lastTestedAt
        : (testedTupleChanged ? "" : existing.lastTestedAt),
      lastTestOk: input.lastTestOk != null
        ? input.lastTestOk
        : (testedTupleChanged ? null : existing.lastTestOk)
    });
    if (profile.provider === "custom" && !profile.customBaseUrl) {
      throw new Error("Custom provider requires a custom base URL");
    }
    const makeDefault = input.makeDefault === true || input.makeDefault === "1";
    if (makeDefault && !isCredentialProfileReady(profile)) {
      throw new Error("Test the AI account successfully before setting it as the default");
    }
    const nextTeacher = makeDefault
      ? { ...teacher, defaultCredentialProfileId: profile.id }
      : teacher;
    state = {
      ...state,
      credentialProfiles: {
        ...state.credentialProfiles,
        [profile.id]: profile
      },
      teachers: {
        ...state.teachers,
        [teacher.id]: nextTeacher
      }
    };
    await save();
    return profile;
  };

  const deleteCredentialProfile = async (teacherId, profileId) => {
    const teacher = getTeacher(teacherId);
    const existing = ensureTeacherOwnsProfile(teacherId, profileId);
    if (!teacher || !existing) throw new Error("Credential profile not found");
    if (teacher.defaultCredentialProfileId === existing.id) {
      throw new Error("Reassign the teacher default before deleting this credential profile");
    }
    const referencingClassroom = listClassroomsForTeacher(teacher.id)
      .find((classroom) => classroom.credentialProfileId === existing.id);
    if (referencingClassroom) {
      throw new Error("Reassign classrooms before deleting this credential profile");
    }
    const nextProfiles = { ...state.credentialProfiles };
    delete nextProfiles[existing.id];
    state = {
      ...state,
      credentialProfiles: nextProfiles
    };
    await save();
    return true;
  };

  const createClassroom = async (teacherId, input = {}) => {
    const teacher = getTeacher(teacherId);
    if (!teacher) throw new Error("Teacher not found");
    const requestedProfileId = String(input.credentialProfileId || "").trim();
    ensureEffectiveProfileSelection(teacher.id, requestedProfileId);
    assertCredentialProfileReady(teacher.id, requestedProfileId);

    const id = createClassroomId();
    const code = normaliseClassCode(input.code) || mintUniqueCode();
    if (isCodeTaken(code)) throw new Error("Classroom code already in use");

    const classroom = sanitiseClassroom({
      id,
      teacherId: teacher.id,
      name: input.name || "Classroom",
      code,
      credentialProfileId: requestedProfileId,
      modelOverride: input.modelOverride || "",
      enabled: input.enabled !== false,
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    if (!classroom) throw new Error("Invalid classroom");

    state = {
      ...state,
      classrooms: {
        ...state.classrooms,
        [classroom.id]: classroom
      }
    };
    await save();
    return classroom;
  };

  const updateClassroom = async (teacherId, classroomId, input = {}) => {
    const existing = getClassroom(classroomId);
    if (!existing || existing.teacherId !== String(teacherId || "").trim()) {
      throw new Error("Classroom not found");
    }

    const nextCode = input.code != null ? normaliseClassCode(input.code) : existing.code;
    if (!nextCode) throw new Error("Classroom code is required");
    if (isCodeTaken(nextCode, existing.id)) throw new Error("Classroom code already in use");
    const nextCredentialProfileId = input.credentialProfileId != null
      ? String(input.credentialProfileId || "").trim()
      : existing.credentialProfileId;
    ensureEffectiveProfileSelection(teacherId, nextCredentialProfileId);

    const nextEnabled = input.enabled != null
      ? (input.enabled !== false && input.enabled !== "false")
      : existing.enabled;
    const profileChanged = nextCredentialProfileId !== existing.credentialProfileId;
    const becomingEnabled = !existing.enabled && nextEnabled;
    if (profileChanged || becomingEnabled) {
      assertCredentialProfileReady(teacherId, nextCredentialProfileId);
    }
    const codeChanged = nextCode !== existing.code;
    const becomingDisabled = existing.enabled && !nextEnabled;
    let nextVersion = existing.sessionVersion;
    let nextRetired = state.retiredClassCodes;

    if (codeChanged) {
      nextRetired = retireCode(existing.code);
      nextVersion += 1;
    } else if (becomingDisabled) {
      nextVersion += 1;
    }

    if (input.bumpSessionVersion === true) {
      nextVersion += 1;
    }

    const classroom = sanitiseClassroom({
      ...existing,
      name: input.name != null ? input.name : existing.name,
      code: nextCode,
      credentialProfileId: nextCredentialProfileId,
      modelOverride: input.modelOverride != null ? input.modelOverride : existing.modelOverride,
      enabled: nextEnabled,
      sessionVersion: nextVersion,
      updatedAt: new Date().toISOString()
    });

    state = {
      ...state,
      retiredClassCodes: nextRetired,
      classrooms: {
        ...state.classrooms,
        [classroom.id]: classroom
      }
    };
    await save();
    return classroom;
  };

  const rotateClassroomCode = async (teacherId, classroomId) => {
    const existing = getClassroom(classroomId);
    if (!existing || existing.teacherId !== String(teacherId || "").trim()) {
      throw new Error("Classroom not found");
    }
    const code = mintUniqueCode(existing.id);
    // One atomic save: retire old code, assign new code, bump sessionVersion.
    return updateClassroom(teacherId, classroomId, { code });
  };

  const deleteClassroom = async (teacherId, classroomId) => {
    const existing = getClassroom(classroomId);
    if (!existing || existing.teacherId !== String(teacherId || "").trim()) {
      throw new Error("Classroom not found");
    }
    const nextClassrooms = { ...state.classrooms };
    delete nextClassrooms[existing.id];
    state = {
      ...state,
      retiredClassCodes: retireCode(existing.code),
      classrooms: nextClassrooms
    };
    await save();
    return true;
  };

  const publicClassroomView = (classroom) => {
    if (!classroom) return null;
    const teacher = getTeacher(classroom.teacherId);
    const profile = getEffectiveCredentialProfileForClassroom(classroom);
    const usingTeacherDefault = Boolean(
      !classroom.credentialProfileId
      && teacher
      && teacher.defaultCredentialProfileId
      && profile
      && profile.id === teacher.defaultCredentialProfileId
    );
    return {
      id: classroom.id,
      name: classroom.name,
      code: classroom.code,
      credentialProfileId: classroom.credentialProfileId,
      modelOverride: classroom.modelOverride,
      usingTeacherDefault,
      resolvedCredentialProfileId: profile ? profile.id : "",
      resolvedCredentialProfileName: profile ? profile.name : "",
      resolvedProvider: profile ? profile.provider : "",
      resolvedProviderLabel: profile ? providerDisplayName(profile.provider) : "",
      resolvedCustomBaseUrl: profile && profile.provider === "custom" ? profile.customBaseUrl : "",
      resolvedModel: getEffectiveModelForClassroom(classroom),
      apiBaseUrl: classroom.apiBaseUrl,
      enabled: classroom.enabled,
      hasApiKey: Boolean(profile && profile.apiKey),
      createdAt: classroom.createdAt,
      updatedAt: classroom.updatedAt
    };
  };

  const publicCredentialProfileView = (profile) => {
    if (!profile) return null;
    return {
      id: profile.id,
      teacherId: profile.teacherId,
      name: profile.name,
      provider: profile.provider,
      providerLabel: providerDisplayName(profile.provider),
      customBaseUrl: profile.customBaseUrl,
      defaultModel: profile.defaultModel,
      hasApiKey: Boolean(profile.apiKey),
      ready: isCredentialProfileReady(profile),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      lastTestedAt: profile.lastTestedAt,
      lastTestOk: profile.lastTestOk
    };
  };

  return {
    getState: () => state,
    upsertTeacher,
    findTeacherByEmail,
    getTeacher,
    getCredentialProfile,
    listCredentialProfilesForTeacher,
    getEffectiveCredentialProfileForTeacher,
    getEffectiveCredentialProfileForClassroom,
    getEffectiveModelForClassroom,
    listClassroomsForTeacher,
    findClassroomByCode,
    getClassroom,
    createCredentialProfile,
    updateCredentialProfile,
    deleteCredentialProfile,
    createClassroom,
    updateClassroom,
    rotateClassroomCode,
    deleteClassroom,
    publicClassroomView,
    publicCredentialProfileView,
    countClassrooms: () => Object.keys(state.classrooms).length
  };
}

export { CLASS_CODE_LENGTH };

export const TEACHER_PORTAL_DEFAULTS = {
  CLASS_CODE_LENGTH,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_MODEL
};
