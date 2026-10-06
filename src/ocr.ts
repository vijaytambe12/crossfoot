import { PageGeometry, TextFragment, clusterRows } from './geometry.js';

/**
 * OCR words → the positioned text the reader already reads, for a page with no text layer (a
 * scan, a photo, text drawn as outlines by "Print to PDF"). Rows are clustered exactly as a text
 * PDF's are, so everything after — the reading spec, the proof — is the same code path.
 */

/** One OCR word: its text and its box corners as page fractions (0–1), clockwise from top-left. */
export interface OcrWord {
  text: string;
  polygon: { x: number; y: number }[];
}

/**
 * A text PDF's fragment height is its font size; an OCR box hugs the glyphs, about 0.8 of it. Rows
 * are clustered within half a height, so an unscaled box height splits two-line cells whose second
 * line is printed close under the first.
 */
const FONT_PER_BOX = 1.25;
/** A tilt smaller than this is left alone — a text PDF's own rows are no straighter. */
const MIN_SKEW_RADIANS = (0.2 * Math.PI) / 180;

interface Placed {
  text: string;
  left: number;
  right: number;
  bottom: number;
  height: number;
}

/**
 * One page, from its OCR lines (each a list of words in reading order). `width` and `height` are
 * the page's size in the units you want positions in — use points (1/72 inch), and the same size
 * for every document of a layout, because a saved spec holds positions.
 */
export function ocrPage(
  lines: OcrWord[][],
  page: { pageNumber: number; width: number; height: number },
): PageGeometry {
  const angle = skewOf(lines, page);
  const fragments = lines.flatMap((words) =>
    lineFragments(words.map((word) => place(word, page, angle))),
  );
  return { ...page, rows: clusterRows(fragments) };
}

/**
 * The page's tilt: the angle within ±3° at which its words' centres stack into the sharpest rows
 * (a projection profile, 0.1° steps). OCR reports positions on the tilted image, where one printed
 * row drifts across several visual rows. Not from box edges: OCR boxes stay near square, and read
 * a real 1.2° tilt as 0.3–0.6° — enough to split a landscape page's rows.
 */
export function skewOf(lines: OcrWord[][], page: { width: number; height: number }): number {
  const centres = lines
    .flat()
    .filter((w) => w.polygon.length === 4)
    .map((w) => ({
      x: (w.polygon.reduce((sum, p) => sum + p.x, 0) / 4) * page.width,
      y: (w.polygon.reduce((sum, p) => sum + p.y, 0) / 4) * page.height,
    }));
  if (centres.length < 20) return 0;
  let best = { angle: 0, sharpness: -1 };
  for (let tenth = -30; tenth <= 30; tenth++) {
    const angle = (tenth * Math.PI) / 1800;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const rows = new Map<number, number>();
    for (const c of centres) {
      const row = Math.round(c.y * cos - c.x * sin);
      rows.set(row, (rows.get(row) ?? 0) + 1);
    }
    const sharpness = [...rows.values()].reduce((sum, n) => sum + n * n, 0);
    if (sharpness > best.sharpness) best = { angle, sharpness };
  }
  return Math.abs(best.angle) < MIN_SKEW_RADIANS ? 0 : best.angle;
}

/** The word's box in page units, its centre turned back by the page's tilt. */
function place(word: OcrWord, page: { width: number; height: number }, angle: number): Placed {
  const corners = word.polygon.map((p) => ({ x: p.x * page.width, y: p.y * page.height }));
  const width = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const height = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
  const cx = corners.reduce((sum, p) => sum + p.x, 0) / 4 - page.width / 2;
  const cy = corners.reduce((sum, p) => sum + p.y, 0) / 4 - page.height / 2;
  const [cos, sin] = [Math.cos(-angle), Math.sin(-angle)];
  const x = cx * cos - cy * sin + page.width / 2;
  const y = cx * sin + cy * cos + page.height / 2;
  return {
    text: word.text,
    left: x - width / 2,
    right: x + width / 2,
    bottom: y + height / 2,
    height,
  };
}

/**
 * Words closer than half a line height are one text run, as a PDF prints them (`Air Waybill
 * Number`, `(309.61)`); a wider gap is a new column.
 */
function lineFragments(words: Placed[]): TextFragment[] {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.left - b.left);
  const lineHeight = [...sorted.map((w) => w.height)].sort((a, b) => a - b)[
    Math.floor(sorted.length / 2)
  ];
  const runs: Placed[][] = [];
  for (const word of sorted) {
    const run = runs[runs.length - 1];
    if (run && word.left - run[run.length - 1].right <= 0.5 * lineHeight) run.push(word);
    else runs.push([word]);
  }
  return runs.map((run) => ({
    str: run.map((w) => w.text).join(' '),
    x: Math.round(run[0].left),
    y: Math.round(Math.max(...run.map((w) => w.bottom))),
    width: Math.round(run[run.length - 1].right - run[0].left),
    height: Math.max(1, Math.round(FONT_PER_BOX * lineHeight)),
  }));
}
