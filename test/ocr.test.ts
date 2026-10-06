import { describe, expect, it } from 'vitest';
import { OcrWord, ocrPage, skewOf } from '../src/ocr.js';

/**
 * OCR words (text and box corners as page fractions) → the positioned text runs a text PDF gives,
 * so a page with no text is read by the same code as one with it. The words here are made up.
 */
const PAGE = { pageNumber: 1, width: 612, height: 792 };

/** A word whose box, in page points, is x..x+width wide with its top at y, tilted by `degrees`. */
function word(text: string, x: number, y: number, width: number, degrees = 0): OcrWord {
  const angle = (degrees * Math.PI) / 180;
  const [cx, cy] = [PAGE.width / 2, PAGE.height / 2];
  const turn = (px: number, py: number) => ({
    x: (cx + (px - cx) * Math.cos(angle) - (py - cy) * Math.sin(angle)) / PAGE.width,
    y: (cy + (px - cx) * Math.sin(angle) + (py - cy) * Math.cos(angle)) / PAGE.height,
  });
  const height = 8;
  return {
    text,
    polygon: [turn(x, y), turn(x + width, y), turn(x + width, y + height), turn(x, y + height)],
  };
}

const texts = (page: ReturnType<typeof ocrPage>) =>
  page.rows.map((row) => row.fragments.map((f) => `${f.str}@${f.x}`));

describe('OCR words as page text', () => {
  it('joins words a space apart into one text run, splits at a column gap, and places them in page points', () => {
    const page = ocrPage(
      [
        [word('Air', 47, 180, 12), word('Waybill', 61, 180, 28), word('Number', 91, 180, 30)],
        [word('123456789012', 157, 180, 48)],
      ],
      PAGE,
    );

    expect(texts(page)).toEqual([['Air Waybill Number@47', '123456789012@157']]);
    // Height is the font size, as a text PDF gives it: an 8pt box of glyphs is 10pt text.
    expect(page.rows[0].fragments[1]).toMatchObject({ y: 188, height: 10 });
  });

  it('straightens a tilted page, so each printed line is still one row', () => {
    const labels = [
      'Ship Date',
      'Air Waybill Number',
      'Service Type',
      'Pieces',
      'Weight',
      'Bill To',
    ];
    const tilted = labels.flatMap((label, i) => {
      const y = 174 + 8 * i;
      let x = 47;
      const labelWords = label.split(' ').map((text) => {
        const w = word(text, x, y, 5 * text.length, 2);
        x += 5 * text.length + 2;
        return w;
      });
      return [
        labelWords,
        [word(`0${i + 1}/20/2026`, 157, y, 40, 2)],
        [word('JANE', 392, y, 22, 2), word('EXAMPLE', 416, y, 38, 2)],
      ];
    });

    expect((skewOf(tilted, PAGE) * 180) / Math.PI).toBeCloseTo(2, 1);
    expect(texts(ocrPage(tilted, PAGE))).toEqual(
      labels.map((label, i) => [`${label}@47`, `0${i + 1}/20/2026@157`, 'JANE EXAMPLE@392']),
    );
  });
});
