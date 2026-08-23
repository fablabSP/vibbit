#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSystemPrompt,
  buildUserPrompt,
  parseModelOutput,
  validateBlocksCompatibility
} from "../../shared/makecode-compat-core.mjs";
import {
  compileAndDecompile,
  scoreMakeCodeValidation
} from "../../shared/makecode-decompile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const defaults = {
  corpus: path.join(here, "corpus.json"),
  samples: 3,
  temperature: 0.1,
  maxTokens: 3072,
  timeoutMs: 90000,
  provider: "openrouter",
  promptMode: "managed",
  out: path.join(repoRoot, "output", "model-evals")
};

function usage() {
  console.log(`Usage:
  node evals/makecode-models/run.mjs --provider <openrouter|opencode-go|opencode-zen|custom> --models <id,id> [options]

Options:
  --endpoint URL       Override the OpenAI-compatible /chat/completions endpoint
  --key-env NAME       Environment variable containing the API key
  --protocol NAME      chat or responses (default: chat)
  --samples N          Repetitions per case/model (default: 3)
  --temperature N      Sampling temperature (default: 0.1)
  --seed N             Send seed + repetition number (only where supported)
  --prompt-mode MODE   managed or byok; byok adds Vibbit conversation guidance
  --max-tokens N       Maximum output tokens (default: 3072)
  --timeout-ms N       Per-request timeout (default: 90000)
  --case REGEX         Run matching case IDs only
  --target LIST        Comma-separated microbit,arcade,maker filter
  --corpus PATH        Alternate corpus JSON
  --out DIR            Output root (default: output/model-evals)
  --dry-run            Validate and print the matrix without API calls

Default key variables:
  openrouter=OPENROUTER_API_KEY, opencode-go/zen=OPENCODE_API_KEY, custom=MODEL_EVAL_API_KEY`);
}

function parseArgs(argv) {
  const options = { ...defaults };
  const numberKeys = new Set(["samples", "temperature", "seed", "max-tokens", "timeout-ms"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--") || i + 1 >= argv.length) throw new Error(`Invalid argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    const camelKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[camelKey] = numberKeys.has(key) ? Number(value) : value;
  }
  if (options.help) return options;
  if (!options.models) throw new Error("--models is required");
  options.models = String(options.models).split(",").map((item) => item.trim()).filter(Boolean);
  if (!options.models.length) throw new Error("--models must contain at least one model ID");
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error("--samples must be a positive integer");
  if (!Number.isFinite(options.temperature) || options.temperature < 0) throw new Error("--temperature must be non-negative");
  options.protocol = String(options.protocol || "chat").toLowerCase();
  if (!["chat", "responses"].includes(options.protocol)) throw new Error("--protocol must be chat or responses");
  if (!["managed", "byok"].includes(options.promptMode)) throw new Error("--prompt-mode must be managed or byok");
  return options;
}

const PROVIDERS = {
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    modelsEndpoint: "https://openrouter.ai/api/v1/models",
    keyEnv: "OPENROUTER_API_KEY"
  },
  "opencode-go": {
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
    modelsEndpoint: "https://opencode.ai/zen/go/v1/models",
    keyEnv: "OPENCODE_API_KEY"
  },
  "opencode-zen": {
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    modelsEndpoint: "https://opencode.ai/zen/v1/models",
    keyEnv: "OPENCODE_API_KEY"
  },
  custom: { keyEnv: "MODEL_EVAL_API_KEY" }
};

function timestampTag(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function strictContract(raw) {
  const text = String(raw || "");
  try {
    const parsed = JSON.parse(text);
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).sort()
      : [];
    const exactKeys = keys.length === 2 && keys[0] === "code" && keys[1] === "feedback";
    const validFeedback = Array.isArray(parsed.feedback) && parsed.feedback.length > 0
      && parsed.feedback.every((item) => typeof item === "string" && item.trim());
    const validCode = typeof parsed.code === "string" && parsed.code.trim();
    return {
      ok: Boolean(exactKeys && validFeedback && validCode),
      exactJson: true,
      exactKeys,
      validFeedback: Boolean(validFeedback),
      validCode: Boolean(validCode)
    };
  } catch {
    return { ok: false, exactJson: false, exactKeys: false, validFeedback: false, validCode: false };
  }
}

function criteriaResult(code, testCase) {
  const required = (testCase.required || []).map((source) => ({
    pattern: source,
    pass: new RegExp(source, "m").test(code)
  }));
  const forbidden = (testCase.forbidden || []).map((source) => ({
    pattern: source,
    pass: !new RegExp(source, "m").test(code)
  }));
  const checks = [...required, ...forbidden];
  return {
    ok: checks.every((item) => item.pass),
    passed: checks.filter((item) => item.pass).length,
    total: checks.length,
    required,
    forbidden
  };
}

