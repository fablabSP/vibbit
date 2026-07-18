const CLASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CLASS_CODE_LENGTH = 5;
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

export function normaliseApiBaseUrl(value) {
  let url = String(value || "").trim();
  if (!url) return DEFAULT_OPENAI_BASE_URL;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_OPENAI_BASE_URL;
    }
    let path = parsed.pathname.replace(/\/+$/, "");
    if (!path || path === "/") {
      path = "/v1";
    } else if (!/\/v\d+$/i.test(path) && !/\/chat\/completions$/i.test(path)) {
      // Allow bare hosts and LiteLLM roots; default to /v1 OpenAI-compatible path.
      path = `${path}/v1`.replace(/\/{2,}/g, "/");
    }
    parsed.pathname = path;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_OPENAI_BASE_URL;
  }
}

export function createEmptyTeacherPortalState() {
  return {
    teachers: {},
    classrooms: {},
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
    createdAt: String(source.createdAt || "").trim() || new Date().toISOString(),
    lastLoginAt: String(source.lastLoginAt || "").trim() || ""
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
    apiBaseUrl: normaliseApiBaseUrl(source.apiBaseUrl || DEFAULT_OPENAI_BASE_URL),
    apiKey,
    model: String(source.model || DEFAULT_MODEL).trim().slice(0, 160) || DEFAULT_MODEL,
    enabled: source.enabled !== false,
    sessionVersion: parseSessionVersion(source.sessionVersion),
    createdAt: String(source.createdAt || "").trim() || new Date().toISOString(),
    updatedAt: String(source.updatedAt || "").trim() || new Date().toISOString()
  };
}

export function sanitiseTeacherPortalState(input) {
  const source = input && typeof input === "object" ? input : {};
  const teachers = {};
  const classrooms = {};

  const sourceTeachers = source.teachers && typeof source.teachers === "object" ? source.teachers : {};
  for (const value of Object.values(sourceTeachers)) {
    const teacher = sanitiseTeacher(value);
    if (teacher) teachers[teacher.id] = teacher;
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

  return {
    teachers,
    classrooms,
    retiredClassCodes: sanitiseRetiredClassCodes(source.retiredClassCodes)
  };
}

export function createTeacherPortalStore(initialState = {}, { persist } = {}) {
  let state = sanitiseTeacherPortalState(initialState);
  const persistState = typeof persist === "function"
    ? persist
    : (() => Promise.resolve());

  const save = async () => {
    await persistState(state);
  };

  const upsertTeacher = async (teacherInput) => {
    const teacher = sanitiseTeacher({
      ...teacherInput,
      lastLoginAt: new Date().toISOString(),
      createdAt: (state.teachers[teacherInput && teacherInput.id] && state.teachers[teacherInput.id].createdAt)
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

  const listClassroomsForTeacher = (teacherId) => {
    const id = String(teacherId || "").trim();
    return Object.values(state.classrooms)
      .filter((classroom) => classroom.teacherId === id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  };

  const findClassroomByCode = (code) => {
    const normalised = normaliseClassCode(code);
    if (!normalised) return null;
    return Object.values(state.classrooms).find((classroom) => (
      classroom.enabled && classroom.code === normalised
    )) || null;
  };

  const getClassroom = (classroomId) => state.classrooms[String(classroomId || "").trim()] || null;

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

  const createClassroom = async (teacherId, input = {}) => {
    const teacher = getTeacher(teacherId);
    if (!teacher) throw new Error("Teacher not found");

    const id = createClassroomId();
    const code = normaliseClassCode(input.code) || mintUniqueCode();
    if (isCodeTaken(code)) throw new Error("Classroom code already in use");

    const classroom = sanitiseClassroom({
      id,
      teacherId: teacher.id,
      name: input.name || "Classroom",
      code,
      apiBaseUrl: input.apiBaseUrl || DEFAULT_OPENAI_BASE_URL,
      apiKey: input.apiKey || "",
      model: input.model || DEFAULT_MODEL,
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

    const nextEnabled = input.enabled != null
      ? (input.enabled !== false && input.enabled !== "false")
      : existing.enabled;
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
      apiBaseUrl: input.apiBaseUrl != null ? input.apiBaseUrl : existing.apiBaseUrl,
      apiKey: input.apiKey != null && String(input.apiKey).trim()
        ? input.apiKey
        : existing.apiKey,
      model: input.model != null ? input.model : existing.model,
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
    return {
      id: classroom.id,
      name: classroom.name,
      code: classroom.code,
      apiBaseUrl: classroom.apiBaseUrl,
      model: classroom.model,
      enabled: classroom.enabled,
      hasApiKey: Boolean(classroom.apiKey),
      createdAt: classroom.createdAt,
      updatedAt: classroom.updatedAt
    };
  };

  return {
    getState: () => state,
    upsertTeacher,
    getTeacher,
    listClassroomsForTeacher,
    findClassroomByCode,
    getClassroom,
    createClassroom,
    updateClassroom,
    rotateClassroomCode,
    deleteClassroom,
    publicClassroomView,
    countClassrooms: () => Object.keys(state.classrooms).length
  };
}

export const TEACHER_PORTAL_DEFAULTS = {
  CLASS_CODE_LENGTH,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_MODEL
};
