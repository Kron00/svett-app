/** One x-axis label as measured on screen: the centre of its point's slot and its text width. */
export type AxisLabel = {
  readonly center: number;
  readonly width: number;
};

/** A label to draw, by its index in the input, with its left edge. */
export type PlacedLabel = {
  readonly index: number;
  readonly left: number;
};

const place = (
  labels: ReadonlyArray<AxisLabel>,
  indices: ReadonlyArray<number>,
  plotWidth: number,
): ReadonlyArray<PlacedLabel> =>
  indices.map((index) => {
    const { center, width } = labels[index] ?? { center: 0, width: 0 };
    return { index, left: Math.min(Math.max(0, center - width / 2), plotWidth - width) };
  });

const fits = (
  labels: ReadonlyArray<AxisLabel>,
  placed: ReadonlyArray<PlacedLabel>,
  minGap: number,
): boolean =>
  placed.every((label, i) => {
    const previous = placed[i - 1];
    if (!previous) return true;
    return label.left - (previous.left + (labels[previous.index]?.width ?? 0)) >= minGap;
  });

/**
 * Centres each label on its slot, moving only a first or last label that
 * would cross the plot's edge. When the labels do not fit with `minGap`
 * between them, it keeps every second label, then every third and so on,
 * always keeping the first and last. Empty labels, with zero width, are never drawn.
 */
export const placeAxisLabels = (
  labels: ReadonlyArray<AxisLabel>,
  plotWidth: number,
  minGap: number,
): ReadonlyArray<PlacedLabel> => {
  const shown = labels.flatMap((label, index) => (label.width > 0 ? [index] : []));
  const last = shown[shown.length - 1];
  if (last === undefined) return [];
  for (let stride = 1; stride < shown.length; stride++) {
    const kept = shown.filter((_, i) => i % stride === 0 && shown.length - 1 - i >= stride);
    const placed = place(labels, [...kept, last], plotWidth);
    if (fits(labels, placed, minGap)) return placed;
  }
  return place(labels, [shown[0] ?? last], plotWidth);
};
