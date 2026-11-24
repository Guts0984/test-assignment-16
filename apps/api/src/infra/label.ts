// Shipping label PDF (A6, Code128). Text comes from stored, validated data; the file name is built
// from the order id only, so nothing user-controlled reaches Content-Disposition.
import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';

export type LabelData = {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly shopName: string;
  readonly deliveryMethod: string;
  readonly warehouseCode: string;
  readonly shipDay: string;
  readonly address: Readonly<Record<string, unknown>>;
};

const clean = (v: unknown): string =>
  [...String(v ?? '')]
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)
    .join('')
    .slice(0, 300);

export const labelFileName = (orderId: string): string => `label-${orderId.replace(/[^0-9a-f-]/gi, '')}.pdf`;

export const renderLabel = async (d: LabelData): Promise<Buffer> => {
  const barcode = await bwipjs.toBuffer({
    bcid: 'code128',
    text: clean(d.orderNumber) || 'NONE',
    scale: 2,
    height: 12,
    includetext: true,
    textxalign: 'center',
  });
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A6', margin: 18, info: { Title: `Label ${clean(d.orderNumber)}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(9).text(`${clean(d.shopName)} / ${clean(d.warehouseCode)}`);
    doc.fontSize(16).text(clean(d.deliveryMethod).toUpperCase(), { continued: false });
    doc.moveDown(0.3).fontSize(11).text(clean(d.address.name));
    doc.text(clean(d.address.line1));
    if (d.address.line2 !== undefined) doc.text(clean(d.address.line2));
    doc.text(`${clean(d.address.postalCode)} ${clean(d.address.city)}`);
    doc.text(clean(d.address.country));
    doc
      .moveDown(0.5)
      .fontSize(10)
      .text(`Ship day: ${clean(d.shipDay)}`);
    doc.text(`Order: ${clean(d.orderNumber)}`);
    doc.image(barcode, { fit: [250, 70] });
    doc.end();
  });
};
