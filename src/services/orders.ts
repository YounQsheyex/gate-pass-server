import { Types } from "mongoose";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";
import { Event } from "../models/Event.js";
import { TicketType } from "../models/TicketType.js";
import { Order, type OrderDoc } from "../models/Order.js";
import { Ticket } from "../models/Ticket.js";
import { formatNaira, orderReference } from "../lib/util.js";
import { release, reserve } from "./inventory.js";
import { issueTickets } from "./tickets.js";
import { sendTicketsEmail } from "./mailer.js";

export const MAX_TICKETS_PER_ORDER = 20;

export type CreateOrderInput = {
  eventId: string;
  items: { ticketTypeId: string; quantity: number }[];
  buyer: { name: string; email: string; phone: string };
};

export async function createOrder(input: CreateOrderInput) {
  const event = await Event.findById(input.eventId);
  if (!event || event.status !== "published") throw new HttpError(404, "Event not found");
  if (event.startsAt.getTime() < Date.now()) throw new HttpError(400, "This event has already started");
  if (event.soldOut) throw new HttpError(409, "This event is sold out");

  // Merge duplicate lines and validate against the event's ticket types.
  const merged = new Map<string, number>();
  for (const item of input.items) {
    merged.set(item.ticketTypeId, (merged.get(item.ticketTypeId) ?? 0) + item.quantity);
  }

  const types = await TicketType.find({ event: event._id, _id: { $in: [...merged.keys()] } });

  let totalQty = 0;
  const lines = [...merged].map(([ticketTypeId, quantity]) => {
    const tt = types.find((t) => t._id.equals(ticketTypeId));
    if (!tt) throw new HttpError(400, "Unknown ticket type");
    if (tt.soldOut) throw new HttpError(409, `"${tt.name}" is sold out`);
    if (quantity > tt.maxPerOrder) {
      throw new HttpError(400, `You can buy at most ${tt.maxPerOrder} "${tt.name}" tickets per order`);
    }
    totalQty += quantity;
    return {
      ticketTypeId: tt._id,
      name: tt.name,
      unitPrice: tt.price,
      quantity,
      capacity: tt.quantity,
    };
  });
  if (totalQty > MAX_TICKETS_PER_ORDER) {
    throw new HttpError(400, `At most ${MAX_TICKETS_PER_ORDER} tickets per order`);
  }

  const soldOut = await reserve(lines);
  if (soldOut) throw new HttpError(409, `Not enough "${soldOut}" tickets left`);

  try {
    return await Order.create({
      reference: orderReference(),
      event: event._id,
      eventTitle: event.title,
      buyer: input.buyer,
      items: lines.map(({ ticketTypeId, name, unitPrice, quantity }) => ({ ticketTypeId, name, unitPrice, quantity })),
      total: lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0),
      ticketCount: totalQty,
      expiresAt: new Date(Date.now() + env.ORDER_TTL_HOURS * 60 * 60 * 1000),
    });
  } catch (err) {
    await release(lines);
    throw err;
  }
}

export function whatsappLink(order: OrderDoc): string {
  const items = order.items.map((i) => `${i.quantity} × ${i.name}`).join(", ");
  const text = [
    "Hello! I'd like to pay for my tickets.",
    "",
    `Order: ${order.reference}`,
    `Event: ${order.eventTitle}`,
    `Tickets: ${items}`,
    `Total: ${formatNaira(order.total)}`,
    `Name: ${order.buyer.name}`,
    "",
    "Please send me the account details.",
  ].join("\n");
  return `https://wa.me/${env.WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

export type ConfirmResult = { order: OrderDoc; emailed: boolean; emailError?: string };

/**
 * Marks an order paid, issues its tickets and emails them. Pending orders and
 * orders that expired before the admin got to them can both be confirmed; an
 * expired order first has to win its tickets back from inventory.
 */
export async function confirmOrder(orderId: string, adminId: string, note?: string): Promise<ConfirmResult> {
  const existing = await Order.findById(orderId);
  if (!existing) throw new HttpError(404, "Order not found");
  if (existing.status === "paid") throw new HttpError(409, "Order is already confirmed");
  if (existing.status === "cancelled") throw new HttpError(409, "Order was cancelled");

  const wasExpired = existing.status === "expired";
  if (wasExpired) {
    const types = await TicketType.find({ _id: { $in: existing.items.map((i) => i.ticketTypeId) } });
    const lines = existing.items.map((i) => {
      const tt = types.find((t) => t._id.equals(i.ticketTypeId));
      return { ticketTypeId: i.ticketTypeId, quantity: i.quantity, name: i.name, capacity: tt?.quantity ?? 0 };
    });
    const soldOut = await reserve(lines);
    if (soldOut) {
      throw new HttpError(409, `This order expired and "${soldOut}" has since sold out. Refund the buyer or raise the quantity first.`);
    }
  }

  const order = await Order.findOneAndUpdate(
    { _id: existing._id, status: existing.status },
    {
      $set: { status: "paid", paidAt: new Date(), confirmedBy: new Types.ObjectId(adminId), paymentNote: note },
    },
    { new: true },
  );
  if (!order) {
    // Someone else changed it between our read and write; undo our re-reservation.
    if (wasExpired) await release(existing.items);
    throw new HttpError(409, "Order changed while confirming. Refresh and try again.");
  }

  return deliverTickets(order);
}

/** Issues (idempotently) and emails the tickets for a paid order. Safe to call again to resend. */
export async function deliverTickets(order: OrderDoc): Promise<ConfirmResult> {
  const tickets = await issueTickets(order);
  try {
    await sendTicketsEmail(order, tickets);
    order.ticketsEmailedAt = new Date();
    order.emailError = undefined;
    await order.save();
    return { order, emailed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Ticket email for ${order.reference} failed:`, message);
    order.emailError = message;
    await order.save();
    return { order, emailed: false, emailError: message };
  }
}

/** Cancels a pending/expired order, or refunds a paid one (its tickets are voided). */
export async function cancelOrder(orderId: string, adminId: string, reason?: string) {
  const existing = await Order.findById(orderId);
  if (!existing) throw new HttpError(404, "Order not found");
  if (existing.status === "cancelled") throw new HttpError(409, "Order is already cancelled");

  if (existing.status === "paid") {
    const used = await Ticket.countDocuments({ order: existing._id, status: "used" });
    if (used > 0) throw new HttpError(409, "Some tickets on this order have already been used at the gate");
  }

  const order = await Order.findOneAndUpdate(
    { _id: existing._id, status: existing.status },
    {
      $set: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy: new Types.ObjectId(adminId),
        cancelReason: reason,
      },
    },
    { new: true },
  );
  if (!order) throw new HttpError(409, "Order changed while cancelling. Refresh and try again.");

  // Expired orders already gave their tickets back.
  if (existing.status !== "expired") await release(order.items);
  if (existing.status === "paid") {
    await Ticket.updateMany({ order: order._id, status: "valid" }, { $set: { status: "void" } });
  }
  return order;
}

/** Releases tickets held by unpaid orders past their expiry. */
export async function expireStaleOrders(): Promise<number> {
  const stale = await Order.find({ status: "pending", expiresAt: { $lt: new Date() } })
    .select("_id")
    .limit(200)
    .lean();

  let count = 0;
  for (const { _id } of stale) {
    const order = await Order.findOneAndUpdate(
      { _id, status: "pending", expiresAt: { $lt: new Date() } },
      { $set: { status: "expired" } },
      { new: true },
    );
    if (order) {
      await release(order.items);
      count++;
    }
  }
  return count;
}
