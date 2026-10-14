import type { ErrorRequestHandler, RequestHandler } from "express";
import mongoose from "mongoose";
import { z, ZodError } from "zod";
import { env } from "../config/env.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    res.status(400).json({
      error: issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Validation failed",
      issues: z.flattenError(err).fieldErrors,
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ error: `Invalid ${err.path}` });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }
  console.error(err);
  res.status(500).json({
    error: "Internal server error",
    ...(env.NODE_ENV !== "production" && { detail: String(err?.message ?? err) }),
  });
};
