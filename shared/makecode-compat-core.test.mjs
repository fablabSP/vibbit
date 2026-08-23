import assert from "node:assert/strict";
import test from "node:test";

import {
  TARGET_API_CATALOG,
  buildCorrectionInstruction,
  buildDecompileFixRequest,
  buildFailedAttemptUserTurn,
  buildSystemPrompt,
  parseModelOutput,
  runGenerationLoop,
  serializeTranscript,
  stubForTarget,
  validateBlocksCompatibility
} from "./makecode-compat-core.mjs";

const TARGETS = ["microbit", "arcade", "maker"];

test("system prompt keeps the four-block skeleton with front and end anchors", () => {
  for (const target of TARGETS) {
    const prompt = buildSystemPrompt(target);
    const config = TARGET_API_CATALOG[target];
    assert.match(prompt, /^ROLE: /, `${target} prompt starts with ROLE`);
    assert.ok(prompt.includes("PRIME DIRECTIVE:"), `${target} prompt has prime directive`);
    assert.ok(prompt.includes("AVAILABLE APIS"), `${target} prompt lists APIs`);
    assert.ok(prompt.includes("WRITE BLOCK-SAFE CODE:"), `${target} prompt has positive rules`);
    assert.ok(prompt.includes("NEVER USE"), `${target} prompt has forbidden rules`);
    assert.ok(prompt.includes("OUTPUT FORMAT:"), `${target} prompt has output contract`);
    assert.ok(prompt.includes("EXAMPLE (" + config.name), `${target} prompt has a worked example`);
    assert.match(prompt, /FINAL RULE: [\s\S]*$/, `${target} prompt ends with FINAL RULE anchor`);
    assert.ok(prompt.includes(config.name), `${target} prompt names the target`);
  }
});

test("system prompt grounds the model in target-specific APIs only", () => {
  assert.ok(buildSystemPrompt("microbit").includes("basic:"));
  assert.ok(buildSystemPrompt("arcade").includes("sprites:"));
  assert.ok(buildSystemPrompt("maker").includes("loops:"));
  // micro:bit on start is a real block and must not be forbidden anymore
  const microbit = buildSystemPrompt("microbit");
  assert.ok(microbit.includes("onStart(handler)"));
  assert.ok(!/onstart functions/i.test(microbit));
});

test("block-safe examples stay within each target's API surface", () => {
  const microbit = buildSystemPrompt("microbit");
  const arcade = buildSystemPrompt("arcade");
  const maker = buildSystemPrompt("maker");
  const blockSafe = (prompt) => {
    const start = prompt.indexOf("WRITE BLOCK-SAFE CODE:");
    const end = prompt.indexOf("NEVER USE");
    return prompt.slice(start, end);
  };
  assert.ok(blockSafe(microbit).includes("input.onButtonPressed"));
  assert.ok(blockSafe(microbit).includes("basic.onStart"));
  assert.ok(!blockSafe(microbit).includes("game.onUpdate"));
  assert.ok(blockSafe(arcade).includes("game.onUpdate"));
  assert.ok(!blockSafe(arcade).includes("input.onButtonPressed"));
  assert.ok(!blockSafe(arcade).includes("basic.forever"));
  assert.ok(blockSafe(maker).includes("loops.forever"));
  assert.ok(!blockSafe(maker).includes("game.onUpdate"));
  assert.ok(!blockSafe(maker).includes("basic.forever"));
});

test("conversational option toggles chat guidance without changing the contract", () => {
  const managed = buildSystemPrompt("microbit");
  const byok = buildSystemPrompt("microbit", { conversational: true });
  assert.ok(!managed.includes("CONVERSATION:"));
  assert.ok(byok.includes("CONVERSATION:"));
  assert.ok(byok.includes("friendly"));
  // Both still demand the same JSON contract
  assert.ok(managed.includes("OUTPUT FORMAT:") && byok.includes("OUTPUT FORMAT:"));
});

test("unknown targets fall back to micro:bit", () => {
  assert.equal(buildSystemPrompt("nonsense"), buildSystemPrompt("microbit"));
});

