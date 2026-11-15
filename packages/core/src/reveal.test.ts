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

  it("shows the top of a row taller than the band", () => {
    const row = { top: 300, bottom: 800 };
    expect(row.top - revealDistance(row, band)).toBe(band.top + REVEAL_MARGIN);
  });

  it("moves a row up when the band shrinks under it, as when the rest timer appears", () => {
    const row = { top: 250, bottom: 500 };
    expect(revealDistance(row, band)).toBe(0);
    const withRest = { top: 115, bottom: 400 };
    expect(row.bottom - revealDistance(row, withRest)).toBe(withRest.bottom - REVEAL_MARGIN);
  });
});
