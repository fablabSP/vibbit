import assert from "node:assert/strict";
import test from "node:test";
import {
  createRateLimitController,
  createTokenBucket
} from "./rate-limit.mjs";
import { createBackendRuntime } from "./runtime.mjs";

const seededTeacher = {
  id: "local:teacher@school.edu",
  email: "teacher@school.edu",
  name: "Ms Tan",
  provider: "local",
  createdAt: "2026-01-01T00:00:00.000Z"
};

const seededClassroomA = {
  id: "cls_rate_a",
  teacherId: "local:teacher@school.edu",
  name: "Rate class A",
  code: "RATEA",
  apiBaseUrl: "https://litellm.example/v1",
  apiKey: "sk-classroom-a",
  model: "gpt-4o-mini",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const seededClassroomB = {
  id: "cls_rate_b",
  teacherId: "local:teacher@school.edu",
  name: "Rate class B",
  code: "RATEB",
  apiBaseUrl: "https://litellm.example/v1",
  apiKey: "sk-classroom-b",
  model: "gpt-4o-mini",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

function seededPortalState(classrooms) {
  return {
    teachers: {
      [seededTeacher.id]: seededTeacher
    },
    classrooms
  };
}

function createRateLimitRuntime({
  env = {},
  teacherPortalState = seededPortalState({
    cls_rate_a: seededClassroomA
  }),
  now,
  persistDailyUsage,
  loadDailyUsage,
  persistUsageState,
  rateLimits
} = {}) {
  return createBackendRuntime({
    env: {
      VIBBIT_DEPLOYMENT_MODE: "self-hosted",
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_TRUST_PROXY: "true",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini",
      ...env
    },
    teacherPortalState,
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }],
    ...(typeof now === "function" ? { now } : {}),
    ...(typeof persistDailyUsage === "function" ? { persistDailyUsage } : {}),
    ...(typeof loadDailyUsage === "function" ? { loadDailyUsage } : {}),
    ...(typeof persistUsageState === "function" ? { persistUsageState } : {}),
    ...(rateLimits ? { rateLimits } : {})
  });
}

async function connectWithIp(runtime, classCode, clientIp) {
  return runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": classCode,
      "X-Forwarded-For": clientIp
    },
    body: JSON.stringify({ classCode })
  }));
}

async function connectWithCode(runtime, classCode) {
  return connectWithIp(runtime, classCode, "198.51.100.10");
}

async function generateWithSession(runtime, sessionToken, payload = {
  target: "microbit",
  request: "Show a heart"
}) {
  return runtime.fetch(new Request("https://example.test/vibbit/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`
    },
    body: JSON.stringify(payload)
  }));
}

function mockUpstreamFetch(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function mockGenerateResponse() {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          feedback: ["ok"],
          code: "basic.showIcon(IconNames.Heart)"
        })
      }
    }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("P1-06A: token bucket rejects after capacity with retryAfterSeconds >= 1 and refills with injected now", () => {
  let current = 1_000_000;
  const bucket = createTokenBucket({
    capacity: 2,
    refillPerSecond: 2 / 60,
    now: () => current
  });

  assert.equal(bucket.take(1).ok, true);
  assert.equal(bucket.take(1).ok, true);

  const rejected = bucket.take(1);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.retryAfterSeconds >= 1);

  current += 60_000;
  assert.equal(bucket.take(1).ok, true);
});

test("P1-06A: connect IP limit returns 429 after the configured per-IP allowance", async () => {
  const runtime = createRateLimitRuntime({
    env: {
      VIBBIT_RATE_CONNECT_PER_IP_PER_MIN: "10",
      VIBBIT_RATE_CONNECT_GLOBAL_PER_MIN: "1000"
    }
  });

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await connectWithIp(runtime, "LEGACY", "203.0.113.1");
    assert.notEqual(response.status, 429, `expected attempt ${attempt} to pass the IP limiter`);
  }

  const limited = await connectWithIp(runtime, "LEGACY", "203.0.113.1");
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.reason, "connect_ip");
  assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
});