function provisionalScore(contract, compatibility, criteria) {
  const contractPoints = contract.ok ? 10 : 0;
  const compatibilityPoints = compatibility.ok ? 10 : 0;
  const criteriaPoints = criteria.total ? 20 * criteria.passed / criteria.total : 20;
  return {
    score: Number((contractPoints + compatibilityPoints + criteriaPoints).toFixed(2)),
    max: 40
  };
}

function emptyMakeCodeValidation(message) {
  return {
    ok: false,
    compileOk: false,
    decompileOk: false,
    nativeBlocks: false,
    greyBlocks: 0,
    snippets: [],
    diagnostics: [{ messageText: message }],
    targetRelease: null,
    hashes: {},
    roundTripOk: null,
    reason: message
  };
}

async function runPinnedMakeCodeValidation(code, target) {
  if (!String(code || "").trim()) {
    const report = emptyMakeCodeValidation("empty output");
    return { report, score: scoreMakeCodeValidation(report), error: null };
  }
  try {
    const report = await compileAndDecompile({ code, target });
    return { report, score: scoreMakeCodeValidation(report), error: null };
  } catch (error) {
    const report = emptyMakeCodeValidation(error.message);
    return { report, score: scoreMakeCodeValidation(report), error: error.message };
  }
}

function buildPrompt(testCase, promptMode) {
  const system = buildSystemPrompt(testCase.target, { conversational: promptMode === "byok" });
  const user = buildUserPrompt({
    request: testCase.request,
    currentCode: testCase.currentCode || "",
    pageErrors: testCase.pageErrors || [],
    conversionDialog: testCase.conversionDialog || null
  });
  return { system, user };
}

function extractResponseText(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : (part && part.text) || "").join("");
  }
  return "";
}

function extractResponsesText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  return (Array.isArray(data?.output) ? data.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((item) => typeof item?.text === "string" ? item.text : "")
    .join("");
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    const latencyMs = Math.round(performance.now() - started);
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`HTTP ${response.status}: non-JSON response (${body.slice(0, 160)})`);
    }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || body.slice(0, 200);
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return { data, latencyMs };
  } finally {
    clearTimeout(timeout);
  }
}

async function snapshotModels(providerConfig, timeoutMs) {
  if (!providerConfig.modelsEndpoint) return null;
  try {
    const { data } = await fetchJson(providerConfig.modelsEndpoint, {}, timeoutMs);
    return data;
  } catch (error) {
    return { snapshotError: error.message };
  }
}

function pricingFor(model, modelSnapshot) {
  const entries = Array.isArray(modelSnapshot?.data) ? modelSnapshot.data : [];
  return entries.find((entry) => entry.id === model)?.pricing || null;
}

function estimateCost(usage, pricing) {
  if (Number.isFinite(Number(usage?.cost))) return Number(usage.cost);
  if (!pricing) return null;
  const promptRate = Number(pricing.prompt);
  const completionRate = Number(pricing.completion);
  if (!Number.isFinite(promptRate) || !Number.isFinite(completionRate)) return null;
  const promptTokens = Number(usage?.prompt_tokens || 0);
  const completionTokens = Number(usage?.completion_tokens || 0);
  return promptTokens * promptRate + completionTokens * completionRate;
}

