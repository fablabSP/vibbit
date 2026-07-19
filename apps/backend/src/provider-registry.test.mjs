import assert from "node:assert/strict";
import test from "node:test";
import { callManagedProvider } from "./provider-registry.mjs";

test("callManagedProvider sends Gemini API key in x-goog-api-key header", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedHeaders = {};

  await callManagedProvider({
    provider: "gemini",
    apiKey: "gem-key",
    model: "gemini-2.5-flash",
    system: "system prompt",
    user: "user prompt",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = String((init && init.method) || "GET").toUpperCase();
      capturedHeaders = (init && init.headers) || {};
      return new Response(JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "generated text" }] }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  const parsed = new URL(capturedUrl);
  assert.equal(capturedMethod, "POST");
  assert.equal(parsed.hostname, "generativelanguage.googleapis.com");
  assert.match(parsed.pathname, /\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(parsed.searchParams.has("key"), false);
  assert.ok(!capturedUrl.includes("key="));
  assert.equal(capturedHeaders["x-goog-api-key"], "gem-key");
});
