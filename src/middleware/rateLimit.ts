import type { Request } from "express";
import { rateLimit, ipKeyGenerator, type Options } from "express-rate-limit";
import { env } from "../config/env.js";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { redis } from "../lib/redis.js";

/**
 * rate-limit-redis loads its Lua scripts once, when the limiter is created. If Redis is
 * unreachable at that moment, the failed load is cached and every later request errors
 * even after Redis comes back. This store reloads the scripts and retries instead.
 */
class ResilientRedisStore extends RedisStore {
  private reload() {
    this.incrementScriptSha = this.loadIncrementScript();
    this.getScriptSha = this.loadGetScript();
    // Avoid unhandled-rejection noise if Redis is still down; the next request retries.
    this.incrementScriptSha.catch(() => {});
    this.getScriptSha.catch(() => {});
  }

  override async init(options: Parameters<RedisStore["init"]>[0]) {
    try {
      await super.init(options);
    } catch (err) {
      console.error("Rate limiter couldn't reach Redis at startup; will retry on the next request:", (err as Error).message);
      this.incrementScriptSha.catch(() => {});
      this.getScriptSha.catch(() => {});
    }
  }

  override async increment(key: string) {
    try {
      return await super.increment(key);
    } catch {
      this.reload();
      return super.increment(key);
    }
  }
}

function store(prefix: string) {
  return new ResilientRedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<RedisReply>,
  });
}

/**
 * The visitor's IP. Requests forwarded by our own frontend carry the real visitor IP in
 * x-client-ip, trusted only when they also carry the shared PROXY_SECRET; anything else
 * uses the connection's IP (with TRUST_PROXY handling the host's load balancer).
 */
let warnedNoSecret = false;
export function visitorIp(req: Request): string {
  const forwarded = req.get("x-client-ip");
  if (forwarded && env.PROXY_SECRET && req.get("x-proxy-secret") === env.PROXY_SECRET) return forwarded;
  if (req.get("x-client-ip") && !env.PROXY_SECRET && !warnedNoSecret) {
    warnedNoSecret = true;
    console.warn("[rate-limit] Requests are coming through the frontend, but PROXY_SECRET isn't set on both apps, so every visitor shares one rate limit. Set the same PROXY_SECRET on the frontend and the backend.");
  }
  return req.ip ?? "unknown";
}

function limiter(prefix: string, opts: Partial<Options>) {
  return rateLimit({
    keyGenerator: (req) => ipKeyGenerator(visitorIp(req)),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    store: store(prefix),
    // If Redis is down, let requests through (and log) rather than taking the whole site down.
    passOnStoreError: true,
    message: { error: "Too many requests, please try again later." },
    ...opts,
  });
}

/** Default for the whole API. */
export const apiLimiter = limiter("api", { windowMs: 60_000, limit: 120 });

/** Admin login. Only failed attempts count, so a busy admin is never locked out. */
export const authLimiter = limiter("auth", {
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { error: "Too many failed sign-in attempts. Try again in 15 minutes." },
});

/** Placing orders (each one holds tickets, so this stops someone draining inventory). */
export const orderLimiter = limiter("order", { windowMs: 10 * 60_000, limit: 5 });

/**
 * Gate scanning. Mounted after requireAuth and keyed per staff account rather than per IP,
 * because several scanners at one venue usually share a single network.
 */
export const checkinLimiter = limiter("checkin", {
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (req) => `user:${req.user?.id ?? "anon"}`,
});

/**
 * Typed-in check-ins. Only wrong entry code / reference pairs count, so a busy gate is
 * never slowed down, but someone trying combinations is stopped after a handful.
 */
export const manualCheckinLimiter = limiter("checkin-manual", {
  windowMs: 10 * 60_000,
  limit: 10,
  keyGenerator: (req) => `user:${req.user?.id ?? "anon"}`,
  requestWasSuccessful: (_req, res) => res.locals.manualCheckinFailed !== true,
  skipSuccessfulRequests: true,
  message: { error: "Too many wrong entry codes. Typed entry is paused for 10 minutes; use the camera or check the order in Orders." },
});
