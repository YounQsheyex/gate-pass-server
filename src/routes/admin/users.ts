import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User, ROLES } from "../../models/User.js";
import { HttpError } from "../../middleware/error.js";
import { requireAuth } from "../../middleware/auth.js";
import { objectId } from "../../lib/validate.js";

export const adminUsersRouter = Router();
adminUsersRouter.use(requireAuth("admin"));

const shape = (u: { _id: unknown; name: string; email: string; role: string; active: boolean }) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  role: u.role,
  active: u.active,
});

adminUsersRouter.get("/", async (_req, res) => {
  const users = await User.find().sort({ createdAt: 1 }).lean();
  res.json({ users: users.map(shape) });
});

const createBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(200),
  password: z.string().min(8, "At least 8 characters").max(200),
  role: z.enum(ROLES).default("staff"),
});

adminUsersRouter.post("/", async (req, res) => {
  const input = createBody.parse(req.body);
  if (await User.exists({ email: input.email.toLowerCase() })) {
    throw new HttpError(409, "A user with that email already exists");
  }
  const user = await User.create({
    name: input.name,
    email: input.email,
    role: input.role,
    passwordHash: await bcrypt.hash(input.password, 12),
  });
  res.status(201).json({ user: shape(user) });
});

const updateBody = z.object({
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
});

adminUsersRouter.patch("/:id", async (req, res) => {
  const id = objectId.parse(req.params.id);
  const input = updateBody.parse(req.body);
  if (id === req.user!.id && (input.active === false || input.role === "staff")) {
    throw new HttpError(400, "You can't demote or deactivate yourself");
  }
  const set: Record<string, unknown> = {};
  if (input.role) set.role = input.role;
  if (input.active !== undefined) set.active = input.active;
  if (input.password) set.passwordHash = await bcrypt.hash(input.password, 12);

  const { matchedCount } = await User.updateOne({ _id: id }, { $set: set });
  const user = matchedCount ? await User.findById(id) : null;
  if (!user) throw new HttpError(404, "User not found");
  res.json({ user: shape(user) });
});
