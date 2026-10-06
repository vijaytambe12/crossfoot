import { DocumentGeometry, PageGeometry, TextFragment, clusterRows } from './geometry.js';

/**
 * A PDF's text layer as positioned fragments, page by page. Throws when the bytes are not a PDF.
 * A scanned PDF has no text layer: every page comes back with no rows (see `hasText`).
 */
export async function extractGeometry(pdf: Uint8Array): Promise<DocumentGeometry> {
  // Loaded on first use: reading with your own geometry (OCR) never needs pdf.js.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    // pdf.js takes ownership of the bytes it is given.
    data: new Uint8Array(pdf),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const pages: PageGeometry[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const fragments: TextFragment[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      fragments.push({
        str: item.str,
        x: Math.round(item.transform[4]),
        // pdf.js measures from the bottom of the page.
        y: Math.round(viewport.height - item.transform[5]),
        width: Math.round(item.width),
        height: Math.round(item.height || Math.abs(item.transform[3]) || 8),
      });
    }
    pages.push({
      pageNumber,
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      rows: clusterRows(fragments),
    });
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  return { pageCount, pages };
}

/** Whether the document has any text to read — false for a scan, which needs OCR first. */
export function hasText(geometry: DocumentGeometry): boolean {
  return geometry.pages.some((page) => page.rows.length > 0);
}
