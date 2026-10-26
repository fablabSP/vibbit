import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const work = read("../work.js");

test("Claude is offered in both provider dropdowns", () => {
  assert.equal((work.match(/<option value="anthropic">Claude \(Anthropic\)<\/option>/g) || []).length, 2);
});

test("Claude has a default model and is wired into every provider table", () => {
  assert.match(work, /anthropic: \[[\s\S]*?default: true/);
  assert.equal((work.match(/anthropic: callClaude/g) || []).length, 2);
  assert.match(work, /PROVIDER_DISPLAY_NAMES = \{[^}]*anthropic: "Claude"/);
});

test("Claude requests use the browser-access header and no temperature", () => {
  const start = work.indexOf("const callClaude = ");
  const body = work.slice(start, work.indexOf("const callOpenRouter = "));
  assert.match(body, /anthropic-dangerous-direct-browser-access/);
  assert.match(body, /anthropic-version/);
  assert.doesNotMatch(body, /temperature/);
});

test("Anthropic overloaded status 529 is retried", () => {
  assert.match(work, /TRANSIENT_STATUSES = new Set\(\[[^\]]*529/);
});

test("the browser is allowed to reach api.anthropic.com", () => {
  assert.match(read("../scripts/build.mjs"), /https:\/\/api\.anthropic\.com\/\*/);
  assert.match(read("../extension/manifest.json"), /https:\/\/api\.anthropic\.com\/\*/);
});

test("Claude hides the free-tier request counter", () => {
  assert.match(work, /provider === "anthropic"\) DAILY_REQUEST_BUDGET = 0/);
});
