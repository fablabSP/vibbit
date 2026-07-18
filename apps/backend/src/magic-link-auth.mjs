/**
 * Email magic-link teacher authentication (optional hosted fallback).
 * Stores only SHA-256 hashes of one-time tokens.
 */

import { createHash, randomBytes } from "node:crypto";

const TOKEN_TTL_MS = 15 * 60 * 1000;

function normaliseEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 320);
}

function hashToken(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function createMagicLinkAuth(envInput = {}, {
  now = () => Date.now(),
  sendEmail
} = {}) {
  const env = envInput || {};
  const resendKey = String(env.VIBBIT_RESEND_API_KEY || env.RESEND_API_KEY || "").trim();
  const fromEmail = String(env.VIBBIT_MAGIC_LINK_FROM || "Vibbit <onboarding@resend.dev>").trim();
  const explicitlyEnabled = parseBoolean(env.VIBBIT_MAGIC_LINK_ENABLED, Boolean(resendKey));
  const enabled = explicitlyEnabled && (Boolean(resendKey) || parseBoolean(env.VIBBIT_MAGIC_LINK_DEV_CAPTURE, false));
  const pending = new Map(); // hash -> { email, expiresAt }
  const capturedLinks = [];
  const requestCounts = new Map(); // key -> { count, resetAt }

  const prune = () => {
    const ts = now();
    for (const [hash, entry] of pending.entries()) {
      if (!entry || entry.expiresAt <= ts) pending.delete(hash);
    }
  };

  const rateLimit = (key, limit, windowMs) => {
    const ts = now();
    const current = requestCounts.get(key);
    if (!current || current.resetAt <= ts) {
      requestCounts.set(key, { count: 1, resetAt: ts + windowMs });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  };

  const defaultSendEmail = async ({ to, subject, text, link }) => {
    if (resendKey) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [to],
          subject,
          text
        })
      });
      if (!response.ok) {
        throw new Error(`Magic-link email failed (${response.status})`);
      }
      return;
    }
    capturedLinks.push({ to, link, at: new Date(now()).toISOString() });
  };

  const mailer = typeof sendEmail === "function" ? sendEmail : defaultSendEmail;

  return {
    enabled,
    getCapturedLinks: () => capturedLinks.slice(),

    async requestLink({ email, publicOrigin, clientIp = "" }) {
      const normalised = normaliseEmail(email);
      // Always return the same shape to avoid account enumeration.
      const generic = {
        ok: true,
        message: "If that email can sign in, a magic link has been sent."
      };
      if (!enabled || !normalised || !normalised.includes("@")) return generic;

      prune();
      if (!rateLimit(`email:${normalised}`, 5, 15 * 60 * 1000)) return generic;
      if (!rateLimit(`ip:${clientIp || "unknown"}`, 20, 15 * 60 * 1000)) return generic;

      const token = randomBytes(32).toString("base64url");
      const hash = hashToken(token);
      pending.set(hash, {
        email: normalised,
        expiresAt: now() + TOKEN_TTL_MS
      });

      const link = `${String(publicOrigin || "").replace(/\/+$/, "")}/teacher/auth/magic/callback?token=${encodeURIComponent(token)}`;
      try {
        await mailer({
          to: normalised,
          subject: "Your Vibbit teacher sign-in link",
          text: `Sign in to the Vibbit teacher portal:\n\n${link}\n\nThis link expires in 15 minutes and can be used once.`,
          link
        });
      } catch {
        // Still return generic response.
      }
      return generic;
    },

    consumeToken(token) {
      prune();
      const hash = hashToken(token);
      const entry = pending.get(hash);
      if (!entry) return null;
      pending.delete(hash);
      if (entry.expiresAt <= now()) return null;
      return { email: entry.email };
    }
  };
}