function shuffledMatrix(models, cases, samples) {
  const rows = [];
  for (let repetition = 0; repetition < samples; repetition += 1) {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        rows.push({
          repetition,
          testCase: cases[(caseIndex + repetition) % cases.length],
          model: models[(modelIndex + caseIndex + repetition) % models.length]
        });
      }
    }
  }
  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const providerConfig = { ...(PROVIDERS[options.provider] || PROVIDERS.custom) };
  if (options.endpoint) providerConfig.endpoint = options.endpoint;
  else if (options.protocol === "responses") {
    providerConfig.endpoint = providerConfig.endpoint?.replace(/\/chat\/completions$/, "/responses");
  }
  if (!providerConfig.endpoint) throw new Error("--endpoint is required for this provider");
  const keyEnv = options.keyEnv || providerConfig.keyEnv;
  const apiKey = process.env[keyEnv] || "";

  const corpus = JSON.parse(await readFile(path.resolve(options.corpus), "utf8"));
  let cases = corpus.cases || [];
  if (options.case) {
    const filter = new RegExp(options.case);
    cases = cases.filter((item) => filter.test(item.id));
  }
  if (options.target) {
    const targets = new Set(String(options.target).split(",").map((item) => item.trim()));
    cases = cases.filter((item) => targets.has(item.target));
  }
  if (!cases.length) throw new Error("No corpus cases matched the filters");

  const matrix = shuffledMatrix(options.models, cases, options.samples);
  if (options.dryRun) {
    console.log(JSON.stringify({ provider: options.provider, models: options.models, cases: cases.length, requests: matrix.length }, null, 2));
    return;
  }
  if (!apiKey) throw new Error(`${keyEnv} is required (the key is never written to output)`);

  const runDir = path.join(path.resolve(options.out), `${options.provider}-${timestampTag()}`);
  await mkdir(runDir, { recursive: true });
  const modelSnapshot = await snapshotModels(providerConfig, options.timeoutMs);
  await writeFile(path.join(runDir, "models-snapshot.json"), JSON.stringify(modelSnapshot, null, 2) + "\n");

  const records = [];
  const validationRecords = [];
  for (let index = 0; index < matrix.length; index += 1) {
    const { model, testCase, repetition } = matrix[index];
    const { system, user } = buildPrompt(testCase, options.promptMode);
    const body = options.protocol === "responses"
      ? {
          model,
          max_output_tokens: options.maxTokens,
          input: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        }
      : {
          model,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        };
    if (options.protocol === "responses" && !/^gpt-/i.test(model)) {
      body.temperature = options.temperature;
    }
    if (options.protocol === "chat" && Number.isInteger(options.seed)) body.seed = options.seed + repetition;

    process.stdout.write(`[${index + 1}/${matrix.length}] ${model} ${testCase.id} #${repetition + 1} ... `);
    const base = {
      schemaVersion: 1,
      provider: options.provider,
      endpoint: providerConfig.endpoint,
      requestedModel: model,
      caseId: testCase.id,
      target: testCase.target,
      targetBoard: testCase.targetBoard || null,
      category: testCase.category,
      repetition,
      temperature: options.temperature,
      promptMode: options.promptMode,
      seed: body.seed ?? null,
      systemPromptSha256: sha256(system),
      userPromptSha256: sha256(user),
      corpusVersion: corpus.version
    };
    try {
      const { data, latencyMs } = await fetchJson(providerConfig.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      }, options.timeoutMs);
      const raw = options.protocol === "responses" ? extractResponsesText(data) : extractResponseText(data);
      const parsed = parseModelOutput(raw);
      const contract = strictContract(raw);
      const compatibility = parsed.code
        ? validateBlocksCompatibility(parsed.code, testCase.target)
        : { ok: false, violations: ["empty output"] };
      const criteria = criteriaResult(parsed.code, testCase);
      const provisional = provisionalScore(contract, compatibility, criteria);
      const usage = data.usage || null;
      const record = {
        ...base,
        status: "ok",
        responseId: data.id || null,
        resolvedModel: data.model || null,
        finishReason: data.choices?.[0]?.finish_reason || data.status || null,
        latencyMs,
        usage,
        costUsd: estimateCost(usage, pricingFor(model, modelSnapshot)),
        raw,
        parsed,
        contract,
        compatibility,
        criteria,
        provisional,
        makeCodeValidation: null
      };
      records.push(record);
      const pinned = await runPinnedMakeCodeValidation(parsed.code, testCase.target);
      validationRecords.push({
        requestedModel: model,
        caseId: testCase.id,
        repetition,
        target: testCase.target,
        targetBoard: testCase.targetBoard || null,
        makeCodeValidation: pinned.report,
        makeCodeScore: pinned.score,
        totalScore: Number((provisional.score + pinned.score.score).toFixed(2)),
        totalMax: 100,
        error: pinned.error
      });
      console.log(`${provisional.score}/${provisional.max} + ${pinned.score.score}/${pinned.score.max}, ${latencyMs}ms`);
    } catch (error) {
      records.push({ ...base, status: "error", error: error.message, makeCodeValidation: null });
      validationRecords.push({
        requestedModel: model,
        caseId: testCase.id,
        repetition,
        target: testCase.target,
        makeCodeValidation: null,
        makeCodeScore: { score: 0, max: 60 },
        totalScore: 0,
        totalMax: 100,
        error: error.message
      });
      console.log(`ERROR ${error.message}`);
    }
  }

  const resultsPath = path.join(runDir, "results.jsonl");
  await writeFile(resultsPath, records.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const validationPath = path.join(runDir, "makecode-validation.jsonl");
  await writeFile(validationPath, validationRecords.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const scored = validationRecords.filter((item) => item.makeCodeValidation);
  const meanTotal = scored.length
    ? Number((scored.reduce((sum, item) => sum + item.totalScore, 0) / scored.length).toFixed(2))
    : null;
  const summary = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    provider: options.provider,
    protocol: options.protocol,
    endpoint: providerConfig.endpoint,
    corpus: path.relative(repoRoot, path.resolve(options.corpus)),
    corpusVersion: corpus.version,
    models: options.models,
    samples: options.samples,
    temperature: options.temperature,
    promptMode: options.promptMode,
    seed: Number.isInteger(options.seed) ? options.seed : null,
    requests: records.length,
    successfulRequests: records.filter((item) => item.status === "ok").length,
    errors: records.filter((item) => item.status === "error").length,
    meanTotalScore: meanTotal,
    note: "results.jsonl is the immutable provider capture. Pinned compile and decompile scores live in makecode-validation.jsonl.",
    results: "results.jsonl",
    makeCodeValidation: "makecode-validation.jsonl",
    modelSnapshot: "models-snapshot.json"
  };
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`Run written to ${runDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
