/**
 * Renders an order's tickets as a PDF: one ticket per page, each with its signed QR code.
 * Used for the "View tickets" button in the admin dashboard and attached to the ticket email.
 */
import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { env } from "../config/env.js";
import { Event } from "../models/Event.js";
import type { OrderDoc } from "../models/Order.js";
import type { TicketDoc } from "../models/Ticket.js";
import { ticketShortId, ticketToken } from "./tickets.js";

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string) => require.resolve(`@fontsource/${pkg}/files/${file}`);

const FONTS = {
  display: font("bricolage-grotesque", "bricolage-grotesque-latin-800-normal.woff"),
  body: font("instrument-sans", "instrument-sans-latin-400-normal.woff"),
  bold: font("instrument-sans", "instrument-sans-latin-600-normal.woff"),
  // Prices use Bricolage: Instrument Sans has no ₦ glyph, and in Bricolage it lives in the latin-ext subset.
  price: font("bricolage-grotesque", "bricolage-grotesque-latin-700-normal.woff"),
  priceExt: font("bricolage-grotesque", "bricolage-grotesque-latin-ext-700-normal.woff"),
};

const C = {
  ink: "#1c1745",
  soft: "#4a4672",
  muted: "#77749a",
  lilac: "#eeebfa",
  line: "#dcd8ef",
  stub: "#ffd54a",
  ok: "#138a4b",
  bad: "#c2261d",
};

// Ticket-shaped page (about 14 × 22.6 cm); prints fine on A4 with "fit to page".
const W = 400;
const H = 640;
const M = 28;

const TZ = "Africa/Lagos";
const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-NG", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtTime = (d: Date) => d.toLocaleTimeString("en-NG", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const fmtShort = (d: Date) =>
  d.toLocaleString("en-NG", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const amount = (kobo: number) =>
  (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: kobo % 100 ? 2 : 0, maximumFractionDigits: 2 });