test("default connect IP limit allows a 30-student same-IP class join burst", async () => {
  const runtime = createRateLimitRuntime({
    env: {
      VIBBIT_RATE_CONNECT_GLOBAL_PER_MIN: "1000"
    }
  });
  assert.equal(runtime.rateLimits.config.connectPerIpPerMinute, 60);

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const response = await connectWithIp(runtime, "LEGACY", "203.0.113.40");
    assert.notEqual(
      response.status,
      429,
      `expected same-IP student ${attempt} to connect under the classroom default`
    );
  }
});

test("P1-06A: a different IP can still connect when one IP is rate limited", async () => {
  const runtime = createRateLimitRuntime({
    env: {
      VIBBIT_RATE_CONNECT_PER_IP_PER_MIN: "10",
      VIBBIT_RATE_CONNECT_GLOBAL_PER_MIN: "1000"
    }
  });

  for (let attempt = 0; attempt < 11; attempt += 1) {
    await connectWithIp(runtime, "LEGACY", "203.0.113.50");
  }

  const blocked = await connectWithIp(runtime, "LEGACY", "203.0.113.50");
  assert.equal(blocked.status, 429);

  const otherIp = await connectWithIp(runtime, "LEGACY", "203.0.113.99");
  assert.notEqual(otherIp.status, 429);
});

test("generate 429s update in-memory rateLimited counter without persisting usage", async () => {
  let persistCalls = 0;
  const runtime = createRateLimitRuntime({
    env: {
      VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "1",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "100",
      VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
      VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
    },
    persistUsageState: async () => {
      persistCalls += 1;
    }
  });

  const connect = await connectWithCode(runtime, "RATEA");
  assert.equal(connect.status, 200);
  const { sessionToken } = await connect.json();
  // Connect persists once; freeze the counter before rejected generates.
  const persistsAfterConnect = persistCalls;
  assert.ok(persistsAfterConnect >= 1);

  let upstreamCalls = 0;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalls += 1;
    return mockGenerateResponse();
  });

  try {
    const first = await generateWithSession(runtime, sessionToken);
    assert.equal(first.status, 200);
    const persistsAfterAccepted = persistCalls;
    assert.ok(persistsAfterAccepted > persistsAfterConnect);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const limited = await generateWithSession(runtime, sessionToken);
      assert.equal(limited.status, 429);
    }

    assert.equal(persistCalls, persistsAfterAccepted, "rejected generates must not persist usage");
    assert.equal(upstreamCalls, 1);
    const usage = runtime.usageStore.getToday("cls_rate_a");
    assert.equal(usage.rateLimited, 25);
    assert.equal(usage.acceptedGenerations, 1);
  } finally {
    restoreFetch();
  }
});

test("P1-06A: generate session limit returns 429 without calling upstream fetch", async () => {
  const runtime = createRateLimitRuntime({
    env: {
      VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "2",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "100",
      VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
      VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
    }
  });

  const connect = await connectWithCode(runtime, "RATEA");
  assert.equal(connect.status, 200);
  const { sessionToken } = await connect.json();

  let upstreamCalls = 0;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalls += 1;
    return mockGenerateResponse();
  });

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await generateWithSession(runtime, sessionToken);
      assert.equal(response.status, 200, `expected generate attempt ${attempt + 1} to succeed`);
    }

    const limited = await generateWithSession(runtime, sessionToken);
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.reason, "generate_session");
    assert.equal(upstreamCalls, 2);
  } finally {
    restoreFetch();
  }
});

