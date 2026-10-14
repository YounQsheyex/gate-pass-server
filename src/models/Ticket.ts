import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const TICKET_STATUSES = ["valid", "used", "void"] as const;

const ticketSchema = new Schema(
  {
    event: { type: Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    /** Position within the order (0..n-1). Unique per order, which makes issuing idempotent. */
    seq: { type: Number, required: true },
    ticketTypeId: { type: Schema.Types.ObjectId, required: true },
    ticketTypeName: { type: String, required: true },
    holderName: { type: String, required: true },
    status: { type: String, enum: TICKET_STATUSES, default: "valid", index: true },
    checkedInAt: { type: Date },
    checkedInBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

ticketSchema.index({ order: 1, seq: 1 }, { unique: true });

export type TicketDoc = HydratedDocument<InferSchemaType<typeof ticketSchema>>;
export const Ticket = model("Ticket", ticketSchema);
