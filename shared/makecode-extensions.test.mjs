import assert from "node:assert/strict";
import test from "node:test";

import {
  MICROBIT_EXTENSIONS,
  buildExtensionPromptExtras,
  buildSystemPrompt,
  detectMissingCapability,
  detectRequiredExtensions,
  extensionDependencies,
  parseModelOutput,
  runGenerationLoop,
  runValidateBlocks
} from "./makecode-compat-core.mjs";

test("detects extensions from generated code", () => {
  assert.deepEqual(
    detectRequiredExtensions("let strip = neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB)"),
    ["neopixel"]
  );
  assert.deepEqual(
    detectRequiredExtensions("let d = sonar.ping(DigitalPin.P1, DigitalPin.P2, PingUnit.Centimeters)"),
    ["sonar"]
  );
  assert.deepEqual(detectRequiredExtensions("keyboard.sendString(\"hi\")"), ["blehid"]);
});

test("detects extensions from request intent before any code exists", () => {
  assert.deepEqual(detectRequiredExtensions("", "light up my LED strip in rainbow"), ["neopixel"]);
  assert.deepEqual(detectRequiredExtensions("", "measure distance with an ultrasonic sensor"), ["sonar"]);
});

test("ignores extensions in strings and comments", () => {
  assert.deepEqual(detectRequiredExtensions("basic.showString(\"neopixel.create\")"), []);
});

test("non-microbit targets never request micro:bit extensions", () => {
  assert.deepEqual(detectRequiredExtensions("neopixel.create(1, 2, 3)", "", "arcade"), []);
});

test("dependency fragment uses registry package ids", () => {
  assert.deepEqual(extensionDependencies(["neopixel", "sonar"]), { neopixel: "*", sonar: "*" });
  assert.equal(extensionDependencies(["blehid"]).blehid, MICROBIT_EXTENSIONS.blehid.pkg);
});

test("third-party packages are pinned, never tracking a branch", () => {
  for (const entry of Object.values(MICROBIT_EXTENSIONS)) {
    if (!entry.pkg.startsWith("github:")) continue;
    // A tag (#v1.2.3) or a full commit SHA both count as pinned.
    assert.match(entry.pkg, /#(?:v?\d|[0-9a-f]{40})/, `${entry.id} must pin a tag or commit`);
  }
});

test("prompt extras appear only for the relevant extension", () => {
  const extras = buildExtensionPromptExtras("microbit", "make my led strip glow").join("\n");
  assert.match(extras, /neopixel\.create/);
  assert.doesNotMatch(extras, /sonar\.ping/);
  assert.match(extras, /MUST add this extension/);
});

test("servo guidance says built-in and does not add an extension", () => {
  const extras = buildExtensionPromptExtras("microbit", "sweep a servo on P1").join("\n");
  assert.match(extras, /built into micro:bit/);
  assert.doesNotMatch(extras, /MakeCode package/);
});

test("system prompt stays lean when no extension is implied", () => {
  const plain = buildSystemPrompt("microbit", { requestHint: "count button presses" });
  assert.doesNotMatch(plain, /neopixel/);
  const strip = buildSystemPrompt("microbit", { requestHint: "rainbow on my neopixel strip" });
  assert.match(strip, /NeoPixelMode/);
});

test("extension enums and arities validate only when the extension is used", () => {
  const good = [
    "let strip = neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB)",
    "strip.showColor(neopixel.colors(NeoPixelColors.Red))"
  ].join("\n");
  const okResult = runValidateBlocks(good, "microbit");
  assert.equal(okResult.ok, true, okResult.violations.join(", "));
  assert.deepEqual(okResult.extensions, ["neopixel"]);

  const badEnum = "let strip = neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB)\nstrip.showColor(neopixel.colors(NeoPixelColors.Turquoise))";
  assert.ok(runValidateBlocks(badEnum, "microbit").violations.some((v) => /NeoPixelColors\.Turquoise/.test(v)));

  const badArity = "let strip = neopixel.create(DigitalPin.P1, 8)";
  assert.ok(runValidateBlocks(badArity, "microbit").violations.some((v) => /neopixel\.create arity/.test(v)));
});

test("sonar arity accepts the optional max distance argument", () => {
  const three = "let d = sonar.ping(DigitalPin.P1, DigitalPin.P2, PingUnit.Centimeters)";
  const four = "let d = sonar.ping(DigitalPin.P1, DigitalPin.P2, PingUnit.Centimeters, 200)";
  assert.equal(runValidateBlocks(three, "microbit").ok, true);
  assert.equal(runValidateBlocks(four, "microbit").ok, true);
});

test("hardware warnings surface without failing validation", () => {
  const p0 = runValidateBlocks("let strip = neopixel.create(DigitalPin.P0, 8, NeoPixelMode.RGB)", "microbit");
  assert.equal(p0.ok, true);
  assert.ok(p0.warnings.some((w) => /P0/.test(w)));

  const noGroup = runValidateBlocks("radio.sendNumber(1)", "microbit");
  assert.ok(noGroup.warnings.some((w) => /setGroup/.test(w)));

  const samePin = runValidateBlocks("let d = sonar.ping(DigitalPin.P1, DigitalPin.P1, PingUnit.Centimeters)", "microbit");
  assert.ok(samePin.warnings.some((w) => /same pin/.test(w)));

  const badAngle = runValidateBlocks("pins.servoWritePin(AnalogPin.P1, 270)", "microbit");
  assert.ok(badAngle.warnings.some((w) => /0-180/.test(w)));
});

test("clean core code produces no warnings", () => {
  const result = runValidateBlocks("basic.showNumber(1)", "microbit");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.extensions, []);
});

