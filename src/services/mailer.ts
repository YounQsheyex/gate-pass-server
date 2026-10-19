import QRCode from "qrcode";
import { env } from "../config/env.js";
import { Event } from "../models/Event.js";
import type { OrderDoc } from "../models/Order.js";
import type { TicketDoc } from "../models/Ticket.js";
import { formatNaira } from "../lib/util.js";
import { ticketShortId, ticketToken } from "./tickets.js";
import { renderTicketsPdf } from "./ticketPdf.js";
import { sendMail } from "./mailTransport.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function formatDate(d: Date) {
  return d.toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function sendTicketsEmail(order: OrderDoc, tickets: TicketDoc[]) {
  const event = await Event.findById(order.event).lean();
  if (!event) throw new Error("Event not found");

  const qrs = await Promise.all(
    tickets.map(async (t) => ({
      ticket: t,
      png: await QRCode.toBuffer(ticketToken(t), { errorCorrectionLevel: "M", margin: 2, width: 360 }),
    })),
  );

  const ticketBlocks = (src: (i: number) => string) =>
    qrs
      .map(
        ({ ticket }, i) => `
      <tr><td style="padding:16px 0;border-top:1px solid #e5e5e5;text-align:center">
        <div style="font-size:13px;color:#737373">Ticket ${i + 1} of ${qrs.length}</div>
        <div style="font-size:18px;font-weight:600;margin:4px 0">${esc(ticket.ticketTypeName)}</div>
        <img src="${src(i)}" width="240" height="240" alt="Ticket QR code" style="display:block;margin:8px auto" />
        <div style="font-family:monospace;font-size:13px;color:#525252">#${ticketShortId(ticket._id)}</div>
      </td></tr>`,
      )
      .join("");

  const html = (src: (i: number) => string) => `<!doctype html>
<html><body style="margin:0;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#171717">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" style="max-width:480px;background:#fff;border-radius:12px;padding:24px" cellpadding="0" cellspacing="0">
      <tr><td>
        <div style="font-size:13px;color:#737373">${esc(env.BRAND_NAME)} · Your tickets</div>
        <h1 style="font-size:22px;margin:4px 0 12px">${esc(event.title)}</h1>
        <div style="font-size:14px;line-height:1.6">
          ${esc(formatDate(event.startsAt))}<br/>${esc(event.venue)}
        </div>
        ${
          event.venueHidden
            ? `<div style="font-size:13px;line-height:1.5;margin-top:10px;padding:10px 12px;background:#fff7d6;border-radius:8px;color:#5c4a00">
                 This location is only for ticket holders. Please don't share it.
               </div>`
            : ""
        }
        <div style="font-size:14px;line-height:1.6;margin-top:12px;color:#525252">
          Order <b>${esc(order.reference)}</b> · ${esc(formatNaira(order.total))} paid<br/>
          Name: ${esc(order.buyer.name)}
        </div>
      </td></tr>
      ${ticketBlocks(src)}
      <tr><td style="padding-top:16px;border-top:1px solid #e5e5e5;font-size:13px;line-height:1.6;color:#525252">
        Your tickets are also attached as a PDF you can print or save.
        Show each QR code at the entrance. Every code admits one person, once, so don't
        share or post it. Screenshots work, but the first scan is the one that counts.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const pdf = await renderTicketsPdf(order, tickets);
  const pdfName = `tickets-${order.reference}.pdf`;

  const subject = `Your tickets for ${event.title} (${order.reference})`;
  const text = [
    `Your tickets for ${event.title}`,
    formatDate(event.startsAt),
    event.venueHidden ? `${event.venue} (for ticket holders only, please don't share)` : event.venue,
    "",
    `Order ${order.reference}, ${tickets.length} ticket(s).`,
    `Your tickets are attached as a PDF (${pdfName}). Each QR code admits one person, once.`,
  ].join("\n");

  const dataUri = (i: number) => `data:image/png;base64,${qrs[i]!.png.toString("base64")}`;
  await sendMail({
    to: { name: order.buyer.name, email: order.buyer.email },
    subject,
    text,
    html: html((i) => `cid:ticket-${i}`),
    previewHtml: html(dataUri),
    tag: order.reference,
    attachments: [
      { filename: pdfName, content: pdf, contentType: "application/pdf" },
      // Inline QR images for the email body.
      ...qrs.map(({ ticket, png }, i) => ({
        filename: `ticket-${i + 1}-${ticketShortId(ticket._id)}.png`,
        content: png,
        contentType: "image/png",
        cid: `ticket-${i}`,
      })),
    ],
  });
}
