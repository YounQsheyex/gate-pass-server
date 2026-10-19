import { Types } from "mongoose";
import { HttpError } from "../middleware/error.js";
import { Event } from "../models/Event.js";
import { Order, type OrderDoc } from "../models/Order.js";
import { Ticket, type TicketDoc } from "../models/Ticket.js";
import { timingSafeEqual } from "node:crypto";
import { entryCodeFor, normalizeEntryCode, signTicket, verifyTicketToken } from "../lib/ticketToken.js";
import { redis } from "../lib/redis.js";

/** Creates one ticket per seat on a paid order. Running it twice never creates duplicates. */
export async function issueTickets(order: OrderDoc): Promise<TicketDoc[]> {
  if (order.status !== "paid") throw new HttpError(409, "Order is not paid");

  const docs: Record<string, unknown>[] = [];
  let seq = 0;
  for (const item of order.items) {
    for (let i = 0; i < item.quantity; i++) {
      docs.push({
        event: order.event,
        order: order._id,
        seq: seq++,
        ticketTypeId: item.ticketTypeId,
        ticketTypeName: item.name,
        holderName: order.buyer.name,
      });
    }
  }

  const existing = new Set(
    (await Ticket.find({ order: order._id }).select("seq").lean()).map((t) => t.seq),
  );
  const missing = docs.filter((d) => !existing.has(d.seq as number));
  if (missing.length) {
    try {
      await Ticket.insertMany(missing, { ordered: false });
    } catch (err) {
      // A concurrent call already inserted some of them; the unique {order, seq} index makes that safe.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  return Ticket.find({ order: order._id }).sort({ seq: 1 });
}

export function ticketToken(ticket: TicketDoc): string {
  return signTicket(ticket._id, ticket.event);
}

/** Short id for finding a ticket in the dashboard. Sequential within an order, so never accepted at the gate. */
export function ticketShortId(id: Types.ObjectId): string {
  return id.toString().slice(-8).toUpperCase();
}

export type CheckinResult =
  | { result: "admitted"; ticket: TicketSummary }
  | { result: "already_used"; ticket: TicketSummary }
  | { result: "void" | "unpaid"; ticket?: TicketSummary }
  | { result: "wrong_event"; ticket?: TicketSummary; ticketEvent?: { id: string; title: string } }
  | { result: "invalid" };

type TicketSummary = {
  id: string;
  shortId: string;
  holderName: string;
  ticketTypeName: string;
  orderReference?: string;
  checkedInAt?: Date | null;
};

function summary(t: TicketDoc, orderReference?: string): TicketSummary {
  return {
    id: String(t._id),
    shortId: ticketShortId(t._id),
    holderName: t.holderName,
    ticketTypeName: t.ticketTypeName,
    orderReference,
    checkedInAt: t.checkedInAt,
  };
}

/**
 * Validates a scanned QR and, unless dryRun, admits the holder.
 *
 * Two layers stop the same ticket getting in twice when it's scanned at two gates at once:
 *  1. a short Redis lock per ticket (SET NX), so only one scan proceeds;
 *  2. the admit itself is a conditional update (valid → used) in MongoDB, which stays
 *     the source of truth if Redis is ever flushed.
 */
export async function checkIn(opts: {
  token: string;
  eventId?: string;
  staffId: string;
  dryRun?: boolean;
}): Promise<CheckinResult> {
  const verified = verifyTicketToken(opts.token);
  if (!verified) return { result: "invalid" };

  if (opts.eventId && !verified.eventId.equals(opts.eventId)) {
    const t = await Ticket.findById(verified.ticketId);
    if (!t) return { result: "invalid" };
    return { result: "wrong_event", ticket: summary(t), ticketEvent: await eventRef(t.event) };
  }

  const ticket = await Ticket.findById(verified.ticketId);
  // A genuine signature for a ticket we can't find means it was deleted: treat as invalid.
  if (!ticket || !ticket.event.equals(verified.eventId)) return { result: "invalid" };

  return admit(ticket, { ...opts, method: "scan" });
}

/** "tk-yd0w0 mf6zs", "YD0W0MF6ZS", "TK-YDOWO-MF6ZS" → "TK-YD0W0-MF6ZS" (null if it can't be one). */
export function normalizeReference(input: string): string | null {
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("TK") && s.length === 12) s = s.slice(2);
  // Order references use Crockford base32, so letters people commonly mistype map back to digits.
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(s)) return null;
  return `TK-${s.slice(0, 5)}-${s.slice(5)}`;
}