test("P1-06A: classroom daily quota blocks after N reservations and loadDailyUsage restores counts", async () => {
  const fixedNow = () => 1_700_000_000_000;
  const env = {
    VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "100",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "3",
    VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
    VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
  };

  let savedDailyUsage = null;
  const first = createRateLimitController(env, {
    now: fixedNow,
    persistDailyUsage: async (snapshot) => {
      savedDailyUsage = structuredClone(snapshot);
    }
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reservation = await first.reserveGenerate({
      sessionToken: `session-${attempt}`,
      classroomId: "cls_rate_a"
    });
    assert.equal(reservation.ok, true);
    reservation.release();
  }

  const blockedOnFirst = await first.reserveGenerate({
    sessionToken: "session-overflow",
    classroomId: "cls_rate_a"
  });
  assert.equal(blockedOnFirst.ok, false);
  assert.equal(blockedOnFirst.reason, "generate_daily_quota");
  assert.ok(savedDailyUsage);

  const second = createRateLimitController(env, {
    now: fixedNow,
    loadDailyUsage: () => savedDailyUsage
  });
  assert.equal(second.getClassroomDayUsage("cls_rate_a"), 3);

  const blockedAfterRecreate = await second.reserveGenerate({
    sessionToken: "session-after-reload",
    classroomId: "cls_rate_a"
  });
  assert.equal(blockedAfterRecreate.ok, false);
  assert.equal(blockedAfterRecreate.reason, "generate_daily_quota");
});

test("P1-06A: classroom concurrency gate blocks until a reservation is released", async () => {
  const controller = createRateLimitController({
    VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "100",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "100",
    VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "2",
    VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
  });

  const first = await controller.reserveGenerate({
    sessionToken: "session-1",
    classroomId: "cls_rate_a"
  });
  const second = await controller.reserveGenerate({
    sessionToken: "session-2",
    classroomId: "cls_rate_a"
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const blocked = await controller.reserveGenerate({
    sessionToken: "session-3",
    classroomId: "cls_rate_a"
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "generate_classroom_concurrency");

  first.release();
  const afterRelease = await controller.reserveGenerate({
    sessionToken: "session-4",
    classroomId: "cls_rate_a"
  });
  assert.equal(afterRelease.ok, true);
  second.release();
  afterRelease.release();
});

test("P1-06A: runtime integration returns 429 with Retry-After and skips upstream when session limit exceeded", async () => {
  const runtime = createRateLimitRuntime({
    env: {
      VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "1",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "100",
      VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
      VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
    }
  });

  const connect = await connectWithCode(runtime, "RATEA");
  assert.equal(connect.status, 200);
  const { sessionToken } = await connect.json();

  let upstreamCalls = 0;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalls += 1;
    return mockGenerateResponse();
  });

  try {
    const first = await generateWithSession(runtime, sessionToken);
    assert.equal(first.status, 200);

    const limited = await generateWithSession(runtime, sessionToken);
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.reason, "generate_session");
    assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
    assert.equal(upstreamCalls, 1);
  } finally {
    restoreFetch();
  }
});

test("P1-06A: classroom daily quota is isolated per classroom", async () => {
  const fixedNow = () => 1_700_000_000_000;
  const controller = createRateLimitController({
    VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "100",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "2",
    VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
    VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
  }, { now: fixedNow });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reservation = await controller.reserveGenerate({
      sessionToken: `class-a-${attempt}`,
      classroomId: "cls_rate_a"
    });
    assert.equal(reservation.ok, true);
    reservation.release();
  }

  const blockedA = await controller.reserveGenerate({
    sessionToken: "class-a-overflow",
    classroomId: "cls_rate_a"
  });
  assert.equal(blockedA.ok, false);
  assert.equal(blockedA.reason, "generate_daily_quota");

  const allowedB = await controller.reserveGenerate({
    sessionToken: "class-b-ok",
    classroomId: "cls_rate_b"
  });
  assert.equal(allowedB.ok, true);
  allowedB.release();
});

test("reserveGenerate rolls back counters when persistDailyUsage rejects", async () => {
  let failPersist = true;
  const controller = createRateLimitController({
    VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "1",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "1",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "100",
    VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
    VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
  }, {
    persistDailyUsage: async () => {
      if (failPersist) {
        failPersist = false;
        throw new Error("disk full");
      }
    }
  });

  await assert.rejects(
    () => controller.reserveGenerate({
      sessionToken: "session-rollback",
      classroomId: "cls_rate_a"
    }),
    /disk full/
  );
  assert.equal(controller.getClassroomDayUsage("cls_rate_a"), 0);

  // Same session/classroom must succeed after bucket capacity is restored.
  const afterFailure = await controller.reserveGenerate({
    sessionToken: "session-rollback",
    classroomId: "cls_rate_a"
  });
  assert.equal(afterFailure.ok, true);
  afterFailure.release();
});

