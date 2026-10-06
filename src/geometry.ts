/**
 * Positioned text: the only thing the reader needs from a document. Coordinates are in points with
 * a top-left origin (y grows downward). `extractGeometry` builds this from a PDF's text layer; an
 * OCR engine that reports words with boxes can build it too (`clusterRows`).
 */

/** One run of printed text and where it is printed. */
export interface TextFragment {
  str: string;
  /** Left edge. */
  x: number;
  /** Distance from the top of the page. */
  y: number;
  width: number;
  height: number;
}

/** Fragments printed on one visual line, left to right. */
export interface Row {
  y: number;
  fragments: TextFragment[];
}

export interface PageGeometry {
  pageNumber: number;
  width: number;
  height: number;
  rows: Row[];
}

export interface DocumentGeometry {
  pageCount: number;
  pages: PageGeometry[];
}

/**
 * Fragments grouped into rows by y (within half a text height), each row sorted left to right.
 * Recovers reading order when a PDF emits its text out of visual order.
 */
export function clusterRows(fragments: TextFragment[]): Row[] {
  const sorted = [...fragments].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Row[] = [];
  for (const fragment of sorted) {
    const tolerance = Math.max(2, Math.round(fragment.height / 2));
    const row = rows.find((r) => Math.abs(r.y - fragment.y) <= tolerance);
    if (row) row.fragments.push(fragment);
    else rows.push({ y: fragment.y, fragments: [fragment] });
  }
  for (const row of rows) {
    row.fragments.sort((a, b) => a.x - b.x);
    row.y = Math.min(...row.fragments.map((f) => f.y));
  }
  return rows.sort((a, b) => a.y - b.y);
}