test("few-shot example code is block-safe for its target", () => {
  for (const target of TARGETS) {
    const { example } = TARGET_API_CATALOG[target];
    const result = validateBlocksCompatibility(example, target);
    assert.ok(result.ok, `${target} example violations: ${result.violations.join(", ")}`);
  }
});

test("few-shot response parses as the model output contract and stays block-safe", () => {
  for (const target of TARGETS) {
    const prompt = buildSystemPrompt(target);
    const match = prompt.match(/RESPONSE: (\{[\s\S]*?\})\n/);
    assert.ok(match, `${target} prompt embeds a RESPONSE JSON object`);
    const parsed = parseModelOutput(match[1]);
    assert.ok(parsed.feedback.length >= 1, `${target} example has feedback`);
    assert.ok(parsed.code.trim().length > 0, `${target} example has code`);
    const result = validateBlocksCompatibility(parsed.code, target);
    assert.ok(result.ok, `${target} parsed example violations: ${result.violations.join(", ")}`);
  }
});

test("fallback stub is block-safe for its target", () => {
  for (const target of TARGETS) {
    const result = validateBlocksCompatibility(stubForTarget(target), target);
    assert.ok(result.ok, `${target} stub violations: ${result.violations.join(", ")}`);
  }
});

test("basic.onStart must be top-level on micro:bit", () => {
  const nested = [
    "input.onButtonPressed(Button.A, function () {",
    "    basic.onStart(function () {",
    "        basic.showString(\"Hi\")",
    "    })",
    "})"
  ].join("\n");
  const result = validateBlocksCompatibility(nested, "microbit");
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes("nested event registration"));
});

test("correction instruction turns violations into actionable fixes", () => {
  const message = buildCorrectionInstruction(["arrow functions", "randint()"], "microbit");
  assert.ok(message.includes("micro:bit"));
  assert.ok(message.includes("function () { }"));
  assert.ok(message.includes("options._pickRandom()"));
  assert.ok(message.includes("Problems:"));
  assert.ok(message.includes("Fix by:"));
});

test("strict correction instruction escalates and targets the right platform", () => {
  const message = buildCorrectionInstruction(["Arcade APIs in micro:bit/Maker"], "arcade", { strict: true });
  assert.ok(message.startsWith("STRICT MODE:"));
  assert.ok(message.includes("Arcade"));
  assert.ok(message.includes("only APIs for the selected target"));
});

test("correction instruction is safe with no violations", () => {
  const message = buildCorrectionInstruction([], "maker");
  assert.ok(message.includes("Maker"));
  assert.ok(!message.includes("Problems:"));
  assert.ok(message.length > 0);
});

const VALID_HEART = "basic.showIcon(IconNames.Heart)";
const ARROW_UNSAFE = "input.onButtonPressed(Button.A, () => { basic.showIcon(IconNames.Heart) })";

function jsonOutput(code, feedback = ["ok"]) {
  return JSON.stringify({ feedback, code });
}

test("failed user turn includes the previous programme and JSON mandate", () => {
  const turn = buildFailedAttemptUserTurn({
    code: ARROW_UNSAFE,
    validation: { ok: false, violations: ["arrow functions"] },
    target: "microbit",
    kind: "invalid"
  });
  assert.ok(turn.includes("<<<FAILED_ATTEMPT>>>"));
  assert.ok(turn.includes("<<<END_FAILED_ATTEMPT>>>"));
  assert.ok(turn.includes(ARROW_UNSAFE));
  assert.ok(turn.includes("function () { }"));
  assert.match(turn, /JSON only|compact JSON/i);

  const emptyTurn = buildFailedAttemptUserTurn({
    code: "",
    validation: { ok: false, violations: [] },
    target: "microbit",
    kind: "empty"
  });
  assert.ok(emptyTurn.includes("<<<FAILED_ATTEMPT>>>\n\n<<<END_FAILED_ATTEMPT>>>"));
  assert.match(emptyTurn, /empty/i);
  assert.match(emptyTurn, /JSON only|compact JSON/i);
});

