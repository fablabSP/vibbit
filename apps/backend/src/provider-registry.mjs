import { callOpenAICompatible } from "./openai-compat.mjs";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1";

export const CREDENTIAL_PROFILE_PROVIDERS = ["openai", "gemini", "openrouter", "custom"];

export function normaliseCredentialProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return CREDENTIAL_PROFILE_PROVIDERS.includes(provider) ? provider : "openai";
}

export function providerDisplayName(provider) {
  const normalised = normaliseCredentialProvider(provider);
  if (normalised === "openai") return "OpenAI";
  if (normalised === "gemini") return "Gemini";
  if (normalised === "openrouter") return "OpenRouter";
  if (normalised === "custom") return "Custom";
  return normalised;
}

export function defaultModelForCredentialProvider(provider) {
  const normalised = normaliseCredentialProvider(provider);
  if (normalised === "gemini") return "gemini-2.5-flash";
  if (normalised === "openrouter") return "openrouter/auto";
  return "gpt-4o-mini";
}

export function normaliseOpenAiCompatibleBaseUrl(value) {
  let url = String(value || "").trim();
  if (!url) return DEFAULT_OPENAI_BASE_URL;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_OPENAI_BASE_URL;
    }
    let path = parsed.pathname.replace(/\/+$/, "");
    if (!path || path === "/") {
      path = "/v1";
    } else if (!/\/v\d+$/i.test(path) && !/\/chat\/completions$/i.test(path)) {
      path = `${path}/v1`.replace(/\/{2,}/g, "/");
    }
    parsed.pathname = path;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_OPENAI_BASE_URL;
  }
}

export function inferCredentialProfileFromLegacyEndpoint(value) {
  const baseUrl = normaliseOpenAiCompatibleBaseUrl(value);
  try {
    const parsed = new URL(baseUrl);
    const hostname = String(parsed.hostname || "").toLowerCase();
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (hostname === "api.openai.com") {
      return { provider: "openai", customBaseUrl: "" };
    }
    if (hostname === "openrouter.ai" && pathname.startsWith("/api/")) {
      return { provider: "openrouter", customBaseUrl: "" };
    }
    if (hostname === "generativelanguage.googleapis.com") {
      return { provider: "gemini", customBaseUrl: "" };
    }
  } catch {
  }
  return { provider: "custom", customBaseUrl: baseUrl };
}

export function resolveManagedBaseUrlForProvider(provider, customBaseUrl = "") {
  const normalised = normaliseCredentialProvider(provider);
  if (normalised === "openai") return DEFAULT_OPENAI_BASE_URL;
  if (normalised === "openrouter") return DEFAULT_OPENROUTER_BASE_URL;
  if (normalised === "custom") return normaliseOpenAiCompatibleBaseUrl(customBaseUrl);
  return "";
}

export function createProviderConfigFromCredentialProfile(profile, { modelOverride = "" } = {}) {
  const provider = normaliseCredentialProvider(profile && profile.provider);
  const apiKey = String((profile && profile.apiKey) || "").trim();
  const model = String(modelOverride || (profile && profile.defaultModel) || "").trim()
    || defaultModelForCredentialProvider(provider);
  const baseUrl = resolveManagedBaseUrlForProvider(provider, profile && profile.customBaseUrl);
  return {
    enabledProviders: [provider],
    defaultProvider: provider,
    allowedModels: {},
    defaultModelFor: () => model,
    apiKeyFor: () => apiKey,
    baseUrlFor: () => baseUrl,
    profileId: profile && profile.id ? profile.id : "",
    source: "credentialProfile"
  };
}

export async function callManagedProvider({
  provider,
  apiKey,
  model,
  system,
  user,
  signal,
  customBaseUrl = "",
  temperature = 0.1,
  maxTokens = 3072
} = {}) {
  const selectedProvider = normaliseCredentialProvider(provider);
  const key = String(apiKey || "").trim();
  const selectedModel = String(model || "").trim() || defaultModelForCredentialProvider(selectedProvider);
  if (!key) throw new Error("Missing API key");

  if (selectedProvider === "gemini") {
    const url = `${GEMINI_API_ROOT}/models/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: `${String(system || "")}\n\n${String(user || "")}` }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens
      }
    };
    const response = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Gemini error (${response.status})`);
    }
    const data = await response.json();
    const text = data
      && data.candidates
      && data.candidates[0]
      && data.candidates[0].content
      && Array.isArray(data.candidates[0].content.parts)
      ? data.candidates[0].content.parts.map((part) => part && part.text ? part.text : "").join("")
      : "";
    return text;
  }

  return callOpenAICompatible({
    apiKey: key,
    baseUrl: resolveManagedBaseUrlForProvider(selectedProvider, customBaseUrl),
    model: selectedModel,
    system,
    user,
    signal,
    temperature,
    maxTokens
  });
}
