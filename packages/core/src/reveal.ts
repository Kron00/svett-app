/** A stretch of the screen, by its top and bottom edges in points. */
export interface Span {
  readonly top: number;
  readonly bottom: number;
}

/** The space kept between a revealed row and the edge of what covers the list. */
export const REVEAL_MARGIN = 8;

/**
 * How far to scroll a list down so a row shows whole in `band`, the part of the list nothing
 * covers, such as the space between the navigation bar and the keypad. Negative scrolls up.
 * It is 0 when the row already shows whole. A row taller than the band shows its top.
 */
export const revealDistance = (row: Span, band: Span, margin = REVEAL_MARGIN): number => {
  if (row.top >= band.top && row.bottom <= band.bottom) return 0;
  const fits = row.bottom - row.top <= band.bottom - band.top - 2 * margin;
  if (row.top < band.top || !fits) return row.top - (band.top + margin);
  return row.bottom - (band.bottom - margin);
};
