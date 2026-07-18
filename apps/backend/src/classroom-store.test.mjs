import assert from "node:assert/strict";
import test from "node:test";
import {
  createTeacherPortalStore,
  normaliseApiBaseUrl,
  sanitiseTeacherPortalState
} from "./classroom-store.mjs";

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