test("registry examples pass the validator they are meant to teach", () => {
  for (const entry of Object.values(MICROBIT_EXTENSIONS)) {
    const result = runValidateBlocks(entry.example, "microbit");
    assert.equal(result.ok, true, `${entry.id} example: ${result.violations.join(", ")}`);
  }
});

/* ── envelope truncation guards ───────────────────────────── */

test("a truncated JSON envelope never becomes code verbatim", () => {
  const broken = '{"feedback":["Shake your micro:bit"],"code":"let options = [0, 1, 2]\\nbasic.showIcon(IconNames.Square)';
  const parsed = parseModelOutput(broken);
  assert.doesNotMatch(parsed.code, /"feedback"/);
  assert.doesNotMatch(parsed.code, /^\{/);
  assert.match(parsed.code, /basic\.showIcon/);
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.feedback, ["Shake your micro:bit"]);
});

test("an unsalvageable envelope returns empty code so the loop retries", () => {
  const parsed = parseModelOutput('{"feedback":["thinking about it"');
  assert.equal(parsed.code, "");
  assert.equal(parsed.truncated, true);
});

test("well-formed envelopes are unaffected", () => {
  const parsed = parseModelOutput('{"feedback":["ok"],"code":"basic.showNumber(1)"}');
  assert.equal(parsed.code, "basic.showNumber(1)");
  assert.equal(parsed.truncated, undefined);
});

test("plain code with no envelope still passes through", () => {
  assert.equal(parseModelOutput("basic.showNumber(1)").code, "basic.showNumber(1)");
});

test("validator rejects a leaked envelope outright", () => {
  const result = runValidateBlocks('{"feedback":["x"],"code":"basic.showNumber(1)"}', "microbit");
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /JSON envelope/.test(v)));
});

/* ── truncation detection ─────────────────────────────────── */

test("a cut-off handler fails validation instead of being pasted", () => {
  const cut = [
    "let roll = 0",
    "let dice = [1, 2, 3, 4, 5, 6]",
    "input.onGesture(Gesture.Shake, function () {",
    "    roll = dice._pickRandom()",
    "    basic.showNumber(roll)"
  ].join("\n");
  const result = runValidateBlocks(cut, "microbit");
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /cut off/.test(v)));
});

test("the same program with its closing brace passes", () => {
  const full = [
    "let roll = 0",
    "let dice = [1, 2, 3, 4, 5, 6]",
    "input.onGesture(Gesture.Shake, function () {",
    "    roll = dice._pickRandom()",
    "    basic.showNumber(roll)",
    "})"
  ].join("\n");
  assert.equal(runValidateBlocks(full, "microbit").ok, true);
});

