/**
 * Hosted vs self-hosted deployment posture.
 * Hosted mode fails closed for classroom multi-tenant safety.
 */

import { parseEncryptionKey } from "./secret-box.mjs";

const MAKECODE_DEFAULT_ORIGINS = [
  "https://makecode.microbit.org",
  "https://arcade.makecode.com",
  "https://maker.makecode.com",
  "https://makecode.com"
];

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function normaliseDeploymentMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "hosted") return "hosted";
  if (!mode || mode === "self-hosted" || mode === "selfhosted" || mode === "self_hosted") {
    return "self-hosted";
  }
  throw new Error(
    `Invalid VIBBIT_DEPLOYMENT_MODE '${value}'. Use 'hosted' or 'self-hosted'.`
  );
}

export function parsePublicOrigin(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("VIBBIT_PUBLIC_ORIGIN must be a valid absolute URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("VIBBIT_PUBLIC_ORIGIN must use https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("VIBBIT_PUBLIC_ORIGIN must not include credentials.");
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new Error("VIBBIT_PUBLIC_ORIGIN must not include a path.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("VIBBIT_PUBLIC_ORIGIN must not include query or hash.");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function createDeploymentPolicy(envInput = {}) {
  const env = envInput || {};
  const mode = normaliseDeploymentMode(env.VIBBIT_DEPLOYMENT_MODE);
  const isHosted = mode === "hosted";
  const trustProxy = parseBoolean(env.VIBBIT_TRUST_PROXY, false);

  const googleClientId = String(env.VIBBIT_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || "").trim();
  const googleClientSecret = String(
    env.VIBBIT_GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || ""
  ).trim();
  const googleEnabled = Boolean(googleClientId && googleClientSecret);

  // Dev login defaults OFF. Hosted mode forbids enabling it.
  const requestedDevLogin = parseBoolean(env.VIBBIT_TEACHER_DEV_LOGIN, false);
  if (isHosted && requestedDevLogin) {
    throw new Error(
      "Hosted mode forbids VIBBIT_TEACHER_DEV_LOGIN. Configure Google OAuth instead."
    );
  }
  const allowDevLogin = isHosted ? false : requestedDevLogin;

  const magicLinkConfigured = Boolean(
    String(env.VIBBIT_RESEND_API_KEY || env.RESEND_API_KEY || "").trim()
  ) || parseBoolean(env.VIBBIT_MAGIC_LINK_DEV_CAPTURE, false);
  const magicLinkEnabled = parseBoolean(env.VIBBIT_MAGIC_LINK_ENABLED, magicLinkConfigured);

  let publicOrigin = "";
  if (isHosted) {
    publicOrigin = parsePublicOrigin(env.VIBBIT_PUBLIC_ORIGIN);
    if (!publicOrigin) {
      throw new Error(
        "Hosted mode requires VIBBIT_PUBLIC_ORIGIN (pathless https origin)."
      );
    }
    if (!googleEnabled && !(magicLinkEnabled && magicLinkConfigured)) {
      throw new Error(
        "Hosted mode requires Google OAuth or configured magic-link email sign-in."
      );
    }
    // Fail closed: hosted always encrypts credentials at rest.
    const encryptionKey = parseEncryptionKey(env.VIBBIT_CREDENTIAL_ENCRYPTION_KEY || "");
    if (!encryptionKey) {
      throw new Error(
        "Hosted mode requires VIBBIT_CREDENTIAL_ENCRYPTION_KEY (32-byte base64/base64url)."
      );
    }
  } else if (String(env.VIBBIT_PUBLIC_ORIGIN || "").trim()) {
    publicOrigin = parsePublicOrigin(env.VIBBIT_PUBLIC_ORIGIN);
  }

  // Magic-link emails must never be minted from a request Host header.
  if (magicLinkEnabled && magicLinkConfigured && !publicOrigin) {
    throw new Error(
      "Magic-link sign-in requires VIBBIT_PUBLIC_ORIGIN (pathless https origin)."
    );
  }

  const configuredAllowOrigin = String(env.VIBBIT_ALLOW_ORIGIN ?? "").trim();
  let allowOrigin;
  if (isHosted) {
    if (!configuredAllowOrigin || configuredAllowOrigin === "*") {
      allowOrigin = MAKECODE_DEFAULT_ORIGINS.join(",");
    } else if (configuredAllowOrigin.split(",").map((s) => s.trim()).includes("*")) {
      throw new Error("Hosted mode rejects wildcard CORS (VIBBIT_ALLOW_ORIGIN).");
    } else {
      allowOrigin = configuredAllowOrigin;
    }
  } else {
    allowOrigin = configuredAllowOrigin || "*";
  }

  const legacyClassroomCodesEnabled = isHosted
    ? false
    : parseBoolean(env.VIBBIT_LEGACY_CLASSROOM_CODES, true);

  const adminPanelEnabled = isHosted
    ? false
    : parseBoolean(env.VIBBIT_ADMIN_PANEL_ENABLED, true);

  return {
    mode,
    isHosted,
    trustProxy,
    publicOrigin,
    allowOrigin,
    allowDevLogin,
    googleEnabled,
    legacyClassroomCodesEnabled,
    adminPanelEnabled,
    defaultCorsOrigins: MAKECODE_DEFAULT_ORIGINS.slice()
  };
}

export function resolveRequestPublicOrigin(request, requestUrl, deploymentPolicy) {
  if (deploymentPolicy.publicOrigin) {
    return deploymentPolicy.publicOrigin;
  }

  if (!deploymentPolicy.trustProxy) {
    const protocol = String((requestUrl && requestUrl.protocol) || "https:").replace(/:$/, "");
    const host = firstHeaderToken(request.headers.get("host")) || requestUrl.host;
    return `${protocol || "https"}://${host}`;
  }

  const forwardedProto = firstHeaderToken(request.headers.get("x-forwarded-proto")).toLowerCase();
  const forwardedHost = firstHeaderToken(request.headers.get("x-forwarded-host"));
  const protocol = (forwardedProto === "http" || forwardedProto === "https")
    ? forwardedProto
    : String((requestUrl && requestUrl.protocol) || "https:").replace(/:$/, "");
  const host = forwardedHost || firstHeaderToken(request.headers.get("host")) || requestUrl.host;
  return `${protocol || "https"}://${host}`;
}

function firstHeaderToken(value) {
  return String(value || "")
    .split(",")[0]
    .trim();
}

export function resolveTrustedClientIp(request, deploymentPolicy) {
  if (deploymentPolicy.trustProxy) {
    const forwarded = String(request.headers.get("x-forwarded-for") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    // With one trusted reverse proxy, the rightmost address is the peer the proxy saw.
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return "";
}

export { MAKECODE_DEFAULT_ORIGINS, parseBoolean, parseCsv };