test("generation loop retries empty output and keeps the failed turn", async () => {
  const calls = [];
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async (messages) => {
      calls.push(messages.slice());
      if (calls.length === 1) return jsonOutput("", ["empty"]);
      return jsonOutput(VALID_HEART, ["heart"]);
    }
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.upstreamAttempts, 2);
  assert.equal(result.code, VALID_HEART);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].map((item) => item.role), ["system", "user"]);
  assert.equal(calls[1][2].role, "assistant");
  assert.equal(calls[1][3].role, "user");
  assert.ok(calls[1][3].content.includes("<<<FAILED_ATTEMPT>>>"));
  assert.match(calls[1][3].content, /empty/i);
});

test("generation loop retries invalid output and the next user turn includes FAILED_ATTEMPT", async () => {
  const calls = [];
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async (messages) => {
      calls.push(messages.slice());
      if (calls.length === 1) return jsonOutput(ARROW_UNSAFE, ["arrow"]);
      return jsonOutput(VALID_HEART, ["fixed"]);
    }
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.upstreamAttempts, 2);
  assert.equal(result.code, VALID_HEART);
  assert.equal(result.validation.ok, true);
  assert.equal(calls.length, 2);
  const second = calls[1];
  assert.equal(second[0].role, "system");
  assert.equal(second[1].role, "user");
  assert.equal(second[2].role, "assistant");
  assert.equal(second[2].content, ARROW_UNSAFE);
  assert.ok(second[3].content.includes("<<<FAILED_ATTEMPT>>>"));
  assert.ok(second[3].content.includes(ARROW_UNSAFE));
  assert.ok(second[3].content.includes("arrow functions"));
});

test("generation loop stubs empty and invalid outcomes", async () => {
  const empty = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async () => jsonOutput("")
  });
  assert.equal(empty.outcome, "stub-empty");
  assert.equal(empty.code, stubForTarget("microbit"));
  assert.equal(empty.upstreamAttempts, 3);
  assert.equal(empty.attempts[empty.attempts.length - 1].reason, "empty");
  assert.ok(empty.feedback.some((line) => /no code/i.test(line)));

  const invalid = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async () => jsonOutput(ARROW_UNSAFE)
  });
  assert.equal(invalid.outcome, "stub-invalid");
  assert.equal(invalid.code, stubForTarget("microbit"));
  assert.equal(invalid.upstreamAttempts, 3);
  assert.equal(invalid.validation.ok, false);
  assert.ok(invalid.feedback.some((line) => /Validation fallback/i.test(line)));
});

test("serializeTranscript keeps a single user turn and flattens later turns", () => {
  const single = serializeTranscript([
    { role: "system", content: "sys-a" },
    { role: "system", content: "sys-b" },
    { role: "user", content: "please show a heart" }
  ]);
  assert.equal(single.system, "sys-a\n\nsys-b");
  assert.equal(single.user, "please show a heart");

  const flattened = serializeTranscript([
    { role: "system", content: "sys" },
    { role: "user", content: "first" },
    { role: "assistant", content: ARROW_UNSAFE },
    { role: "user", content: "<<<FAILED_ATTEMPT>>>\n" + ARROW_UNSAFE }
  ]);
  assert.equal(flattened.system, "sys");
  assert.ok(flattened.user.includes("<<<USER>>>\nfirst"));
  assert.ok(flattened.user.includes("<<<ASSISTANT>>>\n" + ARROW_UNSAFE));
  assert.ok(flattened.user.includes("<<<FAILED_ATTEMPT>>>"));
});

test("decompile fix request uses British spelling and names grey blocks", () => {
  const text = buildDecompileFixRequest({
    greyBlocks: 2,
    snippets: ["foo()", "bar()", "baz()", "dropped"],
    reason: "Detected 2 grey JavaScript block(s)"
  });
  assert.ok(text.includes("behaviour"));
  assert.ok(text.includes("typescript_statement"));
  assert.ok(text.includes("Grey block count: 2."));
  assert.ok(text.includes("Detected 2 grey JavaScript block(s)"));
  assert.ok(text.includes("foo()"));
  assert.ok(text.includes("bar()"));
  assert.ok(text.includes("baz()"));
  assert.ok(!text.includes("dropped"));
});
