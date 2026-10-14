import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { eventsRouter } from "./routes/events.js";
import { ordersRouter } from "./routes/orders.js";
import { adminEventsRouter } from "./routes/admin/events.js";
import { adminOrdersRouter } from "./routes/admin/orders.js";
import { adminUsersRouter } from "./routes/admin/users.js";
import { checkinRouter } from "./routes/admin/checkin.js";
import { adminUploadsRouter } from "./routes/admin/uploads.js";
import { UPLOAD_DIR } from "./lib/imageStorage.js";

export function createApp() {
  const app = express();

  // Needed so rate limiting sees the real client IP behind a proxy / load balancer.
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()), credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.use("/health", healthRouter);

  // Uploaded event images. Helmet's default would stop the frontend (a different origin)
  // from displaying them, so these responses explicitly allow cross-origin use.
  app.use(
    "/uploads",
    (_req, res, next) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      next();
    },
    express.static(UPLOAD_DIR, { maxAge: "30d", immutable: true, index: false, dotfiles: "deny" }),
  );
  app.use("/api", apiLimiter);

  // Public
  app.use("/api/events", eventsRouter);
  app.use("/api/orders", ordersRouter);

  // Admin & gate staff
  app.use("/api/auth", authRouter);
  app.use("/api/admin/events", adminEventsRouter);
  app.use("/api/admin/orders", adminOrdersRouter);
  app.use("/api/admin/users", adminUsersRouter);
  app.use("/api/admin/checkin", checkinRouter);
  app.use("/api/admin/uploads", adminUploadsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
