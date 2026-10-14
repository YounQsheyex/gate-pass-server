import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { Event, EVENT_STATUSES, type EventDoc } from "../../models/Event.js";
import { TicketType, type TicketTypeDoc } from "../../models/TicketType.js";
import { Order } from "../../models/Order.js";
import { Ticket } from "../../models/Ticket.js";
import { HttpError } from "../../middleware/error.js";
import { requireAuth } from "../../middleware/auth.js";
import { slugify } from "../../lib/util.js";
import { objectId } from "../../lib/validate.js";

export const adminEventsRouter = Router();

const ticketTypeInput = z.object({
  id: objectId.optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(""),
  /** Kobo. */
  price: z.number().int().min(0),
  quantity: z.number().int().min(0).max(1_000_000),
  maxPerOrder: z.number().int().min(1).max(50).default(10),
});

const eventInput = z.object({
  title: z.string().trim().min(2).max(150),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and dashes only")
    .max(80)
    .optional()
    .or(z.literal("")),
  description: z.string().max(10_000).default(""),
  venue: z.string().trim().min(2).max(200),
  venueHidden: z.boolean().default(false),
  venueHint: z.string().trim().max(100).default(""),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  /** A full image URL, or a path to an image uploaded to this API (/uploads/...). */
  coverImageUrl: z
    .url()
    .or(z.string().regex(/^\/uploads\/[\w.-]+$/))
    .or(z.literal(""))
    .default(""),
  status: z.enum(EVENT_STATUSES).default("draft"),
  ticketTypes: z.array(ticketTypeInput).max(20).default([]),
});

