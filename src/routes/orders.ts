import { Router } from "express";
import { z } from "zod";
import { Event } from "../models/Event.js";
import { Order } from "../models/Order.js";
import { HttpError } from "../middleware/error.js";
import { orderLimiter } from "../middleware/rateLimit.js";
import { maskEmail, normalizePhone } from "../lib/util.js";
import { objectId } from "../lib/validate.js";
import { createOrder, whatsappLink } from "../services/orders.js";
import { publicVenue } from "./events.js";

export const ordersRouter = Router();

const createSchema = z.object({
  eventId: objectId,
  items: z
    .array(z.object({ ticketTypeId: objectId, quantity: z.number().int().min(1).max(50) }))
    .min(1, "Pick at least one ticket"),
  buyer: z.object({
    name: z.string().trim().min(2, "Enter your full name").max(100),
    email: z.email("Enter a valid email address").max(200),
    phone: z
      .string()
      .transform((v, ctx) => {
        const phone = normalizePhone(v);
        if (!phone) {
          ctx.addIssue({ code: "custom", message: "Enter a valid phone number" });
          return z.NEVER;
        }
        return phone;
      }),
  }),
});

ordersRouter.post("/", orderLimiter, async (req, res) => {
  const input = createSchema.parse(req.body);
  const order = await createOrder(input);
  res.status(201).json({
    reference: order.reference,
    whatsappUrl: whatsappLink(order),
  });
});

/**
 * Public order status. The reference is random (50 bits) and only the buyer has it,
 * but we still only return what the buyer needs and mask their email.
 */
ordersRouter.get("/:reference", async (req, res) => {
  const reference = String(req.params.reference).toUpperCase();
  if (!/^TK-[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(reference)) throw new HttpError(404, "Order not found");

  const order = await Order.findOne({ reference });
  if (!order) throw new HttpError(404, "Order not found");
  const event = await Event.findById(order.event).select("title slug venue venueHidden venueHint startsAt").lean();

  res.json({
    order: {
      reference: order.reference,
      status: order.status,
      items: order.items.map((i) => ({ name: i.name, unitPrice: i.unitPrice, quantity: i.quantity })),
      total: order.total,
      currency: order.currency,
      expiresAt: order.expiresAt,
      paidAt: order.paidAt ?? null,
      ticketsEmailed: Boolean(order.ticketsEmailedAt),
      buyer: { name: order.buyer.name, email: maskEmail(order.buyer.email) },
      event: event
        ? // Even paid orders don't reveal a secret venue here: the order page only needs the
          // reference, so the address stays on the ticket (email/PDF) where it belongs.
          { title: event.title, slug: event.slug, ...publicVenue(event), startsAt: event.startsAt }
        : { title: order.eventTitle, slug: null, venue: null, venueHidden: false, venueHint: null, startsAt: null },
      whatsappUrl: order.status === "pending" || order.status === "expired" ? whatsappLink(order) : null,
    },
  });
});
