import { Schema } from "effect";

import { HeartRateZone } from "./heart-rate.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const StepKind = Schema.Literals(["warmup", "work", "rest", "cooldown"]);
export type StepKind = typeof StepKind.Type;

export const IntervalStep = Schema.Struct({
  kind: StepKind,
  seconds: PositiveInt,
  label: Schema.optionalKey(Schema.NonEmptyString),
  targetZone: Schema.optionalKey(HeartRateZone),
});
export type IntervalStep = typeof IntervalStep.Type;

export const RepeatBlock = Schema.Struct({
  rounds: PositiveInt,
  steps: Schema.NonEmptyArray(IntervalStep),
});
export type RepeatBlock = typeof RepeatBlock.Type;

export const IntervalProgram = Schema.Struct({
  name: Schema.NonEmptyString,
  segments: Schema.NonEmptyArray(Schema.Union([IntervalStep, RepeatBlock])),
});
export type IntervalProgram = typeof IntervalProgram.Type;

export interface TimelineStep {
  readonly kind: StepKind;
  readonly label: string;
  readonly seconds: number;
  readonly startsAt: number;
  readonly round: number;
  readonly rounds: number;
  readonly targetZone?: HeartRateZone | undefined;
}

export type Timeline = ReadonlyArray<TimelineStep>;

const kindLabels: Record<StepKind, string> = {
  warmup: "Warm-up",
  work: "Work",
  rest: "Rest",
  cooldown: "Cool-down",
};

export const buildTimeline = (program: IntervalProgram): Timeline => {
  const flat = program.segments.flatMap((segment) =>
    "rounds" in segment
      ? Array.from({ length: segment.rounds }, (_, index) =>
          segment.steps.map((step) => ({ step, round: index + 1, rounds: segment.rounds })),
        ).flat()
      : [{ step: segment, round: 1, rounds: 1 }],
  );
  let startsAt = 0;
  return flat.map(({ step, round, rounds }) => {
    const entry: TimelineStep = {
      kind: step.kind,
      label: step.label ?? kindLabels[step.kind],
      seconds: step.seconds,
      startsAt,
      round,
      rounds,
      targetZone: step.targetZone,
    };
    startsAt += step.seconds;
    return entry;
  });
};

export const totalSeconds = (timeline: Timeline): number =>
  timeline.reduce((sum, step) => sum + step.seconds, 0);

export type Position =
  | { readonly finished: false; readonly index: number; readonly remaining: number }
  | { readonly finished: true };

export const positionAt = (timeline: Timeline, elapsedSeconds: number): Position => {
  const elapsed = Math.max(0, elapsedSeconds);
  const index = timeline.findIndex((step) => elapsed < step.startsAt + step.seconds);
  const step = timeline[index];
  return step === undefined
    ? { finished: true }
    : { finished: false, index, remaining: step.startsAt + step.seconds - elapsed };
};

export interface Cue {
  readonly at: number;
  readonly text: string;
}

export interface CueRules {
  readonly halfwayMinSeconds: number;
  readonly nextUpMinSeconds: number;
  readonly nextUpLeadSeconds: number;
  readonly countdownMinSeconds: number;
  readonly countdownFrom: number;
}

export const defaultCueRules: CueRules = {
  halfwayMinSeconds: 60,
  nextUpMinSeconds: 30,
  nextUpLeadSeconds: 10,
  countdownMinSeconds: 10,
  countdownFrom: 3,
};

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? "" : "s"}`;

const spokenDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return plural(rest, "second");
  return rest === 0
    ? plural(minutes, "minute")
    : `${plural(minutes, "minute")} ${plural(rest, "second")}`;
};

const announce = (step: TimelineStep): string => {
  const what = `${step.label}, ${spokenDuration(step.seconds)}`;
  return step.kind === "work" && step.rounds > 1
    ? `Round ${step.round} of ${step.rounds}. ${what}`
    : what;
};

type StepCues = (step: TimelineStep, next: TimelineStep | undefined, rules: CueRules) => Array<Cue>;

const endOf = (step: TimelineStep): number => step.startsAt + step.seconds;

// Ordered by priority: when two cues land on the same second, the earlier rule wins.
const stepCueRules: ReadonlyArray<StepCues> = [
  (step) => [{ at: step.startsAt, text: announce(step) }],
  (step, _next, rules) =>
    step.seconds >= rules.countdownMinSeconds
      ? Array.from({ length: rules.countdownFrom }, (_, index) => ({
          at: endOf(step) - rules.countdownFrom + index,
          text: String(rules.countdownFrom - index),
        }))
      : [],
  (step, next, rules) =>
    next !== undefined && step.seconds >= rules.nextUpMinSeconds
      ? [{ at: endOf(step) - rules.nextUpLeadSeconds, text: `Next up: ${next.label}` }]
      : [],
  (step, _next, rules) =>
    step.seconds >= rules.halfwayMinSeconds
      ? [{ at: step.startsAt + Math.floor(step.seconds / 2), text: "Halfway" }]
      : [],
];

export const buildCues = (timeline: Timeline, rules: CueRules = defaultCueRules): Array<Cue> => {
  const candidates = [
    ...stepCueRules.flatMap((rule) =>
      timeline.flatMap((step, index) => rule(step, timeline[index + 1], rules)),
    ),
    { at: totalSeconds(timeline), text: "Workout complete" },
  ];
  const winners = new Map<number, Cue>();
  for (const cue of candidates) {
    if (!winners.has(cue.at)) winners.set(cue.at, cue);
  }
  return [...winners.values()].toSorted((a, b) => a.at - b.at);
};

export const cuesBetween = (
  cues: ReadonlyArray<Cue>,
  fromExclusive: number,
  toInclusive: number,
): Array<Cue> => cues.filter((cue) => cue.at > fromExclusive && cue.at <= toInclusive);

export const hiit = (options: {
  readonly workSeconds: number;
  readonly restSeconds: number;
  readonly rounds: number;
}): IntervalProgram =>
  IntervalProgram.make({
    name: `HIIT ${options.workSeconds}/${options.restSeconds}`,
    segments: [
      {
        rounds: options.rounds,
        steps: [
          { kind: "work", seconds: options.workSeconds },
          { kind: "rest", seconds: options.restSeconds },
        ],
      },
    ],
  });

export const tabata: IntervalProgram = IntervalProgram.make({
  ...hiit({ workSeconds: 20, restSeconds: 10, rounds: 8 }),
  name: "Tabata",
});

export const norwegian4x4: IntervalProgram = IntervalProgram.make({
  name: "Norwegian 4x4",
  segments: [
    { kind: "warmup", seconds: 600 },
    {
      rounds: 4,
      steps: [
        { kind: "work", seconds: 240, targetZone: 4 },
        { kind: "rest", seconds: 180, targetZone: 2 },
      ],
    },
    { kind: "cooldown", seconds: 300 },
  ],
});
