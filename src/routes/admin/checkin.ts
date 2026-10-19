import { Router } from "express";
import { z } from "zod";
import { Ticket } from "../../models/Ticket.js";
import { requireAuth } from "../../middleware/auth.js";
import { checkinLimiter, manualCheckinLimiter } from "../../middleware/rateLimit.js";
import { objectId } from "../../lib/validate.js";
import { checkIn, checkInManual } from "../../services/tickets.js";

export const checkinRouter = Router();
checkinRouter.use(requireAuth("admin", "staff"));

const body = z.object({
  token: z.string().trim().min(1).max(500),
  /** The event this gate is scanning for; tickets for other events are rejected. */
  eventId: objectId.optional(),
  /** Check validity without admitting. */
  dryRun: z.boolean().optional(),
});

checkinRouter.post("/", checkinLimiter, async (req, res) => {
  const input = body.parse(req.body);
  const result = await checkIn({ ...input, staffId: req.user!.id });
  res.json(result);
});

const manualBody = z.object({
  /** The entry code printed under the QR, e.g. "7KQ2-M9XD". */
  entryCode: z.string().trim().min(1).max(40),
  /** The order reference printed on the ticket, e.g. "TK-YD0W0-MF6ZS". */
  reference: z.string().trim().min(1).max(40),
  eventId: objectId.optional(),
  dryRun: z.boolean().optional(),
});

checkinRouter.post("/manual", checkinLimiter, manualCheckinLimiter, async (req, res) => {
  const input = manualBody.parse(req.body);
  const result = await checkInManual({ ...input, staffId: req.user!.id });
  if (result.result === "invalid") {
    res.locals.manualCheckinFailed = true;
    console.warn(`[checkin] wrong typed-in ticket details from user ${req.user!.id}`);
  }
  res.json(result);
});

checkinRouter.get("/stats/:eventId", async (req, res) => {
  const event = objectId.parse(req.params.eventId);
  const [issued, checkedIn] = await Promise.all([
    Ticket.countDocuments({ event, status: { $in: ["valid", "used"] } }),
    Ticket.countDocuments({ event, status: "used" }),
  ]);
  res.json({ issued, checkedIn });
});
