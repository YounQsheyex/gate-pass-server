import type { Types } from "mongoose";
import { TicketType } from "../models/TicketType.js";

type Line = { ticketTypeId: Types.ObjectId; quantity: number };

/**
 * Atomically holds tickets for an order. Each ticket type is incremented with a
 * conditional update ("only if enough are left"), so two buyers racing for the last
 * ticket can't both get it. If any line fails, earlier lines are rolled back.
 *
 * `capacity` is the quantity we read; matching on it too means an admin changing the
 * quantity at the same moment makes the reservation fail safely instead of overselling.
 *
 * Returns the name of the first ticket type that ran out, or null on success.
 */
export async function reserve(
  lines: (Line & { name: string; capacity: number })[],
): Promise<string | null> {
  const done: Line[] = [];
  for (const line of lines) {
    const res = await TicketType.updateOne(
      { _id: line.ticketTypeId, quantity: line.capacity, sold: { $lte: line.capacity - line.quantity } },
      { $inc: { sold: line.quantity } },
    );
    if (res.modifiedCount !== 1) {
      await release(done);
      return line.name;
    }
    done.push(line);
  }
  return null;
}

export async function release(lines: Line[]) {
  for (const line of lines) {
    await TicketType.updateOne({ _id: line.ticketTypeId }, { $inc: { sold: -line.quantity } });
  }
}