async function uniqueSlug(base: string, excludeId?: Types.ObjectId) {
  const root = base || "event";
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    const clash = await Event.exists({ slug, ...(excludeId && { _id: { $ne: excludeId } }) });
    if (!clash) return slug;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/** Ticket sales per event: paid tickets, tickets held by pending orders, revenue, and check-ins. */
async function salesStats(eventIds: Types.ObjectId[]) {
  const match = { event: { $in: eventIds }, status: { $in: ["paid", "pending"] } };
  const [orders, checkins] = await Promise.all([
    Order.aggregate<{ _id: { event: Types.ObjectId; status: string }; revenue: number; tickets: number }>([
      { $match: match },
      {
        $group: {
          _id: { event: "$event", status: "$status" },
          revenue: { $sum: "$total" },
          tickets: { $sum: "$ticketCount" },
        },
      },
    ]),
    Ticket.aggregate<{ _id: Types.ObjectId; checkedIn: number }>([
      { $match: { event: { $in: eventIds }, status: "used" } },
      { $group: { _id: "$event", checkedIn: { $sum: 1 } } },
    ]),
  ]);

  const stats = new Map<string, { paidTickets: number; pendingTickets: number; revenue: number; checkedIn: number }>();
  const get = (id: string) => {
    if (!stats.has(id)) stats.set(id, { paidTickets: 0, pendingTickets: 0, revenue: 0, checkedIn: 0 });
    return stats.get(id)!;
  };
  for (const o of orders) {
    const s = get(String(o._id.event));
    if (o._id.status === "paid") {
      s.paidTickets += o.tickets;
      s.revenue += o.revenue;
    } else {
      s.pendingTickets += o.tickets;
    }
  }
  for (const c of checkins) get(String(c._id)).checkedIn = c.checkedIn;
  return (id: Types.ObjectId) => get(String(id));
}

function adminShape(e: EventDoc, types: TicketTypeDoc[]) {
  return {
    id: String(e._id),
    title: e.title,
    slug: e.slug,
    description: e.description,
    venue: e.venue,
    venueHidden: Boolean(e.venueHidden),
    venueHint: e.venueHint ?? "",
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    coverImageUrl: e.coverImageUrl,
    status: e.status,
    ticketTypes: types
      .filter((t) => t.event.equals(e._id))
      .sort((a, b) => a.position - b.position)
      .map((t) => ({
        id: String(t._id),
        name: t.name,
        description: t.description,
        price: t.price,
        quantity: t.quantity,
        sold: t.sold,
        maxPerOrder: t.maxPerOrder,
      })),
  };
}

// Staff can list events too, so they can pick which one they're scanning for.
adminEventsRouter.get("/", requireAuth("admin", "staff"), async (_req, res) => {
  const events = await Event.find().sort({ startsAt: -1 }).limit(200);
  const ids = events.map((e) => e._id);
  const [types, stats] = await Promise.all([TicketType.find({ event: { $in: ids } }), salesStats(ids)]);
  res.json({ events: events.map((e) => ({ ...adminShape(e, types), stats: stats(e._id) })) });
});

adminEventsRouter.get("/:id", requireAuth("admin"), async (req, res) => {
  const event = await Event.findById(objectId.parse(req.params.id));
  if (!event) throw new HttpError(404, "Event not found");
  const [types, stats] = await Promise.all([TicketType.find({ event: event._id }), salesStats([event._id])]);
  res.json({ event: { ...adminShape(event, types), stats: stats(event._id) } });
});

adminEventsRouter.post("/", requireAuth("admin"), async (req, res) => {
  const { ticketTypes, ...input } = eventInput.parse(req.body);
  const event = await Event.create({
    ...input,
    endsAt: input.endsAt ?? undefined,
    slug: await uniqueSlug(input.slug || slugify(input.title)),
  });
  const types = await TicketType.insertMany(
    ticketTypes.map(({ id: _id, ...t }, position) => ({ ...t, event: event._id, position, sold: 0 })),
  );
  res.status(201).json({ event: adminShape(event, types) });
});

/**
 * Updates an event and its ticket types. `sold` is never written here, since it changes
 * concurrently as people buy; quantity changes and removals are conditional on what's
 * already sold, so an edit can't strand a buyer who is holding tickets.
 */
adminEventsRouter.patch("/:id", requireAuth("admin"), async (req, res) => {
  const id = objectId.parse(req.params.id);
  const { ticketTypes: wanted, ...input } = eventInput.parse(req.body);
  const event = await Event.findById(id);
  if (!event) throw new HttpError(404, "Event not found");
  const current = await TicketType.find({ event: event._id });

  // Check everything up front so a bad edit doesn't half-apply.
  const keep = new Set(wanted.filter((t) => t.id).map((t) => t.id!));
  for (const t of wanted) {
    if (!t.id) continue;
    const existing = current.find((c) => c._id.equals(t.id));
    if (!existing) throw new HttpError(409, "A ticket type no longer exists. Reload and try again.");
    if (t.quantity < existing.sold) {
      throw new HttpError(409, `"${existing.name}" already has ${existing.sold} sold or reserved; quantity can't go below that.`);
    }
  }
  for (const c of current) {
    if (!keep.has(String(c._id)) && c.sold > 0) {
      throw new HttpError(409, `"${c.name}" has tickets sold or reserved, so it can't be removed. Set its quantity to what's sold instead.`);
    }
  }

  const slug = input.slug && input.slug !== event.slug ? await uniqueSlug(input.slug, event._id) : event.slug;
  await Event.updateOne(
    { _id: event._id },
    {
      $set: {
        title: input.title,
        slug,
        description: input.description,
        venue: input.venue,
        venueHidden: input.venueHidden,
        venueHint: input.venueHint,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        coverImageUrl: input.coverImageUrl,
        status: input.status,
      },
    },
  );

  for (const c of current) {
    if (keep.has(String(c._id))) continue;
    const { deletedCount } = await TicketType.deleteOne({ _id: c._id, sold: 0 });
    if (deletedCount !== 1) throw new HttpError(409, `"${c.name}" was just bought, so it can't be removed.`);
  }

  for (const [position, t] of wanted.entries()) {
    const fields = {
      name: t.name,
      description: t.description,
      price: t.price,
      quantity: t.quantity,
      maxPerOrder: t.maxPerOrder,
      position,
    };
    if (!t.id) {
      await TicketType.create({ ...fields, event: event._id, sold: 0 });
      continue;
    }
    const { matchedCount } = await TicketType.updateOne(
      { _id: t.id, event: event._id, sold: { $lte: t.quantity } },
      { $set: fields },
    );
    if (matchedCount !== 1) {
      throw new HttpError(409, `More "${t.name}" tickets were just bought; quantity can't go below what's sold.`);
    }
  }

  const [updated, types] = await Promise.all([
    Event.findById(event._id),
    TicketType.find({ event: event._id }),
  ]);
  res.json({ event: adminShape(updated!, types) });
});
