/**
 * Ticket QR codes.
 *
 * Each QR encodes:  T1.<base64url( ticketId[12] | eventId[12] | ed25519Signature[64] )>
 *
 * - The signature is made with a private key that only the server holds, so nobody can
 *   produce a valid code for a ticket that doesn't exist, or edit one (e.g. swap the event).
 * - A valid signature alone is not enough to get in: check-in also atomically flips the
 *   ticket in the database from "valid" to "used", so a screenshot or photocopy of a real
 *   ticket only works once.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { Types } from "mongoose";
import { env } from "../config/env.js";

const PREFIX = "T1.";
const ID_BYTES = 12;
const SIG_BYTES = 64;

let privateKey: KeyObject;
let publicKey: KeyObject;

function keys() {
  if (!privateKey) {
    privateKey = createPrivateKey({
      key: Buffer.from(env.TICKET_SIGNING_KEY, "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("TICKET_SIGNING_KEY must be an Ed25519 key (run `npm run keys`)");
    }
    publicKey = createPublicKey(privateKey);
  }
  return { privateKey, publicKey };
}

export function signTicket(ticketId: Types.ObjectId, eventId: Types.ObjectId): string {
  const payload = Buffer.concat([ticketId.id, eventId.id]);
  const signature = sign(null, payload, keys().privateKey);
  return PREFIX + Buffer.concat([payload, signature]).toString("base64url");
}

export type VerifiedToken = { ticketId: Types.ObjectId; eventId: Types.ObjectId };

/** Returns the ids if the signature is genuine, otherwise null. Does not touch the database. */
export function verifyTicketToken(token: string): VerifiedToken | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith(PREFIX)) return null;

  let raw: Buffer;
  try {
    raw = Buffer.from(trimmed.slice(PREFIX.length), "base64url");
  } catch {
    return null;
  }
  if (raw.length !== ID_BYTES * 2 + SIG_BYTES) return null;

  const payload = raw.subarray(0, ID_BYTES * 2);
  const signature = raw.subarray(ID_BYTES * 2);
  if (!verify(null, payload, keys().publicKey, signature)) return null;

  return {
    ticketId: new Types.ObjectId(payload.subarray(0, ID_BYTES)),
    eventId: new Types.ObjectId(payload.subarray(ID_BYTES)),
  };
}

/** Fail fast at startup if the key is missing or malformed. */
export function assertSigningKey() {
  keys();
}
