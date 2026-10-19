import { Router } from "express";
import { z } from "zod";
import { Order, ORDER_STATUSES } from "../../models/Order.js";
import { Ticket } from "../../models/Ticket.js";
import { User } from "../../models/User.js";
import { HttpError } from "../../middleware/error.js";
import { requireAuth } from "../../middleware/auth.js";
import { escapeRegex, normalizePhone } from "../../lib/util.js";
import { objectId, pagination } from "../../lib/validate.js";
import { cancelOrder, confirmOrder, deliverTickets, whatsappLink } from "../../services/orders.js";
import { ticketEntryCode, ticketShortId } from "../../services/tickets.js";
import { renderTicketsPdf } from "../../services/ticketPdf.js";

export const adminOrdersRouter = Router();
adminOrdersRouter.use(requireAuth("admin"));

const listQuery = pagination.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  event: objectId.optional(),
  q: z.string().trim().max(100).optional(),
});

adminOrdersRouter.get("/", async (req, res) => {
  const { page, limit, status, event, q } = listQuery.parse(req.query);
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (event) filter.event = event;
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const or: Record<string, unknown>[] = [{ reference: rx }, { "buyer.email": rx }, { "buyer.name": rx }];
    const phone = normalizePhone(q);
    if (phone) or.push({ "buyer.phone": phone });
    filter.$or = or;
  }

  const [orders, total, pendingCount] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
    Order.countDocuments({ status: "pending" }),
  ]);

  res.json({
    orders: orders.map((o) => ({
      id: String(o._id),
      reference: o.reference,
      status: o.status,
      eventId: String(o.event),
      eventTitle: o.eventTitle,
      buyer: o.buyer,
      items: o.items,
      total: o.total,
      createdAt: o.createdAt,
      expiresAt: o.expiresAt,
      paidAt: o.paidAt ?? null,
      ticketsEmailedAt: o.ticketsEmailedAt ?? null,
      emailError: o.emailError ?? null,
    })),
    page,
    limit,
    total,
    pendingCount,
  });
});

adminOrdersRouter.get("/:id", async (req, res) => {
  const order = await Order.findById(objectId.parse(req.params.id)).lean();
  if (!order) throw new HttpError(404, "Order not found");

  const [tickets, people] = await Promise.all([
    Ticket.find({ order: order._id }).sort({ seq: 1 }).lean(),
    User.find({ _id: { $in: [order.confirmedBy, order.cancelledBy].filter(Boolean) } }).select("name").lean(),
  ]);
  const nameOf = (id: unknown) => people.find((p) => id && p._id.equals(String(id)))?.name ?? null;

  res.json({
    order: {
      ...order,
      id: String(order._id),
      confirmedByName: nameOf(order.confirmedBy),
      cancelledByName: nameOf(order.cancelledBy),
      whatsappChatUrl: `https://wa.me/${order.buyer.phone}`,
      buyerWhatsappMessageUrl: order.status === "pending" ? whatsappLink(Order.hydrate(order)) : null,
      tickets: tickets.map((t) => ({
        id: String(t._id),
        shortId: ticketShortId(t._id),
        entryCode: ticketEntryCode(t),
        ticketTypeName: t.ticketTypeName,
        status: t.status,
        checkedInAt: t.checkedInAt ?? null,
      })),
    },
  });
});

const confirmBody = z.object({ note: z.string().trim().max(300).optional() });

adminOrdersRouter.post("/:id/confirm", async (req, res) => {
  const { note } = confirmBody.parse(req.body ?? {});
  const result = await confirmOrder(objectId.parse(req.params.id), req.user!.id, note);
  res.json({ ok: true, reference: result.order.reference, emailed: result.emailed, emailError: result.emailError ?? null });
});

const cancelBody = z.object({ reason: z.string().trim().max(300).optional() });

adminOrdersRouter.post("/:id/cancel", async (req, res) => {
  const { reason } = cancelBody.parse(req.body ?? {});
  const order = await cancelOrder(objectId.parse(req.params.id), req.user!.id, reason);
  res.json({ ok: true, reference: order.reference });
});

adminOrdersRouter.post("/:id/resend", async (req, res) => {
  const order = await Order.findById(objectId.parse(req.params.id));
  if (!order) throw new HttpError(404, "Order not found");
  if (order.status !== "paid") throw new HttpError(409, "Only paid orders have tickets to send");
  const result = await deliverTickets(order);
  res.json({ ok: true, emailed: result.emailed, emailError: result.emailError ?? null });
});

/**
 * The order's tickets as a PDF, one per page, stamped "checked in" / "void" where relevant.
 * ?download=1 saves it instead of opening it in the browser.
 */
adminOrdersRouter.get("/:id/tickets.pdf", async (req, res) => {
  const order = await Order.findById(objectId.parse(req.params.id));
  if (!order) throw new HttpError(404, "Order not found");
  const tickets = await Ticket.find({ order: order._id }).sort({ seq: 1 });
  if (tickets.length === 0) throw new HttpError(409, "This order has no tickets yet. Confirm the payment first.");

  const pdf = await renderTicketsPdf(order, tickets, { showStatus: true });
  const filename = `tickets-${order.reference}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  // Helmet's default blocks other sites from embedding this response; allow the dashboard to show it inline.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(pdf);
});
