import { Schema } from "effect";

const PositiveBpm = Schema.Finite.check(Schema.isGreaterThan(0));

export const HeartRateZone = Schema.Literals([1, 2, 3, 4, 5]);
export type HeartRateZone = typeof HeartRateZone.Type;

export type ZoneOrBelow = 0 | HeartRateZone;

export const HeartRateSample = Schema.Struct({
  at: Schema.Finite,
  bpm: PositiveBpm,
});
export type HeartRateSample = typeof HeartRateSample.Type;

export const ZoneModel = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("max"), maxBpm: PositiveBpm }),
  Schema.Struct({
    kind: Schema.Literal("reserve"),
    maxBpm: PositiveBpm,
    restingBpm: PositiveBpm,
  }).check(Schema.makeFilter((model) => model.restingBpm < model.maxBpm)),
]);
export type ZoneModel = typeof ZoneModel.Type;

export interface ZoneBounds {
  readonly zone: HeartRateZone;
  readonly minBpm: number;
  readonly maxBpm: number;
}

export type ZoneSeconds = readonly [number, number, number, number, number, number];

export interface GapOptions {
  readonly maxGapSeconds?: number;
}

const zoneNumbers = [1, 2, 3, 4, 5] as const;

const bpmAt = (model: ZoneModel, fraction: number): number =>
  Math.round(
    model.kind === "max"
      ? model.maxBpm * fraction
      : model.restingBpm + (model.maxBpm - model.restingBpm) * fraction,
  );

export const heartRateZones = (model: ZoneModel): ReadonlyArray<ZoneBounds> =>
  zoneNumbers.map((zone) => ({
    zone,
    minBpm: bpmAt(model, (zone + 4) / 10),
    maxBpm: bpmAt(model, (zone + 5) / 10),
  }));

const zoneClassifier = (model: ZoneModel): ((bpm: number) => ZoneOrBelow) => {
  const zones = heartRateZones(model);
  return (bpm) => zones.findLast((zone) => bpm >= zone.minBpm)?.zone ?? 0;
};

export const zoneOf = (bpm: number, model: ZoneModel): ZoneOrBelow => zoneClassifier(model)(bpm);

interface Span {
  readonly bpm: number;
  readonly seconds: number;
}

const spans = (samples: ReadonlyArray<HeartRateSample>, options: GapOptions): Array<Span> => {
  const maxGapSeconds = options.maxGapSeconds ?? 10;
  const sorted = samples.toSorted((a, b) => a.at - b.at);
  return sorted.map((sample, index) => ({
    bpm: sample.bpm,
    seconds: Math.min(((sorted[index + 1]?.at ?? sample.at) - sample.at) / 1000, maxGapSeconds),
  }));
};

export const timeInZones = (
  samples: ReadonlyArray<HeartRateSample>,
  model: ZoneModel,
  options: GapOptions = {},
): ZoneSeconds => {
  const classify = zoneClassifier(model);
  const totals: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  for (const span of spans(samples, options)) totals[classify(span.bpm)] += span.seconds;
  return totals;
};

export const averageBpm = (
  samples: ReadonlyArray<HeartRateSample>,
  options: GapOptions = {},
): number | undefined => {
  const covered = spans(samples, options);
  const seconds = covered.reduce((sum, span) => sum + span.seconds, 0);
  return seconds === 0
    ? undefined
    : covered.reduce((sum, span) => sum + span.bpm * span.seconds, 0) / seconds;
};

export const peakBpm = (samples: ReadonlyArray<HeartRateSample>): number | undefined =>
  samples.length === 0 ? undefined : Math.max(...samples.map((sample) => sample.bpm));

export const estimateMaxBpm = (ageYears: number): number => Math.round(208 - 0.7 * ageYears);
