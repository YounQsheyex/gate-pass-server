import { Router } from "express";
import mongoose from "mongoose";
import { redis } from "../lib/redis.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const mongo = mongoose.connection.readyState === 1 ? "up" : "down";
  const cache = await redis.ping().then(() => "up").catch(() => "down");
  const ok = mongo === "up" && cache === "up";
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", mongo, redis: cache });
});
