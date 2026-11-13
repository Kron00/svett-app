/** Evenly spaced round values for a chart axis. The first and last bracket the data. */
export type Ticks = {
  readonly min: number;
  readonly max: number;
  readonly values: ReadonlyArray<number>;
};

const niceStep = (rough: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / magnitude;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
};

/**
 * Round tick values covering every value, with about `count` ticks. A flat
 * series is widened so its line sits inside the axis, and an empty or all-zero
 * one gets 0 to 1.
 */
export const niceTicks = (
  values: ReadonlyArray<number>,
  count: number,
  options: { readonly includeZero?: boolean } = {},
): Ticks => {
  const bounds = options.includeZero ? [0, ...values] : values;
  const low = bounds.length > 0 ? Math.min(...bounds) : 0;
  const high = bounds.length > 0 ? Math.max(...bounds) : 0;
  const pad = Math.abs(low) * 0.1;
  const [from, to] = low !== high ? [low, high] : low === 0 ? [0, 1] : [low - pad, high + pad];
  const step = niceStep((to - from) / Math.max(1, count - 1));
  const first = Math.floor(from / step);
  const last = Math.ceil(to / step);
  const ticks = Array.from(
    { length: last - first + 1 },
    // Rounding to the step's precision keeps 0.30000000000000004 out of axis labels.
    (_, index) => Number(((first + index) * step).toPrecision(12)),
  );
  return { min: ticks[0] ?? from, max: ticks[ticks.length - 1] ?? to, values: ticks };
};

/** Maps a value in the domain to a position in the range, like d3's scaleLinear. */
export const scaleLinear =
  (domain: readonly [number, number], range: readonly [number, number]) =>
  (value: number): number =>
    domain[1] === domain[0]
      ? range[0]
      : range[0] + ((value - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);
