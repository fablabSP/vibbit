import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASS_CODE_LENGTH,
  createTeacherId,
  createTeacherPortalStore,
  formatClassCode,
  generateClassCode,
  isCredentialProfileReady,
  normaliseApiBaseUrl,
  normaliseClassCode,
  sanitiseTeacherPortalState
} from "./classroom-store.mjs";

test("classroom codes are 10 letters and display with a hyphen", () => {
  const minted = generateClassCode();
  assert.equal(minted.length, CLASS_CODE_LENGTH);
  assert.equal(normaliseClassCode("abcde-fghij"), "ABCDEFGHIJ");
  assert.equal(formatClassCode("ABCDEFGHIJ"), "ABCDE-FGHIJ");
  assert.equal(formatClassCode("JOINQ"), "JOINQ");
});

const teacherA = {
  id: "local:teacher-a@school.edu",
  email: "teacher-a@school.edu",
  name: "Teacher A",
  provider: "local",
  createdAt: "2026-01-01T00:00:00.000Z"
};

const teacherB = {
  id: "local:teacher-b@school.edu",
  email: "teacher-b@school.edu",
  name: "Teacher B",
  provider: "local",
  createdAt: "2026-01-02T00:00:00.000Z"
};

test("sanitiseTeacherPortalState migrates legacy classroom credentials into deterministic teacher profiles", () => {
  const input = {
    teachers: {
      [teacherA.id]: teacherA
    },
    classrooms: {
      cls_legacy: {
        id: "cls_legacy",
        teacherId: teacherA.id,
        name: "Legacy class",
        code: "LEGCY",
        apiBaseUrl: "https://litellm.example/v1",
        apiKey: "sk-legacy",
        model: "claude-sonnet",
        enabled: true,
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z"
      }
    }
  };

  const migrated = sanitiseTeacherPortalState(input);
  const classroom = migrated.classrooms.cls_legacy;
  const teacher = migrated.teachers[teacherA.id];
  const profile = migrated.credentialProfiles[classroom.credentialProfileId];

  assert.ok(profile);
  assert.equal(classroom.apiKey, "");
  assert.equal(classroom.credentialProfileId, "cp_migrated_cls_legacy");
  assert.equal(profile.name, "Legacy class");
  assert.equal(profile.provider, "custom");
  assert.equal(profile.customBaseUrl, normaliseApiBaseUrl("https://litellm.example/v1"));
  assert.equal(profile.apiKey, "sk-legacy");
  assert.equal(profile.defaultModel, "claude-sonnet");
  assert.equal(teacher.defaultCredentialProfileId, profile.id);

  const again = sanitiseTeacherPortalState(migrated);
  assert.deepEqual(again, migrated);
});

