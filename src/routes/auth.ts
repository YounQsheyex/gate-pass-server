import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { HttpError } from "../middleware/error.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { SESSION_COOKIE, cookieOptions, createSession, requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
});

// Compared against when the email doesn't exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

authRouter.post("/login", authLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await User.findOne({ email: email.toLowerCase() }).select("+passwordHash");
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || !user.active) throw new HttpError(401, "Wrong email or password");

  res.cookie(SESSION_COOKIE, await createSession(String(user._id)), cookieOptions);
  res.json({ user: { id: String(user._id), name: user.name, email: user.email, role: user.role } });
});

authRouter.post("/logout", (_req, res) => {
  const { maxAge: _maxAge, ...opts } = cookieOptions;
  res.clearCookie(SESSION_COOKIE, opts);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth(), (req, res) => {
  res.json({ user: req.user });
});
