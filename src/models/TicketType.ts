import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

/**
 * A ticket tier for an event (Regular, VIP, ...). Kept in its own collection so
 * stock can be reserved with a single conditional update on this document.
 */
const ticketTypeSchema = new Schema(
  {
    event: { type: Schema.Types.ObjectId, ref: "Event", required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    /** Price in kobo (₦1 = 100). Integers only, never floats. */
    price: { type: Number, required: true, min: 0 },
    /** Total tickets available for this type. */
    quantity: { type: Number, required: true, min: 0 },
    /** Tickets held by pending orders plus tickets paid for. */
    sold: { type: Number, default: 0, min: 0 },
    maxPerOrder: { type: Number, default: 10, min: 1 },
    /** Marked sold out by an admin, whatever is left. */
    soldOut: { type: Boolean, default: false },
    /** Display order on the event page. */
    position: { type: Number, default: 0 },
  },
  { timestamps: true },
);

ticketTypeSchema.index({ event: 1, position: 1 });

export type TicketTypeDoc = HydratedDocument<InferSchemaType<typeof ticketTypeSchema>>;
export const TicketType = model("TicketType", ticketTypeSchema);
