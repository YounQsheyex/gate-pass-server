/**
 * Where uploaded event images go.
 *
 * - Cloudinary, when CLOUDINARY_URL (or the three CLOUDINARY_* keys) is set. Images survive
 *   redeploys and are served from Cloudinary's CDN, resized and compressed automatically.
 * - Otherwise the local backend/uploads folder (fine for development; on hosts without a
 *   persistent disk those files vanish on redeploy).
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";

export const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

function cloudinaryConfig() {
  if (env.CLOUDINARY_URL) {
    // cloudinary://<api_key>:<api_secret>@<cloud_name>, exactly as shown on the Cloudinary dashboard.
    const u = new URL(env.CLOUDINARY_URL);
    const extra = Object.fromEntries(u.searchParams.entries());
    return {
      cloud_name: u.hostname,
      api_key: decodeURIComponent(u.username),
      api_secret: decodeURIComponent(u.password),
      ...extra,
    };
  }
  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    return {
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
    };
  }
  return null;
}

const config = cloudinaryConfig();
if (config) cloudinary.config({ ...config, secure: true });

export const imageStorage = config ? `Cloudinary (cloud "${config.cloud_name}")` : `local folder ${UPLOAD_DIR}`;

/** Saves an already-validated image and returns the URL (or /uploads path) to store on the event. */
export async function storeImage(buffer: Buffer, ext: string): Promise<string> {
  if (config) {
    let result: UploadApiResponse;
    try {
      result = await new Promise<UploadApiResponse>((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            {
              folder: env.CLOUDINARY_FOLDER,
              resource_type: "image",
              unique_filename: true,
              overwrite: false,
              // Cap huge phone photos at 2000px on the longest side; keeps the original's look.
              transformation: [{ width: 2000, height: 2000, crop: "limit" }],
            },
            (err, res) => (err || !res ? reject(err ?? new Error("Empty response")) : resolve(res)),
          )
          .end(buffer);
      });
    } catch (err) {
      const message = (err as { message?: string })?.message ?? String(err);
      console.error("Cloudinary upload failed:", message);
      throw new HttpError(502, `Couldn't upload the image to Cloudinary: ${message}`);
    }
    // Serve the best format/quality for each browser (WebP/AVIF where supported).
    return cloudinary.url(result.public_id, {
      secure: true,
      version: result.version,
      fetch_format: "auto",
      quality: "auto",
      analytics: false,
    });
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}.${ext}`;
  await writeFile(path.join(UPLOAD_DIR, name), buffer);
  // Stored as a path so it keeps working if the API's domain changes.
  return `/uploads/${name}`;
}
