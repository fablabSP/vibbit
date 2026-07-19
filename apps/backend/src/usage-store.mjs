/**
 * Per-classroom usage counters (UTC daily buckets). No prompts/code/IPs/tokens stored.
 */

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function emptyBucket() {
  return {
    connects: 0,
    acceptedGenerations: 0,
    upstreamAttempts: 0,
    successes: 0,
    failures: 0,
    rateLimited: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastUsedAt: ""
  };
}

export function createUsageStore({
  now = () => Date.now(),
  persist,
  initialState = {}
} = {}) {
  // shape: { [classroomId]: { [yyyy-mm-dd]: bucket } }
  let state = sanitiseUsageState(initialState);
  let writeChain = Promise.resolve();
  let dirty = false;

  function dayKey(ts = now()) {
    return utcDayKey(new Date(ts));
  }

  function ensureBucket(classroomId, day = dayKey()) {
    const id = String(classroomId || "legacy");
    if (!state[id]) state[id] = {};
    if (!state[id][day]) state[id][day] = emptyBucket();
    return state[id][day];
  }

  function schedulePersist() {
    if (typeof persist !== "function") return Promise.resolve();
    dirty = true;
    writeChain = writeChain.then(async () => {
      try {
        await persist(structuredClone(state));
        dirty = false;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.error(`[Vibbit usage-store] Failed to persist usage state: ${message}`);
      }
    });
    return writeChain;
  }

  async function record(classroomId, mutator) {
    const bucket = ensureBucket(classroomId);
    mutator(bucket);
    bucket.lastUsedAt = new Date(now()).toISOString();
    await schedulePersist();
    return bucket;
  }

  return {
    getState: () => structuredClone(state),
    getToday(classroomId) {
      return structuredClone(ensureBucket(classroomId));
    },
    async recordConnect(classroomId) {
      return record(classroomId, (bucket) => {
        bucket.connects += 1;
      });
    },
    async recordAcceptedGeneration(classroomId) {
      return record(classroomId, (bucket) => {
        bucket.acceptedGenerations += 1;
      });
    },
    async recordRateLimited(classroomId) {
      // In-memory only. Rejected-generate floods must not rewrite encrypted state
      // on every 429; checkpoint on the next bounded persist (connect/generate/upstream).
      const bucket = ensureBucket(classroomId);
      bucket.rateLimited += 1;
      if (typeof persist === "function") dirty = true;
      return bucket;
    },
    async recordUpstreamAttempt(classroomId, {
      success = false,
      inputTokens = 0,
      outputTokens = 0
    } = {}) {
      return record(classroomId, (bucket) => {
        bucket.upstreamAttempts += 1;
        if (success) bucket.successes += 1;
        else bucket.failures += 1;
        bucket.inputTokens += Math.max(0, Number(inputTokens) || 0);
        bucket.outputTokens += Math.max(0, Number(outputTokens) || 0);
      });
    },
    publicView(classroomId) {
      const today = ensureBucket(classroomId);
      return {
        day: dayKey(),
        connects: today.connects,
        acceptedGenerations: today.acceptedGenerations,
        upstreamAttempts: today.upstreamAttempts,
        successes: today.successes,
        failures: today.failures,
        rateLimited: today.rateLimited,
        inputTokens: today.inputTokens,
        outputTokens: today.outputTokens,
        lastUsedAt: today.lastUsedAt || null
      };
    }
  };
}

export function sanitiseUsageState(input) {
  const source = input && typeof input === "object" ? input : {};
  const next = {};
  for (const [classroomId, days] of Object.entries(source)) {
    if (!days || typeof days !== "object") continue;
    const safeId = String(classroomId || "").trim().slice(0, 120);
    if (!safeId) continue;
    next[safeId] = {};
    for (const [day, bucket] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const src = bucket && typeof bucket === "object" ? bucket : {};
      next[safeId][day] = {
        connects: Math.max(0, Number(src.connects) || 0),
        acceptedGenerations: Math.max(0, Number(src.acceptedGenerations) || 0),
        upstreamAttempts: Math.max(0, Number(src.upstreamAttempts) || 0),
        successes: Math.max(0, Number(src.successes) || 0),
        failures: Math.max(0, Number(src.failures) || 0),
        rateLimited: Math.max(0, Number(src.rateLimited) || 0),
        inputTokens: Math.max(0, Number(src.inputTokens) || 0),
        outputTokens: Math.max(0, Number(src.outputTokens) || 0),
        lastUsedAt: String(src.lastUsedAt || "").trim()
      };
    }
  }
  return next;
}
