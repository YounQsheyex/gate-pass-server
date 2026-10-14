import { rateLimit, type Options } from "express-rate-limit";
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

function limiter(prefix: string, opts: Partial<Options>) {
  return rateLimit({
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
