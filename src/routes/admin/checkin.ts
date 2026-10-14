import { Router } from "express";
import { z } from "zod";
import { Ticket } from "../../models/Ticket.js";
import { requireAuth } from "../../middleware/auth.js";
import { checkinLimiter } from "../../middleware/rateLimit.js";
import { objectId } from "../../lib/validate.js";
import { checkIn } from "../../services/tickets.js";

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

checkinRouter.get("/stats/:eventId", async (req, res) => {
  const event = objectId.parse(req.params.eventId);
  const [issued, checkedIn] = await Promise.all([
    Ticket.countDocuments({ event, status: { $in: ["valid", "used"] } }),
    Ticket.countDocuments({ event, status: "used" }),
  ]);
  res.json({ issued, checkedIn });
});
