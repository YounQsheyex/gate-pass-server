import { randomBytes } from "node:crypto";

// Crockford base32: no I, L, O, U, so references are easy to read out over the phone.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** e.g. "TK-7F3K9-Q2MXA" (50 random bits). */
export function orderReference(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return `TK-${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Normalises Nigerian-style numbers to international digits: 08012345678 → 2348012345678. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  let out = digits;
  if (digits.length === 11 && digits.startsWith("0")) out = `234${digits.slice(1)}`;
  else if (digits.length === 10 && /^[789]/.test(digits)) out = `234${digits}`;
  return /^\d{10,15}$/.test(out) ? out : null;
}

export function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString("en-NG", {
    minimumFractionDigits: kobo % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${"*".repeat(Math.max(1, user.length - visible.length))}@${domain}`;
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
