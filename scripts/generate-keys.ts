/**
 * Prints fresh secrets for .env:
 *   npm run keys
 *
 * Keep TICKET_SIGNING_KEY stable once tickets have been issued — changing it
 * invalidates every QR code already sent out.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

const { privateKey } = generateKeyPairSync("ed25519");
const der = privateKey.export({ format: "der", type: "pkcs8" });

console.log(`JWT_SECRET=${randomBytes(48).toString("base64url")}`);
console.log(`TICKET_SIGNING_KEY=${der.toString("base64")}`);
console.log(`PROXY_SECRET=${randomBytes(24).toString("base64url")}   # also set this on the frontend`);