test("braces inside strings do not trigger a false cut-off", () => {
  assert.equal(runValidateBlocks('basic.showString("}")', "microbit").ok, true);
});

test("truncation triggers a retry with a larger token budget", async () => {
  const scales = [];
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "user",
    maxAttempts: 3,
    truncationRetries: 1,
    callModel: async (messages, options) => {
      scales.push((options && options.tokenScale) || 1);
      return scales.length === 1
        ? '{"feedback":["x"],"code":"basic.showNumber(1)'
        : '{"feedback":["x"],"code":"basic.showNumber(1)"}';
    }
  });
  assert.deepEqual(scales, [1, 3], "second attempt must ask for more room");
  assert.equal(result.outcome ?? "ok", "ok");
});

/* ── capability safety net ────────────────────────────────── */

test("the exact blehid request is detected from its intent", () => {
  const request = "I want to use the Bluetooth HID keyboard extension, when I shake the micro:bit, "
    + "show a random number from 1 to 6, then send that number as a keypress through the bluetooth.";
  assert.deepEqual(detectRequiredExtensions("", request), ["blehid"]);
  assert.match(buildExtensionPromptExtras("microbit", request).join("\n"), /keyboard\.sendString/);
});

test("looser phrasings still reach the right extension", () => {
  assert.deepEqual(detectRequiredExtensions("", "type on my laptop wirelessly"), ["blehid"]);
  assert.deepEqual(detectRequiredExtensions("", "measure distance to the wall"), ["sonar"]);
  assert.deepEqual(detectRequiredExtensions("", "make the rainbow lights glow"), ["neopixel"]);
});

test("a missing-capability admission is recognised, ordinary feedback is not", () => {
  assert.equal(detectMissingCapability(["Used Serial since the Bluetooth HID extension isn't in my current toolkit."]), true);
  assert.equal(detectMissingCapability(["I don't have access to that block."]), true);
  assert.equal(detectMissingCapability(["Shake to roll the dice."]), false);
  assert.equal(detectMissingCapability([]), false);
});

test("a missing-capability report retries with the full extension catalogue", async () => {
  let calls = 0;
  let retrySawKeyboardApi = false;
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "bluetooth keyboard dice",
    maxAttempts: 3,
    capabilityRetries: 1,
    callModel: async (messages) => {
      calls += 1;
      if (calls === 1) {
        return JSON.stringify({ feedback: ["Used Serial since the Bluetooth HID extension isn't in my toolkit."], code: "serial.writeNumber(1)" });
      }
      retrySawKeyboardApi = messages[0].content.includes("keyboard.startKeyboardService");
      return JSON.stringify({ feedback: ["Sends a keypress."], code: "keyboard.startKeyboardService()" });
    }
  });
  assert.equal(calls, 2);
  assert.equal(retrySawKeyboardApi, true, "retry must carry the extension APIs");
  assert.match(result.code, /keyboard\.startKeyboardService/);
});

/* ── NFC / RFID ───────────────────────────────────────────── */

test("NFC is reached by both nfc and rfid keywords", () => {
  assert.deepEqual(detectRequiredExtensions("", "read an RFID card"), ["nfc"]);
  assert.deepEqual(detectRequiredExtensions("", "scan a tag with NFC"), ["nfc"]);
  assert.deepEqual(detectRequiredExtensions("if (NFC.getCard()) { }"), ["nfc"]);
});

test("NFC dependency uses the package's own name, not our internal id", () => {
  const deps = extensionDependencies(["nfc"]);
  assert.ok(deps.NFC, "pxt.json declares the package as NFC");
  assert.match(deps.NFC, /^github:DFRobot\/pxt-NFCUART#[0-9a-f]{40}$/);
});

test("NFC arities match the real extension signatures", () => {
  assert.equal(runValidateBlocks("basic.showString(NFC.getUID())", "microbit").ok, true);
  const bad = runValidateBlocks("NFC.writeData(1, 2)", "microbit");
  assert.ok(bad.violations.some((v) => /NFC\.writeData arity/.test(v)));
});
