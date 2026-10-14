import type { CookieOptions, RequestHandler } from "express";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";
import { User, type Role } from "../models/User.js";
import { HttpError } from "./error.js";

export const SESSION_COOKIE = "tk_session";
const SESSION_HOURS = 12;
const secret = new TextEncoder().encode(env.JWT_SECRET);

export type SessionUser = { id: string; role: Role; name: string; email: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  path: "/",
  maxAge: SESSION_HOURS * 60 * 60 * 1000,
};

export async function createSession(userId: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secret);
}

/**
 * Verifies the session cookie and re-loads the user, so deactivating a user
 * or changing their role takes effect immediately.
 */
export function requireAuth(...roles: Role[]): RequestHandler {
  return async (req, _res, next) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new HttpError(401, "Not signed in");

    let userId: string | undefined;
    try {
      const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
      userId = payload.sub;
    } catch {
      throw new HttpError(401, "Session expired, please sign in again");
    }

    const user = userId ? await User.findById(userId).lean() : null;
    if (!user || !user.active) throw new HttpError(401, "Not signed in");
    if (roles.length && !roles.includes(user.role)) throw new HttpError(403, "Not allowed");

    req.user = { id: String(user._id), role: user.role, name: user.name, email: user.email };
    next();
  };
}
