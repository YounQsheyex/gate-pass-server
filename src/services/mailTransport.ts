/**
 * Delivers an email through whichever provider is configured, in this order:
 *   1. Resend      (RESEND_API_KEY)
 *   2. SMTP        (SMTP_HOST)
 *   3. Development: saved to backend/.mail/ so you can open it, nothing is sent
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";

export type MailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
  /** Set for images shown inside the HTML via <img src="cid:...">. */
  cid?: string;
};

export type MailMessage = {
  to: { name: string; email: string };
  subject: string;
  text: string;
  /** HTML that references inline images by cid. */
  html: string;
  /** Same HTML with images embedded as data: URIs, used for the saved development copy. */
  previewHtml?: string;
  attachments: MailAttachment[];
  /** Short label for log lines / saved file names, e.g. the order reference. */
  tag?: string;
};

const DEV_MAIL_DIR = path.resolve(process.cwd(), ".mail");

export const mailProvider = env.RESEND_API_KEY ? "Resend" : env.SMTP_HOST ? `SMTP (${env.SMTP_HOST})` : `saved to ${DEV_MAIL_DIR} (not sent)`;

if (env.RESEND_API_KEY && /@localhost>?$/.test(env.MAIL_FROM)) {
  console.warn(
    "[mail] RESEND_API_KEY is set but MAIL_FROM is still the placeholder. Set MAIL_FROM to an address on a domain " +
      'you verified in Resend, e.g. "Gatepass Tickets <tickets@yourdomain.com>". For a quick test you can use ' +
      '"onboarding@resend.dev", which only delivers to your own Resend account email.',
  );
}

const quoteName = (name: string) => `"${name.replace(/["\\\r\n]/g, "")}"`;

export async function sendMail(msg: MailMessage): Promise<void> {
  if (env.RESEND_API_KEY) return sendWithResend(msg, env.RESEND_API_KEY);
  if (env.SMTP_HOST) return sendWithSmtp(msg);
  return saveForDevelopment(msg);
}

// ---------------------------------------------------------------- Resend

async function sendWithResend(msg: MailMessage, apiKey: string) {
  const body = {
    from: env.MAIL_FROM,
    to: [`${quoteName(msg.to.name)} <${msg.to.email}>`],
    ...(env.MAIL_REPLY_TO && { reply_to: env.MAIL_REPLY_TO }),
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString("base64"),
      content_type: a.contentType,
      ...(a.cid && { content_id: a.cid }),
    })),
  };

  // Same key on every retry, so a request that timed out but actually went through isn't sent twice.
  const idempotencyKey = `${msg.tag ?? "mail"}-${randomUUID()}`;
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${env.RESEND_API_URL}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastError = `couldn't reach Resend (${(err as Error).message})`;
      await sleep(attempt * 1000);
      continue;
    }

    if (res.ok) {
      const { id } = (await res.json().catch(() => ({}))) as { id?: string };
      console.log(`[mail] Sent via Resend to ${msg.to.email}${id ? ` (id ${id})` : ""}`);
      return;
    }

    const err = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
    lastError = `Resend ${res.status}: ${err.message ?? res.statusText}`;
    // Retry only rate limits and server errors; anything else (bad key, unverified domain…) won't fix itself.
    if (res.status !== 429 && res.status < 500) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 1000);
  }
  throw new Error(lastError);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- SMTP

let transporter: Transporter | null = null;

async function sendWithSmtp(msg: MailMessage) {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  await transporter.sendMail({
    from: env.MAIL_FROM,
    to: `${quoteName(msg.to.name)} <${msg.to.email}>`,
    ...(env.MAIL_REPLY_TO && { replyTo: env.MAIL_REPLY_TO }),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
      ...(a.cid && { cid: a.cid, contentDisposition: "inline" as const }),
    })),
  });
}

// ---------------------------------------------------------------- Development

async function saveForDevelopment(msg: MailMessage) {
  await mkdir(DEV_MAIL_DIR, { recursive: true });
  const base = path.join(DEV_MAIL_DIR, `${Date.now()}-${msg.tag ?? "mail"}`);
  await writeFile(`${base}.html`, `<!-- To: ${msg.to.email} | ${msg.subject} -->\n${msg.previewHtml ?? msg.html}`);
  for (const a of msg.attachments) {
    if (a.contentType === "application/pdf") await writeFile(`${base}.pdf`, a.content);
  }
  console.log(`[mail] No email provider configured. Saved email for ${msg.to.email} to ${base}.html`);
}
