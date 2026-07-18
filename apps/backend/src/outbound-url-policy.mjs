/**
 * Outbound URL policy for teacher-configured OpenAI-compatible endpoints.
 * Blocks SSRF to private/local/metadata addresses and unsafe redirects.
 */

import { lookup as defaultDnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { URL as NodeURL } from "node:url";

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
    [0x64400000, 0xffc00000], // 100.64.0.0/10 CGNAT
    [0x7f000000, 0xff000000], // 127.0.0.0/8
    [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
    [0xac100000, 0xfff00000], // 172.16.0.0/12
    [0xc0000000, 0xffffff00], // 192.0.0.0/24
    [0xc0a80000, 0xffff0000], // 192.168.0.0/16
    [0xc6120000, 0xfffe0000], // 198.18.0.0/15 benchmarking
    [0xe0000000, 0xf0000000], // 224.0.0.0/4 multicast
    [0xf0000000, 0xf0000000] // 240.0.0.0/4 reserved
  ];
  return checks.some(([base, mask]) => ((value & mask) >>> 0) === base);
}

function expandIpv6(ip) {
  const raw = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!raw.includes(":")) return "";
  const sides = raw.split("::");
  let head = sides[0] ? sides[0].split(":") : [];
  let tail = sides[1] ? sides[1].split(":") : [];
  if (sides.length > 2) return "";
  if (sides.length === 1) {
    head = raw.split(":");
    tail = [];
  }
  const missing = 8 - (head.filter(Boolean).length + tail.filter(Boolean).length);
  if (missing < 0) return "";
  const mid = Array.from({ length: missing }, () => "0");
  const parts = [...head.filter(Boolean), ...mid, ...tail.filter(Boolean)]
    .map((part) => part.padStart(4, "0"));
  if (parts.length !== 8) return "";
  return parts.join(":");
}

function isBlockedIpv6(ip) {
  const raw = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "");
  // Handle dotted IPv4-mapped forms before expand (e.g. ::ffff:127.0.0.1).
  const dottedMapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    || raw.match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dottedMapped) return isBlockedIpv4(dottedMapped[1]);

  const normalised = expandIpv6(raw) || raw;
  if (!normalised) return true;
  if (normalised === "0000:0000:0000:0000:0000:0000:0000:0000") return true;
  if (normalised === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
  if (normalised.startsWith("fc") || normalised.startsWith("fd")) return true;
  if (normalised.startsWith("fe80:")) return true;
  if (normalised.startsWith("ff")) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:xxxx:yyyy)
  const dotted = normalised.match(/^0000:0000:0000:0000:0000:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedIpv4(dotted[1]);
  const hexMapped = normalised.match(/^0000:0000:0000:0000:0000:ffff:([0-9a-f]{4}):([0-9a-f]{4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1], 16);
    const lo = Number.parseInt(hexMapped[2], 16);
    const ipv4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    return isBlockedIpv4(ipv4);
  }
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

function addressFamily(ip) {
  const version = isIP(ip);
  if (version === 4) return 4;
  if (version === 6) return 6;
  return 0;
}

/**
 * Fetch that pins DNS to addresses validated at policy time (mitigates DNS rebinding).
 */
export function fetchWithPinnedAddresses(url, init = {}, pinnedAddresses = []) {
  const addresses = [...new Set((pinnedAddresses || []).map(String).filter(Boolean))];
  if (!addresses.length) {
    return Promise.reject(new Error("No pinned addresses available for outbound fetch"));
  }

  const parsed = new NodeURL(String(url));
  const transport = parsed.protocol === "http:" ? http : https;
  const method = String(init.method || "GET").toUpperCase();
  const headers = { ...(init.headers || {}) };
  const body = init.body == null ? null : Buffer.from(String(init.body));
  if (body && !headers["Content-Length"] && !headers["content-length"]) {
    headers["Content-Length"] = String(body.length);
  }

  const lookup = (hostname, options, callback) => {
    let opts = options;
    let cb = callback;
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    const wantedFamily = typeof opts === "number"
      ? opts
      : (opts && opts.family) || 0;
    const wantAll = Boolean(opts && typeof opts === "object" && opts.all);
    const matches = addresses
      .map((address) => ({ address, family: addressFamily(address) }))
      .filter((item) => item.family && (!wantedFamily || item.family === wantedFamily));
    if (!matches.length) {
      cb(new Error("Pinned address is not a valid IP"));
      return;
    }
    if (wantAll) {
      cb(null, matches);
      return;
    }
    cb(null, matches[0].address, matches[0].family);
  };

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      lookup,
      signal: init.signal
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve(new Response(buffer, {
          status: response.statusCode || 0,
          statusText: response.statusMessage || "",
          headers: response.headers
        }));
      });
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

export function createOutboundUrlPolicy(envInput = {}, {
  dnsLookup = defaultDnsLookup,
  fetchImpl = null,
  pinDns = true
} = {}) {
  const env = envInput || {};
  const mode = String(env.VIBBIT_DEPLOYMENT_MODE || "self-hosted").trim().toLowerCase();
  const isHosted = mode === "hosted";
  const allowPrivateEndpoints = !isHosted && parseBoolean(env.VIBBIT_ALLOW_PRIVATE_ENDPOINTS, false);
  const configuredAllowList = parseCsv(env.VIBBIT_CUSTOM_ENDPOINT_ALLOWLIST);
  const allowList = [...new Set([
    ...BUILTIN_ENDPOINT_ALLOWLIST,
    ...configuredAllowList
  ])];
  const shouldPinDns = pinDns && parseBoolean(env.VIBBIT_OUTBOUND_DNS_PINNING, true);

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

    let addresses = [];
    if (!allowPrivateEndpoints || isHosted) {
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
    } else if (isIP(hostname)) {
      addresses = [hostname];
    } else {
      try {
        addresses = await resolveAddresses(hostname);
      } catch {
        addresses = [];
      }
    }

    return {
      href: parsed.toString().replace(/\/+$/, ""),
      hostname,
      protocol: parsed.protocol,
      addresses
    };
  }

  async function assertSafeRedirect(location, { purpose = "custom endpoint redirect" } = {}) {
    if (!location) throw new Error(`${purpose}: missing Location`);
    // Re-validate every redirect target with the same policy.
    return assertSafeUrl(location, { purpose });
  }

  async function fetchSafe(url, init = {}, { purpose = "custom endpoint" } = {}) {
    const safe = await assertSafeUrl(url, { purpose });
    if (typeof fetchImpl === "function") {
      return fetchImpl(url, init, safe);
    }
    if (shouldPinDns && safe.addresses.length) {
      return fetchWithPinnedAddresses(url, init, safe.addresses);
    }
    return fetch(url, init);
  }

  return {
    isHosted,
    allowPrivateEndpoints,
    allowList,
    assertSafeUrl,
    assertSafeRedirect,
    fetchSafe
  };
}
