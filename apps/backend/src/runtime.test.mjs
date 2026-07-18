import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";

function createRuntime() {
  return createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "false",
      SERVER_APP_TOKEN: ""
    }
  });
}

async function fetchRuntime(pathname) {
  const runtime = createRuntime();
  return runtime.fetch(new Request(`https://example.test${pathname}`));
}

test("serves favicon svg for root and /api-prefixed requests", async () => {
  for (const pathname of ["/favicon.svg", "/api/favicon.svg"]) {
    const response = await fetchRuntime(pathname);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type") || ""), /^image\/svg\+xml/);
    const body = await response.text();
    assert.match(body, /<svg[\s>]/i);
  }
});

test("redirects favicon ico requests to the matching svg path", async () => {
  const cases = [
    { pathname: "/favicon.ico", expectedLocation: "/favicon.svg" },
    { pathname: "/api/favicon.ico", expectedLocation: "/api/favicon.svg" }
  ];

  for (const { pathname, expectedLocation } of cases) {
    const response = await fetchRuntime(pathname);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), expectedLocation);
  }
});

test("renders relative favicon links on html pages for prefix-safe resolution", async () => {
  const pages = ["/", "/bookmarklet", "/admin", "/teacher", "/api/bookmarklet", "/api/admin", "/api/teacher"];

  for (const pathname of pages) {
    const response = await fetchRuntime(pathname);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /href="favicon\.svg"/);
    assert.doesNotMatch(body, /href="\/favicon\.svg"/);
  }
});

test("legacy classroom connect returns public server config fields", async () => {
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
    teacherPortalState: {},
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classCode: "LEGACY" })
  }));
  assert.equal(connect.status, 200);
  const body = await connect.json();
  assert.equal(body.ok, true);
  assert.equal(body.authMode, "classroom");
  assert.equal(body.classCodeRequired, true);
  assert.equal(body.defaultProvider, "openai");
  assert.equal(body.defaultModel, "gpt-4o-mini");
  assert.ok(body.sessionToken);
  assert.equal(typeof body.defaultModelFor, "undefined");
  assert.equal(typeof body.apiKeyFor, "undefined");
});

test("generate accepts empty request when pageErrors are present", async () => {
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
    teacherPortalState: {},
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classCode: "LEGACY" })
  }));
  assert.equal(connect.status, 200);
  const { sessionToken } = await connect.json();

  const originalFetch = globalThis.fetch;
  let capturedProviderBody = "";
  globalThis.fetch = async (_url, init = {}) => {
    capturedProviderBody = String(init.body || "");
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            feedback: ["fixed"],
            code: "basic.showIcon(IconNames.Heart)"
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const generate = await runtime.fetch(new Request("https://example.test/vibbit/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`
      },
      body: JSON.stringify({
        target: "microbit",
        request: "",
        pageErrors: ["Type 'foo' is not defined"]
      })
    }));
    assert.equal(generate.status, 200);
    assert.match(capturedProviderBody, /Type 'foo' is not defined/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
