/**
 * OpenAI-compatible chat completions helper.
 * Works with OpenAI, OpenRouter, LiteLLM, Anthropic OpenAI-compat proxies, and similar gateways.
 */

function joinChatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://api.openai.com/v1/chat/completions";
  if (/\/chat\/completions$/i.test(raw)) return raw;
  return `${raw}/chat/completions`;
}

export async function callOpenAICompatible({
  apiKey,
  baseUrl,
  model,
  system,
  user,
  signal,
  temperature = 0.1,
  maxTokens = 3072,
  fetchImpl = fetch
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Missing API key for OpenAI-compatible endpoint");

  const url = joinChatCompletionsUrl(baseUrl);
  const body = {
    model: String(model || "").trim() || "gpt-4o-mini",
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: String(system || "") },
      { role: "user", content: String(user || "") }
    ]
  };

  const response = await fetchImpl(url, {
    method: "POST",
    signal,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify(body)
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("OpenAI-compatible endpoint returned a redirect, which is not allowed");
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.text();
      detail = String(errBody || "").replace(/\s+/g, " ").trim().slice(0, 220);
    } catch {
      // ignore body parse failures
    }
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`OpenAI-compatible error (${response.status})${suffix}`);
  }

  const data = await response.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

export function providerConfigFromClassroom(classroom) {
  const model = String((classroom && classroom.model) || "gpt-4o-mini").trim() || "gpt-4o-mini";
  const apiKey = String((classroom && classroom.apiKey) || "").trim();
  const baseUrl = String((classroom && classroom.apiBaseUrl) || "https://api.openai.com/v1").trim();

  return {
    enabledProviders: ["openai"],
    defaultProvider: "openai",
    allowedModels: {},
    defaultModelFor: () => model,
    apiKeyFor: () => apiKey,
    baseUrlFor: () => baseUrl,
    classroomId: classroom && classroom.id ? classroom.id : "",
    source: "classroom"
  };
}