test("revoked classroom session does not consume daily generate quota", async () => {
  const rateLimits = createRateLimitController({
    VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "100",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
    VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "3",
    VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
    VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
  });

  const runtime = createBackendRuntime({
    env: {
      VIBBIT_DEPLOYMENT_MODE: "self-hosted",
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini"
    },
    teacherPortalState: seededPortalState({
      cls_rate_a: seededClassroomA
    }),
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }],
    rateLimits
  });

  const connect = await connectWithCode(runtime, "RATEA");
  assert.equal(connect.status, 200);
  const { sessionToken } = await connect.json();

  await runtime.teacherPortal.store.updateClassroom(seededTeacher.id, "cls_rate_a", {
    enabled: false
  });

  const generate = await generateWithSession(runtime, sessionToken);
  assert.equal(generate.status, 401);
  assert.equal(rateLimits.getClassroomDayUsage("cls_rate_a"), 0);
});

test("hidden provider retries do not spend extra daily quota", async () => {
  const runtime = createRateLimitRuntime({
    env: {
      VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "100",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "1",
      VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
      VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
    }
  });

  const connect = await connectWithCode(runtime, "RATEA");
  assert.equal(connect.status, 200);
  const { sessionToken } = await connect.json();

  let upstreamCalls = 0;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalls += 1;
    if (upstreamCalls === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              feedback: ["arrow"],
              code: "input.onButtonPressed(Button.A, () => { basic.showIcon(IconNames.Heart) })"
            })
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return mockGenerateResponse();
  });

  try {
    const first = await generateWithSession(runtime, sessionToken);
    const firstBody = await first.json();
    assert.equal(first.status, 200, firstBody && firstBody.error ? firstBody.error : "generate failed");
    assert.equal(firstBody.upstreamAttempts, 2);
    const usage = runtime.usageStore.getToday("cls_rate_a");
    assert.equal(usage.acceptedGenerations, 1);
    assert.equal(usage.upstreamAttempts, 2);

    const second = await generateWithSession(runtime, sessionToken);
    assert.equal(second.status, 429);
    const limited = await second.json();
    assert.equal(limited.reason, "generate_daily_quota");
    assert.equal(upstreamCalls, 2);
    assert.equal(runtime.usageStore.getToday("cls_rate_a").acceptedGenerations, 1);
  } finally {
    restoreFetch();
  }
});

test("hidden provider retries stay capped at three upstream attempts", async () => {
  const runtime = createRateLimitRuntime({
    env: {
      VIBBIT_EMPTY_RETRIES: "5",
      VIBBIT_VALIDATION_RETRIES: "5",
      VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN: "100",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN: "100",
      VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY: "10",
      VIBBIT_RATE_CONCURRENT_PER_CLASSROOM: "10",
      VIBBIT_RATE_CONCURRENT_GLOBAL: "100"
    }
  });

  const connect = await connectWithCode(runtime, "RATEA");
  assert.equal(connect.status, 200);
  const { sessionToken } = await connect.json();

  let upstreamCalls = 0;
  const restoreFetch = mockUpstreamFetch(async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            feedback: ["arrow"],
            code: "input.onButtonPressed(Button.A, () => { basic.showIcon(IconNames.Heart) })"
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });

  try {
    const response = await generateWithSession(runtime, sessionToken);
    const body = await response.json();
    assert.equal(response.status, 200, body && body.error ? body.error : "generate failed");
    assert.equal(body.outcome, "stub-invalid");
    assert.equal(body.upstreamAttempts, 3);
    assert.equal(upstreamCalls, 3);
    const usage = runtime.usageStore.getToday("cls_rate_a");
    assert.equal(usage.acceptedGenerations, 1);
    assert.equal(usage.upstreamAttempts, 3);
  } finally {
    restoreFetch();
  }
});