/** The code printed under the QR, typed in at the gate when the QR can't be scanned. */
export function ticketEntryCode(ticket: { _id: Types.ObjectId }): string {
  return entryCodeFor(ticket._id);
}

function sameCode(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Check-in without a camera: the ticket's entry code plus the order reference, both printed
 * on the ticket. The entry code is derived from the server's private key, so it can't be
 * guessed or worked out from another ticket, even one in the same order, and the order
 * reference is random too. A wrong pair always gives the same "invalid" answer, never
 * revealing which half was wrong.
 */
export async function checkInManual(opts: {
  reference: string;
  entryCode: string;
  eventId?: string;
  staffId: string;
  dryRun?: boolean;
}): Promise<CheckinResult> {
  const reference = normalizeReference(opts.reference);
  const code = normalizeEntryCode(opts.entryCode);
  if (!reference || !code) return { result: "invalid" };

  const order = await Order.findOne({ reference }).select("_id").lean();
  if (!order) return { result: "invalid" };
  const tickets = await Ticket.find({ order: order._id });
  const ticket = tickets.find((t) => sameCode(ticketEntryCode(t), code));
  if (!ticket) return { result: "invalid" };

  if (opts.eventId && !ticket.event.equals(opts.eventId)) {
    return { result: "wrong_event", ticket: summary(ticket, reference), ticketEvent: await eventRef(ticket.event) };
  }
  return admit(ticket, { ...opts, method: "manual" });
}

/** Which event a ticket is really for, so the gate can switch to it in one tap. */
async function eventRef(id: Types.ObjectId) {
  const e = await Event.findById(id).select("title").lean();
  return e ? { id: String(e._id), title: e.title } : undefined;
}

async function admit(
  ticket: TicketDoc,
  opts: { staffId: string; dryRun?: boolean; method: "scan" | "manual" },
): Promise<CheckinResult> {
  const order = await Order.findById(ticket.order).select("reference status").lean();
  const ref = order?.reference;
  if (!order || order.status !== "paid") return { result: "unpaid", ticket: summary(ticket, ref) };
  if (ticket.status === "void") return { result: "void", ticket: summary(ticket, ref) };
  if (ticket.status === "used") return { result: "already_used", ticket: summary(ticket, ref) };
  if (opts.dryRun) return { result: "admitted", ticket: summary(ticket, ref) };

  const lockKey = `checkin:${ticket._id}`;
  let locked: string | null = "OK";
  try {
    locked = await redis.set(lockKey, opts.staffId, "EX", 30, "NX");
  } catch (err) {
    // Redis is down: carry on with the database's conditional update alone, so the gate keeps working.
    console.error("Check-in lock unavailable, relying on the database:", (err as Error).message);
  }
  if (!locked) {
    const now = await Ticket.findById(ticket._id);
    return { result: "already_used", ticket: summary(now ?? ticket, ref) };
  }

  let admitted;
  try {
    admitted = await Ticket.findOneAndUpdate(
      { _id: ticket._id, status: "valid" },
      {
        $set: {
          status: "used",
          checkedInAt: new Date(),
          checkedInBy: new Types.ObjectId(opts.staffId),
          checkInMethod: opts.method,
        },
      },
      { new: true },
    );
  } catch (err) {
    await redis.del(lockKey).catch(() => {}); // let the ticket be scanned again once the database is back
    throw err;
  }
  if (!admitted) {
    const now = await Ticket.findById(ticket._id);
    return { result: now?.status === "void" ? "void" : "already_used", ticket: summary(now ?? ticket, ref) };
  }
  return { result: "admitted", ticket: summary(admitted, ref) };
}
