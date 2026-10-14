import { Router } from "express";
import multer from "multer";
import { HttpError } from "../../middleware/error.js";
import { requireAuth } from "../../middleware/auth.js";
import { storeImage } from "../../lib/imageStorage.js";

// 4 MB: uploads pass through the frontend, and Vercel rejects request bodies over 4.5 MB.
const MAX_BYTES = 4 * 1024 * 1024;

/** Identify the image type from its first bytes, not the (spoofable) filename or MIME header. */
function sniffImage(buf: Buffer): "jpg" | "png" | "webp" | "gif" | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a") return "gif";
  return null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

export const adminUploadsRouter = Router();

adminUploadsRouter.post("/", requireAuth("admin"), (req, res, next) => {
  upload.single("file")(req, res, async (err: unknown) => {
    try {
      if (err instanceof multer.MulterError) {
        throw new HttpError(400, err.code === "LIMIT_FILE_SIZE" ? "Image is too large (max 4 MB)." : err.message);
      }
      if (err) throw err;
      if (!req.file) throw new HttpError(400, "Choose an image to upload.");

      const ext = sniffImage(req.file.buffer);
      if (!ext) throw new HttpError(400, "That file isn't a supported image. Use JPG, PNG, WebP or GIF.");

      // Cloudinary when configured, otherwise the local uploads folder.
      res.status(201).json({ url: await storeImage(req.file.buffer, ext) });
    } catch (e) {
      next(e);
    }
  });
});
