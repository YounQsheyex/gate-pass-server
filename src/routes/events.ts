import { Router } from "express";
import type { Types } from "mongoose";
import { Event } from "../models/Event.js";
import { TicketType, type TicketTypeDoc } from "../models/TicketType.js";
import { HttpError } from "../middleware/error.js";

export const eventsRouter = Router();

type EventLike = {
  _id: Types.ObjectId;
  title: string;
  slug: string;
  venue: string;
  venueHidden?: boolean | null;
  venueHint?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  coverImageUrl?: string | null;
  soldOut?: boolean | null;
  showTicketsLeft?: boolean | null;
  isMain?: boolean | null;
};

/** Tickets a buyer can still get: none if the admin marked the type or the whole event sold out. */
function publicTicketTypes(types: TicketTypeDoc[], eventSoldOut = false) {
  return types.map((t) => ({
    id: String(t._id),
    name: t.name,
    description: t.description,
    price: t.price,
    available: eventSoldOut || t.soldOut ? 0 : Math.max(0, t.quantity - t.sold),
    maxPerOrder: t.maxPerOrder,
  }));
}

/**
 * The venue as the public may see it. For secret-location events the real address is
 * replaced by the optional hint; it's only revealed on the ticket after payment.
 */
export function publicVenue(e: { venue: string; venueHidden?: boolean | null; venueHint?: string | null }) {
  return e.venueHidden
    ? { venue: null, venueHidden: true, venueHint: e.venueHint || null }
    : { venue: e.venue, venueHidden: false, venueHint: null };
}

function publicEvent(e: EventLike, types: TicketTypeDoc[]) {
  const tt = publicTicketTypes(types, Boolean(e.soldOut));
  return {
    id: String(e._id),
    title: e.title,
    slug: e.slug,
    ...publicVenue(e),
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    coverImageUrl: e.coverImageUrl || null,
    minPrice: tt.length ? Math.min(...tt.map((t) => t.price)) : null,
    soldOut: Boolean(e.soldOut) || (tt.length > 0 && tt.every((t) => t.available === 0)),
    showTicketsLeft: e.showTicketsLeft !== false,
    isMain: Boolean(e.isMain),
    /** Totals across ticket types, for "selling fast" badges. */
    ticketsLeft: tt.reduce((n, t) => n + t.available, 0),
    capacity: types.reduce((n, t) => n + t.quantity, 0),
  };
}

/** Upcoming published events shown on the home page, soonest first. Unfeatured ones are left out. */
eventsRouter.get("/", async (_req, res) => {
  const events = await Event.find({ status: "published", featured: { $ne: false }, startsAt: { $gte: new Date() } })
    .sort({ startsAt: 1 })
    .limit(100);
  const types = await TicketType.find({ event: { $in: events.map((e) => e._id) } });
  res.json({
    events: events.map((e) => publicEvent(e, types.filter((t) => t.event.equals(e._id)))),
  });
});

eventsRouter.get("/:slug", async (req, res) => {
  const event = await Event.findOne({ slug: req.params.slug, status: "published" });
  if (!event) throw new HttpError(404, "Event not found");
  const types = await TicketType.find({ event: event._id }).sort({ position: 1 });
  res.json({
    event: {
      ...publicEvent(event, types),
      description: event.description,
      onSale: event.startsAt.getTime() > Date.now(),
      ticketTypes: publicTicketTypes(types, Boolean(event.soldOut)),
    },
  });
});
