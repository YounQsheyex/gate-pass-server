import { Schema, model, Types, type InferSchemaType, type HydratedDocument } from "mongoose";

export const ORDER_STATUSES = ["pending", "paid", "cancelled", "expired"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const orderItemSchema = new Schema(
  {
    ticketTypeId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    /** Snapshot of the price at the time of ordering, in kobo. */
    unitPrice: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const buyerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    /** International digits, e.g. 2348012345678. */
    phone: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    event: { type: Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    eventTitle: { type: String, required: true },
    buyer: { type: buyerSchema, required: true },
    items: { type: [orderItemSchema], required: true },
    /** Total in kobo. */
    total: { type: Number, required: true },
    /** Number of tickets (sum of item quantities). */
    ticketCount: { type: Number, required: true },
    currency: { type: String, default: "NGN" },
    status: { type: String, enum: ORDER_STATUSES, default: "pending", index: true },
    expiresAt: { type: Date, required: true },

    paidAt: { type: Date },
    confirmedBy: { type: Schema.Types.ObjectId, ref: "User" },
    /** Admin's note on the payment, e.g. the bank transfer reference or sender name. */
    paymentNote: { type: String, trim: true },

    cancelledAt: { type: Date },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancelReason: { type: String, trim: true },

    ticketsEmailedAt: { type: Date },
    emailError: { type: String },
  },
  { timestamps: true },
);

orderSchema.index({ status: 1, expiresAt: 1 });
orderSchema.index({ "buyer.email": 1 });
orderSchema.index({ createdAt: -1 });

export type OrderDoc = HydratedDocument<InferSchemaType<typeof orderSchema>>;
export type OrderItem = { ticketTypeId: Types.ObjectId; name: string; unitPrice: number; quantity: number };
export const Order = model("Order", orderSchema);
