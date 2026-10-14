import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const ROLES = ["admin", "staff"] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    /** admin: everything. staff: gate check-in only. */
    role: { type: String, enum: ROLES, default: "staff", required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model("User", userSchema);
