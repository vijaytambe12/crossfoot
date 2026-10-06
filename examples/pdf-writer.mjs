// The smallest PDF that can be an example document: pages of Helvetica text at fixed positions.
// No dependency. Numbers can be right-aligned, as invoices print them: in Helvetica every digit is
// the same width.

const PAGE = { width: 595, height: 842 }; // A4, in points
const SIZE = 9;

/** How wide a NUMBER prints, in points: a digit is 0.556 of the font size, a comma or a point half that. */
export const widthOf = (number, size = SIZE) =>
  [...number].reduce((width, char) => width + (/\d/.test(char) ? 0.556 : 0.278), 0) * size;

/** A number whose RIGHT edge is at `x` — how invoices print their amounts. */
export const right = (x, y, text, more = {}) => ({ x: x - widthOf(text, more.size), y, text, ...more });

/** `pages` is a list of pages, each a list of `{ x, y, text, size?, bold? }` with y from the top. */
export function writePdf(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  const escaped = (text) => text.replace(/[\\()]/g, '\\$&');
  pages.forEach((texts, i) => {
    const stream = texts
      .map(
        (t) =>
          `BT /${t.bold ? 'F2' : 'F1'} ${t.size ?? SIZE} Tf ${t.x.toFixed(2)} ${(PAGE.height - t.y).toFixed(2)} Td (${escaped(t.text)}) Tj ET`,
      )
      .join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
