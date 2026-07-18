/**
 * Token-bucket rate limits, daily classroom quotas, and concurrency gates.
 */

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function createTokenBucket({
  capacity,
  refillPerSecond,
  now = () => Date.now()
} = {}) {
  let tokens = capacity;
  let updatedAt = now();

  return {
    take(cost = 1) {
      const current = now();
      const elapsed = Math.max(0, (current - updatedAt) / 1000);
      tokens = Math.min(capacity, tokens + (elapsed * refillPerSecond));
      updatedAt = current;
      if (tokens < cost) {
        const missing = cost - tokens;
        const retryAfterMs = Math.ceil((missing / refillPerSecond) * 1000);
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000))
        };
      }
      tokens -= cost;
      return { ok: true, retryAfterSeconds: 0 };
    }
  };
}

export function createRateLimitConfig(envInput = {}) {
  const env = envInput || {};
  return {
    connectPerIpPerMinute: parseInteger(env.VIBBIT_RATE_CONNECT_PER_IP_PER_MIN, 10, { min: 1, max: 1000 }),
    connectGlobalPerMinute: parseInteger(env.VIBBIT_RATE_CONNECT_GLOBAL_PER_MIN, 300, { min: 1, max: 100000 }),
    generatePerSessionPerMinute: parseInteger(env.VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN, 6, { min: 1, max: 1000 }),
    generatePerClassroomPerMinute: parseInteger(env.VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_MIN, 90, { min: 1, max: 100000 }),
    generatePerClassroomPerDay: parseInteger(env.VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY, 500, { min: 1, max: 1000000 }),
    concurrentPerClassroom: parseInteger(env.VIBBIT_RATE_CONCURRENT_PER_CLASSROOM, 8, { min: 1, max: 1000 }),
    concurrentGlobal: parseInteger(env.VIBBIT_RATE_CONCURRENT_GLOBAL, 32, { min: 1, max: 10000 })
  };
}

export function createRateLimitController(envInput = {}, {
  now = () => Date.now(),
  persistDailyUsage,
  loadDailyUsage
} = {}) {
  const config = createRateLimitConfig(envInput);
  const buckets = new Map();
  const classroomDayCounts = new Map();
  const classroomInFlight = new Map();
  let globalInFlight = 0;

  const loaded = typeof loadDailyUsage === "function" ? loadDailyUsage() : null;
  if (loaded && typeof loaded === "object") {
    for (const [key, value] of Object.entries(loaded)) {
      classroomDayCounts.set(key, Number(value) || 0);
    }
  }

  function bucket(key, capacity, perMinute) {
    if (!buckets.has(key)) {
      buckets.set(key, createTokenBucket({
        capacity,
        refillPerSecond: capacity / 60,
        now
      }));
    }
    return buckets.get(key);
  }

  function dayCountKey(classroomId, day = utcDayKey(new Date(now()))) {
    return `${day}:${classroomId || "legacy"}`;
  }

  function persistDayCounts() {
    if (typeof persistDailyUsage !== "function") return;
    const snapshot = {};
    for (const [key, value] of classroomDayCounts.entries()) {
      snapshot[key] = value;
    }
    return persistDailyUsage(snapshot);
  }

  function reject(retryAfterSeconds, reason) {
    return {
      ok: false,
      status: 429,
      retryAfterSeconds: Math.max(1, Number(retryAfterSeconds) || 1),
      reason
    };
  }

  return {
    config,

    checkConnect({ clientIp = "" } = {}) {
      const ipKey = `connect:ip:${clientIp || "unknown"}`;
      const ipResult = bucket(
        ipKey,
        config.connectPerIpPerMinute,
        config.connectPerIpPerMinute
      ).take(1);
      if (!ipResult.ok) return reject(ipResult.retryAfterSeconds, "connect_ip");

      const globalResult = bucket(
        "connect:global",
        config.connectGlobalPerMinute,
        config.connectGlobalPerMinute
      ).take(1);
      if (!globalResult.ok) return reject(globalResult.retryAfterSeconds, "connect_global");

      return { ok: true };
    },

    async reserveGenerate({ sessionToken = "", classroomId = "" } = {}) {
      const sessionKey = `generate:session:${sessionToken || "anonymous"}`;
      const sessionResult = bucket(
        sessionKey,
        config.generatePerSessionPerMinute,
        config.generatePerSessionPerMinute
      ).take(1);
      if (!sessionResult.ok) return reject(sessionResult.retryAfterSeconds, "generate_session");

      const classKey = `generate:classroom:${classroomId || "legacy"}`;
      const classResult = bucket(
        classKey,
        config.generatePerClassroomPerMinute,
        config.generatePerClassroomPerMinute
      ).take(1);
      if (!classResult.ok) return reject(classResult.retryAfterSeconds, "generate_classroom");

      const dayKey = dayCountKey(classroomId);
      const used = classroomDayCounts.get(dayKey) || 0;
      if (used >= config.generatePerClassroomPerDay) {
        return reject(60, "generate_daily_quota");
      }

      const inFlight = classroomInFlight.get(classroomId || "legacy") || 0;
      if (inFlight >= config.concurrentPerClassroom) {
        return reject(1, "generate_classroom_concurrency");
      }
      if (globalInFlight >= config.concurrentGlobal) {
        return reject(1, "generate_global_concurrency");
      }

      classroomDayCounts.set(dayKey, used + 1);
      classroomInFlight.set(classroomId || "legacy", inFlight + 1);
      globalInFlight += 1;
      await persistDayCounts();

      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          const current = classroomInFlight.get(classroomId || "legacy") || 1;
          classroomInFlight.set(classroomId || "legacy", Math.max(0, current - 1));
          globalInFlight = Math.max(0, globalInFlight - 1);
        }
      };
    },

    getClassroomDayUsage(classroomId) {
      const dayKey = dayCountKey(classroomId);
      return classroomDayCounts.get(dayKey) || 0;
    }
  };
}

export function rateLimitResponse(origin, runtimeConfig, { retryAfterSeconds, reason }) {
  const body = {
    error: "Too many requests. Please wait and try again.",
    reason: reason || "rate_limited"
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(Math.max(1, Number(retryAfterSeconds) || 1)),
      ...(typeof runtimeConfig === "object" ? {} : {})
    }
  });
}
