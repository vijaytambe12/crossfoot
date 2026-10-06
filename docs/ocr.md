# Reading scans with OCR

A scanned PDF is a picture of a page. It has no text layer, so `reader.read(pdf)` throws:

```
The document has no text to read. A scanned PDF needs OCR first: pass its words as geometry
```

crossfoot does not include an OCR engine. It reads the output of any engine that reports words
with their boxes. You convert that output to a `DocumentGeometry` and pass it to `reader.read` in
place of the PDF. Everything after that, the reading spec and the proof, is the same code.

## From OCR words to geometry

`ocrPage` does the conversion for one page. It needs the page's words grouped into lines, each
word with its text and the four corners of its box as fractions of the page (0 to 1), clockwise
from top-left.

```js
import { createReader, ocrPage } from 'crossfoot';

// However your OCR engine reports a page: here, lines of words with pixel boxes.
function toGeometry(ocrPages) {
  const pages = ocrPages.map((page, i) =>
    ocrPage(
      page.lines.map((line) =>
        line.words.map((word) => ({
          text: word.text,
          polygon: [
            { x: word.left / page.widthPx, y: word.top / page.heightPx },
            { x: word.right / page.widthPx, y: word.top / page.heightPx },
            { x: word.right / page.widthPx, y: word.bottom / page.heightPx },
            { x: word.left / page.widthPx, y: word.bottom / page.heightPx },
          ],
        })),
      ),
      // The page's size in points. An A4 page is 595 x 842; US Letter is 612 x 792.
      { pageNumber: i + 1, width: 595, height: 842 },
    ),
  );
  return { pageCount: pages.length, pages };
}

const result = await reader.read(toGeometry(ocrOutput));
```

`ocrPage` does three things an OCR result needs before it reads like a text PDF:

- **Joins words into text runs.** Words closer than half a line height become one fragment
  (`Air Waybill Number`); a wider gap starts a new one. Labels and headings are matched as whole
  fragments, so this matters.
- **Straightens a tilted page.** It finds the tilt, up to 3 degrees either way, and turns the
  words back so that each printed line is one row.
- **Scales heights.** An OCR box hugs the letters and is shorter than the font size, which would
  split lines that are printed close together.

## Things to get right

**Give lines, not loose words.** Each inner list must be the words of one printed line, as your
engine groups them. A line may run across several columns; it is split at the gaps.

**Use one page size per layout.** A reading spec stores positions. Pass the same `width` and
`height` for every document of a layout, in points, and they will line up.

**Scans drift.** A printed position may sit up to 3 points from the spec's. A scan that is
shifted or scaled by more than that against the one the spec was written on will not be read by
the saved spec. Tilt is corrected; shift and scale are not. Crop and scale your scans to the page
before OCR if they vary.

**The proof still runs, and it is your safety net here.** A misread digit almost always breaks a
total. A misread letter in a name does not, and will pass unnoticed.

## Building geometry yourself

If your text comes from somewhere else, build the structure directly. `clusterRows` groups
fragments into rows:

```js
import { clusterRows } from 'crossfoot';

const geometry = {
  pageCount: 1,
  pages: [
    {
      pageNumber: 1,
      width: 595,
      height: 842,
      rows: clusterRows([
        { str: 'Subtotal', x: 420, y: 364, width: 33, height: 9 },
        { str: '4,578.16', x: 525, y: 364, width: 35, height: 9 },
      ]),
    },
  ],
};
```

`x` and `y` are in points from the top-left of the page, and `y` grows downward. `height` is the
text's font size; rows are formed from fragments within half a height of each other.
