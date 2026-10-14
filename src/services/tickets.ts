import { Types } from "mongoose";
import { HttpError } from "../middleware/error.js";
import { Order, type OrderDoc } from "../models/Order.js";
import { Ticket, type TicketDoc } from "../models/Ticket.js";
import { signTicket, verifyTicketToken } from "../lib/ticketToken.js";
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

/** Short human-readable id printed under the QR, for manual lookups at the gate. */
export function ticketShortId(id: Types.ObjectId): string {
  return id.toString().slice(-8).toUpperCase();
}

export type CheckinResult =
  | { result: "admitted"; ticket: TicketSummary }
  | { result: "already_used"; ticket: TicketSummary }
  | { result: "void" | "wrong_event" | "unpaid"; ticket?: TicketSummary }
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
    return { result: "wrong_event", ticket: t ? summary(t) : undefined };
  }

  const ticket = await Ticket.findById(verified.ticketId);
  // A genuine signature for a ticket we can't find means it was deleted: treat as invalid.
  if (!ticket || !ticket.event.equals(verified.eventId)) return { result: "invalid" };

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
      { $set: { status: "used", checkedInAt: new Date(), checkedInBy: new Types.ObjectId(opts.staffId) } },
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
