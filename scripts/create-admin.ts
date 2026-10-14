/**
 * Creates (or resets the password of) an admin account:
 *   npm run create-admin -- you@example.com "Your Name" "a-strong-password"
 */
import bcrypt from "bcryptjs";
import { connectDb, disconnectDb } from "../src/lib/db.js";
import { User } from "../src/models/User.js";

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error('Usage: npm run create-admin -- <email> "<name>" "<password>"');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}

await connectDb();
const passwordHash = await bcrypt.hash(password, 12);
await User.updateOne(
  { email: email.toLowerCase() },
  { $set: { name, passwordHash, role: "admin", active: true } },
  { upsert: true },
);
console.log(`Admin ready: ${email.toLowerCase()}`);
await disconnectDb();
