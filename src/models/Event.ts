import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const EVENT_STATUSES = ["draft", "published", "cancelled"] as const;

const eventSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: "" },
    /** The real address. Never sent to the public site when venueHidden is on. */
    venue: { type: String, required: true, trim: true },
    /** Keep the address secret until purchase; it's revealed only on the emailed/PDF ticket. */
    venueHidden: { type: Boolean, default: false },
    /** Optional public hint shown instead of the address while hidden, e.g. "Lekki, Lagos". */
    venueHint: { type: String, trim: true, default: "" },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date },
    coverImageUrl: { type: String, trim: true, default: "" },
    status: { type: String, enum: EVENT_STATUSES, default: "draft", index: true },
    /** Marked sold out by an admin: the event stays on the site but nobody can order. */
    soldOut: { type: Boolean, default: false },
    /** Show how many tickets are left in each category on the event page. */
    showTicketsLeft: { type: Boolean, default: true },
    /** Listed on the home page. Off hides it there; its own page and link still work. */
    featured: { type: Boolean, default: true },
    /** The one event shown big at the top of the home page. At most one event has this on. */
    isMain: { type: Boolean, default: false },
  },
  { timestamps: true },
);

eventSchema.index({ status: 1, startsAt: 1 });

export type EventDoc = HydratedDocument<InferSchemaType<typeof eventSchema>>;
export const Event = model("Event", eventSchema);
