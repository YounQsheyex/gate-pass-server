import "dotenv/config";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  TRUST_PROXY: z.coerce.number().default(0),
  /**
   * Shared with the frontend. When the frontend forwards a request it sends the visitor's IP plus
   * this secret, so rate limits apply per visitor instead of to the frontend server.
   */
  PROXY_SECRET: z.string().min(16, "PROXY_SECRET should be at least 16 random characters").optional().or(z.literal("").transform(() => undefined)),

  /** Name printed on tickets and in emails. */
  BRAND_NAME: z.string().default("Gatepass"),
  /** Public URL of the frontend, used for links in emails. */
  APP_URL: z.string().url().default("http://localhost:3000"),

  // Admin sessions
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  COOKIE_SECURE: bool.optional(),
  /** Use "none" when the frontend and API live on different sites (requires HTTPS). */
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),

  /** Ed25519 private key (PKCS#8 DER, base64). Generate with `npm run keys`. */
  TICKET_SIGNING_KEY: z.string().min(1, "Run `npm run keys` and paste the result into .env"),

  /** WhatsApp number buyers are sent to, international format without + (e.g. 2348012345678). */
  WHATSAPP_NUMBER: z.string().regex(/^\d{10,15}$/, "Digits only, with country code, e.g. 2348012345678"),
  /** Hours an unpaid order holds its tickets before they are released. */
  ORDER_TTL_HOURS: z.coerce.number().positive().default(24),

  // Email. Leave SMTP_HOST empty in development to write emails to backend/.mail instead.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** Sender, e.g. "Gatepass Tickets <tickets@yourdomain.com>". With Resend, the domain must be verified there. */
  MAIL_FROM: z.string().default("Tickets <no-reply@localhost>"),
  /** Optional address buyers' replies go to (e.g. your support inbox). */
  MAIL_REPLY_TO: z.email().optional().or(z.literal("").transform(() => undefined)),
  /** Resend API key (re_...). When set, emails are sent through Resend instead of SMTP. */
  RESEND_API_KEY: z
    .string()
    .regex(/^re_\w+/, "Resend API keys start with re_")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** Only for testing against a stand-in server. */
  RESEND_API_URL: z.string().url().default("https://api.resend.com"),

  // Event images. Set CLOUDINARY_URL (copy it from the Cloudinary dashboard) to store uploads there;
  // leave it empty to save them in backend/uploads instead.
  CLOUDINARY_URL: z
    .string()
    .regex(/^cloudinary:\/\/[^:]+:[^@]+@[^/?]+/, "Should look like cloudinary://<api_key>:<api_secret>@<cloud_name>")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default("gatepass/events"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  COOKIE_SECURE: parsed.data.COOKIE_SECURE ?? parsed.data.NODE_ENV === "production",
};
