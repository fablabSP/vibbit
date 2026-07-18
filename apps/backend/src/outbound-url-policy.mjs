/**
 * Outbound URL policy for teacher-configured OpenAI-compatible endpoints.
 * Blocks SSRF to private/local/metadata addresses and unsafe redirects.
 */

import { lookup as defaultDnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal"
]);

/** Always-allowed public provider hosts (hosted + self-hosted). */
export const BUILTIN_ENDPOINT_ALLOWLIST = [
  "api.openai.com",
  "openrouter.ai",
  "*.openrouter.ai",
  "generativelanguage.googleapis.com",
  "api.anthropic.com"
];

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/^\*\./, "*."))
    .filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function ipv4ToInt(ip) {
  const parts = String(ip).split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  if (value == null) return true;
  const checks = [
    [0x00000000, 0xff000000], // 0.0.0.0/8
    [0x0a000000, 0xff000000], // 10.0.0.0/8
    [0x7f000000, 0xff000000], // 127.0.0.0/8
    [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
    [0xac100000, 0xfff00000], // 172.16.0.0/12
    [0xc0a80000, 0xffff0000], // 192.168.0.0/16
    [0xe0000000, 0xf0000000], // 224.0.0.0/4 multicast
    [0xf0000000, 0xf0000000] // 240.0.0.0/4 reserved
  ];
  return checks.some(([base, mask]) => ((value & mask) >>> 0) === base);
}

function isBlockedIpv6(ip) {
  const normalised = String(ip || "").toLowerCase();
  if (normalised === "::" || normalised === "::1") return true;
  if (normalised.startsWith("fc") || normalised.startsWith("fd")) return true; // unique local
  if (normalised.startsWith("fe80:")) return true; // link-local
  if (normalised.startsWith("ff")) return true; // multicast
  // IPv4-mapped IPv6
  const mapped = normalised.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    || normalised.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

export function isBlockedIpAddress(ip) {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

function hostMatchesAllowList(hostname, allowList) {
  const host = String(hostname || "").toLowerCase();
  if (!host || !allowList.length) return false;
  for (const entry of allowList) {
    if (entry === host) return true;
    if (entry.startsWith("*.") && host.endsWith(entry.slice(1)) && host.length > entry.length - 1) {
      return true;
    }
  }
  return false;
}

export function createOutboundUrlPolicy(envInput = {}, { dnsLookup = defaultDnsLookup } = {}) {
  const env = envInput || {};
  const mode = String(env.VIBBIT_DEPLOYMENT_MODE || "self-hosted").trim().toLowerCase();
  const isHosted = mode === "hosted";
  const allowPrivateEndpoints = !isHosted && parseBoolean(env.VIBBIT_ALLOW_PRIVATE_ENDPOINTS, false);
  const configuredAllowList = parseCsv(env.VIBBIT_CUSTOM_ENDPOINT_ALLOWLIST);
  const allowList = [...new Set([
    ...BUILTIN_ENDPOINT_ALLOWLIST,
    ...configuredAllowList
  ])];

  async function resolveAddresses(hostname) {
    if (isIP(hostname)) return [hostname];
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    return (Array.isArray(records) ? records : [records])
      .map((item) => (item && item.address ? String(item.address) : String(item || "")))
      .filter(Boolean);
  }

  async function assertSafeUrl(rawUrl, { purpose = "custom endpoint" } = {}) {
    const text = String(rawUrl || "").trim();
    if (!text) throw new Error(`Missing ${purpose} URL`);

    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw new Error(`Invalid ${purpose} URL`);
    }

    if (parsed.username || parsed.password) {
      throw new Error(`${purpose} URL must not include credentials`);
    }

    if (isHosted || !allowPrivateEndpoints) {
      if (parsed.protocol !== "https:") {
        throw new Error(`${purpose} URL must use https`);
      }
    } else if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`${purpose} URL must use http or https`);
    }

    const hostname = String(parsed.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!hostname) throw new Error(`${purpose} URL is missing a hostname`);
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new Error(`${purpose} URL host is not allowed`);
    }

    if (isIP(hostname) && (!allowPrivateEndpoints || isHosted)) {
      if (isBlockedIpAddress(hostname) || isHosted) {
        throw new Error(`${purpose} URL must not use an IP literal`);
      }
    }

    if (isHosted) {
      if (!hostMatchesAllowList(hostname, allowList)) {
        throw new Error(`${purpose} host is not on the operator allow-list`);
      }
    } else if (configuredAllowList.length && !hostMatchesAllowList(hostname, allowList) && !allowPrivateEndpoints) {
      // Optional extra allow-list in self-hosted mode when configured.
      throw new Error(`${purpose} host is not on the operator allow-list`);
    }

    if (!allowPrivateEndpoints || isHosted) {
      let addresses;
      try {
        addresses = await resolveAddresses(hostname);
      } catch {
        throw new Error(`${purpose} host could not be resolved`);
      }
      if (!addresses.length) {
        throw new Error(`${purpose} host could not be resolved`);
      }
      for (const address of addresses) {
        if (isBlockedIpAddress(address)) {
          throw new Error(`${purpose} resolves to a private or local address`);
        }
      }
    }

    return {
      href: parsed.toString().replace(/\/+$/, ""),
      hostname,
      protocol: parsed.protocol
    };
  }

  async function assertSafeRedirect(location, { purpose = "custom endpoint redirect" } = {}) {
    if (!location) throw new Error(`${purpose}: missing Location`);
    // Re-validate every redirect target with the same policy.
    return assertSafeUrl(location, { purpose });
  }

  return {
    isHosted,
    allowPrivateEndpoints,
    allowList,
    assertSafeUrl,
    assertSafeRedirect
  };
}