export async function renderTicketsPdf(
  order: OrderDoc,
  tickets: TicketDoc[],
  opts: { showStatus?: boolean } = {},
): Promise<Buffer> {
  const event = await Event.findById(order.event).lean();
  const title = event?.title ?? order.eventTitle;

  const qrs = await Promise.all(
    tickets.map((t) =>
      QRCode.toBuffer(ticketToken(t), {
        errorCorrectionLevel: "M",
        margin: 0,
        width: 720,
        color: { dark: C.ink, light: "#ffffff" },
      }),
    ),
  );

  const doc = new PDFDocument({
    size: [W, H],
    margin: 0,
    autoFirstPage: false,
    info: { Title: `Tickets ${order.reference} – ${title}`, Author: env.BRAND_NAME, Subject: title },
  });
  doc.registerFont("display", FONTS.display);
  doc.registerFont("body", FONTS.body);
  doc.registerFont("bold", FONTS.bold);
  doc.registerFont("price", FONTS.price);
  doc.registerFont("priceExt", FONTS.priceExt);

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  tickets.forEach((ticket, i) => {
    doc.addPage();
    const inner = W - M * 2;

    // --- Header: brand + event
    doc.rect(0, 0, W, H).fill("#ffffff");
    doc.font("bold").fontSize(11).fillColor(C.soft).text(env.BRAND_NAME, M, M, { width: inner / 2 });
    doc
      .font("bold")
      .fontSize(11)
      .fillColor(C.soft)
      .text(`Ticket ${i + 1} of ${tickets.length}`, M + inner / 2, M, { width: inner / 2, align: "right" });

    doc.font("display").fontSize(30).fillColor(C.ink).text(title, M, M + 26, { width: inner, lineGap: -4 });
    let y = doc.y + 8;
    if (event) {
      doc.font("body").fontSize(12).fillColor(C.ink);
      doc.text(`${fmtDate(event.startsAt)}, ${fmtTime(event.startsAt)}`, M, y, { width: inner });
      doc.fillColor(C.soft).text(event.venue, M, doc.y + 2, { width: inner });
      if (event.venueHidden) {
        doc.font("bold").fontSize(9.5).fillColor(C.muted).text("Secret location: for ticket holders only", M, doc.y + 2, { width: inner });
      }
      y = doc.y;
    }

    // --- Ticket type band (the stub)
    const bandY = y + 16;
    doc.roundedRect(M, bandY, inner, 40, 10).fill(C.stub);
    doc.font("bold").fontSize(15).fillColor(C.ink).text(ticket.ticketTypeName, M + 14, bandY + 12, { width: inner - 140 });
    const item = order.items.find((it) => it.ticketTypeId.equals(ticket.ticketTypeId));
    if (item) {
      const price = amount(item.unitPrice);
      doc.font("price").fontSize(16);
      const priceW = doc.widthOfString(price);
      doc.font("priceExt");
      const nairaW = doc.widthOfString("₦");
      const px = M + inner - 14 - priceW - nairaW;
      doc.text("₦", px, bandY + 11, { lineBreak: false });
      doc.font("price").text(price, px + nairaW, bandY + 11, { lineBreak: false });
    }

    // --- Perforation: dashed tear line with half-circle notches at the edges
    const perfY = bandY + 62;
    doc.save().moveTo(18, perfY).lineTo(W - 18, perfY).dash(5, { space: 5 }).lineWidth(1.5).stroke(C.line).undash().restore();
    doc.circle(0, perfY, 11).fill(C.lilac);
    doc.circle(W, perfY, 11).fill(C.lilac);

    // --- QR
    // Shrink the QR a little when a long title or extra venue line pushes the header down,
    // so the name/order row never collides with the footer.
    const footerTop = H - M - 30;
    const belowQr = 22 + 52 + 32; // short id + gap + name/order row
    const qrSize = Math.max(170, Math.min(236, footerTop - (perfY + 22) - belowQr));
    const qrX = (W - qrSize) / 2;
    const qrY = perfY + 22;
    doc.roundedRect(qrX - 12, qrY - 12, qrSize + 24, qrSize + 24, 14).fill(C.lilac);
    doc.rect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12).fill("#ffffff");
    doc.image(qrs[i]!, qrX, qrY, { width: qrSize, height: qrSize });
    doc
      .font("bold")
      .fontSize(13)
      .fillColor(C.ink)
      .text(`#${ticketShortId(ticket._id)}`, M, qrY + qrSize + 22, { width: inner, align: "center", characterSpacing: 1 });

    // --- Holder + order
    const infoY = qrY + qrSize + 52;
    const col = inner / 2;
    doc.font("body").fontSize(10).fillColor(C.muted).text("Name", M, infoY, { width: col });
    doc.font("bold").fontSize(13).fillColor(C.ink).text(ticket.holderName, M, infoY + 13, { width: col - 8 });
    doc.font("body").fontSize(10).fillColor(C.muted).text("Order", M + col, infoY, { width: col, align: "right" });
    doc.font("bold").fontSize(13).fillColor(C.ink).text(order.reference, M + col, infoY + 13, { width: col, align: "right" });

    // --- Footer
    doc
      .font("body")
      .fontSize(9.5)
      .fillColor(C.soft)
      .text(
        "This QR code admits one person, once. Don't share or post it: whoever scans first gets in.",
        M,
        H - M - 26,
        { width: inner, align: "center" },
      );

    // --- Status stamp (dashboard copy only)
    if (opts.showStatus && ticket.status !== "valid") {
      const used = ticket.status === "used";
      const label = used ? "CHECKED IN" : "VOID";
      const sub = used && ticket.checkedInAt ? fmtShort(ticket.checkedInAt) : used ? "" : "Not valid for entry";
      const color = used ? C.ink : C.bad;
      doc.save();
      doc.rotate(-18, { origin: [W / 2, qrY + qrSize / 2] });
      doc.fillOpacity(0.92).roundedRect(W / 2 - 130, qrY + qrSize / 2 - 38, 260, 76, 10).fill("#ffffff");
      doc.fillOpacity(1).lineWidth(4).roundedRect(W / 2 - 130, qrY + qrSize / 2 - 38, 260, 76, 10).stroke(color);
      doc.font("display").fontSize(30).fillColor(color).text(label, W / 2 - 130, qrY + qrSize / 2 - 30, { width: 260, align: "center" });
      if (sub) doc.font("bold").fontSize(12).text(sub, W / 2 - 130, qrY + qrSize / 2 + 10, { width: 260, align: "center" });
      doc.restore();
    }
  });

  doc.end();
  return done;
}
