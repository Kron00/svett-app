import { describe, expect, it } from "vite-plus/test";

import { REVEAL_MARGIN, revealDistance } from "./reveal.ts";

// The space a 956 point screen leaves between the navigation bar and the keypad.
const band = { top: 115, bottom: 512 };

describe("revealDistance", () => {
  it("leaves a row that already shows whole where it is", () => {
    expect(revealDistance({ top: 200, bottom: 450 }, band)).toBe(0);
    expect(revealDistance({ top: 115, bottom: 512 }, band)).toBe(0);
  });

  it("scrolls a row under the keypad up until it sits just above it", () => {
    const row = { top: 400, bottom: 650 };
    const by = revealDistance(row, band);
    expect(by).toBe(650 - 512 + REVEAL_MARGIN);
    expect(row.bottom - by).toBe(band.bottom - REVEAL_MARGIN);
  });

  it("scrolls a row under the navigation bar down until it sits just below it", () => {
    const row = { top: 20, bottom: 270 };
    const by = revealDistance(row, band);
    expect(by).toBe(20 - 115 - REVEAL_MARGIN);
    expect(row.top - by).toBe(band.top + REVEAL_MARGIN);
  });

  it("brings a row that went below the screen back", () => {
    expect(revealDistance({ top: 1200, bottom: 1450 }, band)).toBe(1450 - 512 + REVEAL_MARGIN);
  });

  it("keeps a row that just fits whole in a narrow band, giving up the margin", () => {
    // At the largest text size the rest timer leaves 257 points above the keypad.
    const narrow = { top: 115, bottom: 372 };
    for (const row of [
      { top: 300, bottom: 556 },
      { top: 0, bottom: 256 },
    ]) {
      const by = revealDistance(row, narrow);
      expect(row.top - by).toBeGreaterThanOrEqual(narrow.top);
      expect(row.bottom - by).toBeLessThanOrEqual(narrow.bottom);
    }
    const exact = { top: 400, bottom: 657 };
    const by = revealDistance(exact, narrow);
    expect([exact.top - by, exact.bottom - by]).toEqual([narrow.top, narrow.bottom]);
  });

  describe("a row taller than the band", () => {
    const narrow = { top: 115, bottom: 372 };
    // A set at the largest text size: its badge, then its weight, then its reps and done box.
    const row = { top: 400, bottom: 760 };
    const weight = { top: 470, bottom: 550 };
    const reps = { top: 600, bottom: 680 };
    const shown = (by: number) => ({ top: narrow.top + by, bottom: narrow.bottom + by });

    it("shows its top when the field being typed into is near it", () => {
      const by = revealDistance(row, narrow, weight);
      expect(shown(by).top).toBe(row.top);
      expect(weight.bottom - by).toBeLessThanOrEqual(narrow.bottom - REVEAL_MARGIN);
    });

    it("shows a field low in the row whole, and fills the rest of the band with the row", () => {
      const by = revealDistance(row, narrow, reps);
      expect(reps.top - by).toBeGreaterThanOrEqual(narrow.top + REVEAL_MARGIN);
      expect(reps.bottom - by).toBeLessThanOrEqual(narrow.bottom - REVEAL_MARGIN);
      // The band shows only the row, no space beside it.
      expect(shown(by).top).toBeGreaterThanOrEqual(row.top);
      expect(shown(by).bottom).toBeLessThanOrEqual(row.bottom);
    });

    it("moves from one field to the next of the same row, as Next does", () => {
      const first = revealDistance(row, narrow, weight);
      const moved = (span: typeof row) => ({ top: span.top - first, bottom: span.bottom - first });
      const next = revealDistance(moved(row), narrow, moved(reps));
      expect(reps.bottom - first - next).toBeLessThanOrEqual(narrow.bottom - REVEAL_MARGIN);
      expect(reps.top - first - next).toBeGreaterThanOrEqual(narrow.top);
    });

    it("leaves it where it is when the field already shows", () => {
      const by = revealDistance(row, narrow, weight);
      const moved = (span: typeof row) => ({ top: span.top - by, bottom: span.bottom - by });
      expect(revealDistance(moved(row), narrow, moved(weight))).toBe(0);
    });

    it("shows the top of a field taller than the band", () => {
      const tall = { top: 450, bottom: 750 };
      expect(tall.top - revealDistance(row, narrow, tall)).toBe(narrow.top);
    });
  });

  it("moves a row up when the band shrinks under it, as when the rest timer appears", () => {
    const row = { top: 250, bottom: 500 };
    expect(revealDistance(row, band)).toBe(0);
    const withRest = { top: 115, bottom: 400 };
    expect(row.bottom - revealDistance(row, withRest)).toBe(withRest.bottom - REVEAL_MARGIN);
  });
});