test("createClassroom rejects cross-teacher credential profile references", async () => {
  const store = createTeacherPortalStore({
    teachers: {
      [teacherA.id]: teacherA,
      [teacherB.id]: teacherB
    },
    credentialProfiles: {
      cp_teacher_a: {
        id: "cp_teacher_a",
        teacherId: teacherA.id,
        name: "Teacher A default",
        provider: "openai",
        apiKey: "sk-a",
        defaultModel: "gpt-4o-mini",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  });

  await assert.rejects(
    () => store.createClassroom(teacherB.id, {
      name: "Wrong owner",
      credentialProfileId: "cp_teacher_a"
    }),
    /Credential profile not found/
  );
});

test("deleteCredentialProfile blocks teacher defaults and classroom references", async () => {
  const store = createTeacherPortalStore({
    teachers: {
      [teacherA.id]: {
        ...teacherA,
        defaultCredentialProfileId: "cp_default"
      }
    },
    credentialProfiles: {
      cp_default: {
        id: "cp_default",
        teacherId: teacherA.id,
        name: "Default profile",
        provider: "openai",
        apiKey: "sk-default",
        defaultModel: "gpt-4o-mini",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      cp_other: {
        id: "cp_other",
        teacherId: teacherA.id,
        name: "Other profile",
        provider: "openai",
        apiKey: "sk-other",
        defaultModel: "gpt-4o-mini",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      }
    },
    classrooms: {
      cls_ref: {
        id: "cls_ref",
        teacherId: teacherA.id,
        name: "Referenced class",
        code: "REFER",
        credentialProfileId: "cp_other",
        enabled: true,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      }
    }
  });

  await assert.rejects(
    () => store.deleteCredentialProfile(teacherA.id, "cp_default"),
    /teacher default/
  );
  await assert.rejects(
    () => store.deleteCredentialProfile(teacherA.id, "cp_other"),
    /Reassign classrooms/
  );
});

test("updateCredentialProfile clears apiKey when provider changes and submitted key is blank", async () => {
  const store = createTeacherPortalStore({
    teachers: {
      [teacherA.id]: teacherA
    },
    credentialProfiles: {
      cp_openai: {
        id: "cp_openai",
        teacherId: teacherA.id,
        name: "OpenAI profile",
        provider: "openai",
        apiKey: "sk-openai",
        defaultModel: "gpt-4o-mini",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  });

  const updated = await store.updateCredentialProfile(teacherA.id, "cp_openai", {
    provider: "gemini"
  });
  assert.equal(updated.provider, "gemini");
  assert.equal(updated.apiKey, "");
  assert.equal(updated.lastTestOk, null);
});

test("upsertTeacher links Google and magic-link identities by verified email", async () => {
  const store = createTeacherPortalStore();
  const googleId = createTeacherId("google", "google-sub-123");
  const first = await store.upsertTeacher({
    id: googleId,
    email: "shared@school.edu",
    name: "Ms Shared",
    provider: "google"
  });
  assert.equal(first.id, googleId);

  const magicId = createTeacherId("magic", "shared@school.edu");
  const second = await store.upsertTeacher({
    id: magicId,
    email: "shared@school.edu",
    name: "Ms Shared",
    provider: "magic"
  });
  assert.equal(second.id, googleId);
  assert.equal(second.provider, "google");
  assert.equal(Object.keys(store.getState().teachers).length, 1);
});

test("createClassroom rejects untested or failed AI accounts", async () => {
  const store = createTeacherPortalStore({
    teachers: {
      [teacherA.id]: {
        ...teacherA,
        defaultCredentialProfileId: "cp_untested"
      }
    },
    credentialProfiles: {
      cp_untested: {
        id: "cp_untested",
        teacherId: teacherA.id,
        name: "Untested",
        provider: "openai",
        apiKey: "sk-untested",
        defaultModel: "gpt-4o-mini",
        lastTestOk: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      cp_failed: {
        id: "cp_failed",
        teacherId: teacherA.id,
        name: "Failed",
        provider: "openai",
        apiKey: "sk-failed",
        defaultModel: "gpt-4o-mini",
        lastTestOk: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      cp_ready: {
        id: "cp_ready",
        teacherId: teacherA.id,
        name: "Ready",
        provider: "openai",
        apiKey: "sk-ready",
        defaultModel: "gpt-4o-mini",
        lastTestOk: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  });

  assert.equal(isCredentialProfileReady(store.getCredentialProfile("cp_untested")), false);
  assert.equal(isCredentialProfileReady(store.getCredentialProfile("cp_failed")), false);
  assert.equal(isCredentialProfileReady(store.getCredentialProfile("cp_ready")), true);

  await assert.rejects(
    () => store.createClassroom(teacherA.id, {
      name: "Blocked",
      credentialProfileId: "cp_untested"
    }),
    /Test the AI account successfully/
  );
  await assert.rejects(
    () => store.createClassroom(teacherA.id, {
      name: "Blocked failed",
      credentialProfileId: "cp_failed"
    }),
    /Test the AI account successfully/
  );

  const classroom = await store.createClassroom(teacherA.id, {
    name: "Allowed",
    credentialProfileId: "cp_ready"
  });
  assert.equal(classroom.name, "Allowed");
  assert.equal(classroom.credentialProfileId, "cp_ready");
});
