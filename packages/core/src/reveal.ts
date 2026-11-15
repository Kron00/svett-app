/** A stretch of the screen, by its top and bottom edges in points. */
export interface Span {
  readonly top: number;
  readonly bottom: number;
}

/** The space kept between a revealed row and the edge of what covers the list, when it fits. */
export const REVEAL_MARGIN = 8;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * How far to scroll a list down so the field being typed into shows whole in `band`, the part
 * of the list nothing covers, such as the space between the navigation bar and the keypad.
 * Negative scrolls up. A row that fits the band shows whole, with up to `margin` points kept
 * clear on the side it came from. A row taller than the band shows `field` whole, with as much
 * of the row around it as fits. It is 0 when that already shows.
 */
export const revealDistance = (
  row: Span,
  band: Span,
  field: Span = row,
  margin = REVEAL_MARGIN,
): number => {
  const room = band.bottom - band.top;
  const height = row.bottom - row.top;
  if (height <= room) {
    if (row.top >= band.top && row.bottom <= band.bottom) return 0;
    // A narrow band gives up the margin before any of the row.
    const kept = Math.min(margin, (room - height) / 2);
    return row.top < band.top ? row.top - (band.top + kept) : row.bottom - (band.bottom - kept);
  }
  // Where the band's top can go: inside the row, so no space beside it is shown, and over the
  // field with its margin. The field wins over the row, and the field's top over its bottom.
  const kept = Math.max(0, Math.min(margin, (room - (field.bottom - field.top)) / 2));
  const fieldLow = field.bottom + kept - room;
  const fieldHigh = field.top - kept;
  const low = Math.max(row.top, fieldLow);
  const high = Math.min(row.bottom - room, fieldHigh);
  const top =
    low <= high
      ? clamp(band.top, low, high)
      : fieldLow <= fieldHigh
        ? clamp(band.top, fieldLow, fieldHigh)
        : fieldHigh;
  return top - band.top;
};
