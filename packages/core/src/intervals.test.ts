import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCues,
  buildTimeline,
  cuesBetween,
  defaultCueRules,
  hiit,
  IntervalProgram,
  norwegian4x4,
  positionAt,
  tabata,
  totalSeconds,
} from "./intervals.ts";

const decode = Schema.decodeUnknownSync(IntervalProgram);

const sampler = decode({
  name: "Sampler",
  segments: [
    { kind: "warmup", seconds: 60 },
    {
      rounds: 2,
      steps: [
        { kind: "work", seconds: 30 },
        { kind: "rest", seconds: 10 },
      ],
    },
    { kind: "cooldown", seconds: 5, label: "Easy spin" },
  ],
});

const at = (cues: ReadonlyArray<{ at: number; text: string }>) =>
  cues.map((cue) => [cue.at, cue.text]);

describe("IntervalProgram", () => {
  it.each([
    ["no segments", []],
    ["zero rounds", [{ rounds: 0, steps: [{ kind: "work", seconds: 20 }] }]],
    ["an empty repeat", [{ rounds: 2, steps: [] }]],
    ["a zero-second step", [{ kind: "work", seconds: 0 }]],
    ["a fractional step", [{ kind: "work", seconds: 1.5 }]],
    ["zone 6", [{ kind: "work", seconds: 60, targetZone: 6 }]],
    ["an unknown kind", [{ kind: "sprint", seconds: 60 }]],
  ])("rejects %s", (_, segments) => {
    expect(() => decode({ name: "Bad", segments })).toThrow();
  });
});

describe("buildTimeline", () => {
  it("expands Norwegian 4x4 and keeps the last rest before the cool-down", () => {
    const timeline = buildTimeline(norwegian4x4);
    expect(
      timeline.map((s) => [s.kind, s.startsAt, s.seconds, s.round, s.rounds, s.targetZone]),
    ).toEqual([
      ["warmup", 0, 600, 1, 1, undefined],
      ["work", 600, 240, 1, 4, 4],
      ["rest", 840, 180, 1, 4, 2],
      ["work", 1020, 240, 2, 4, 4],
      ["rest", 1260, 180, 2, 4, 2],
      ["work", 1440, 240, 3, 4, 4],
      ["rest", 1680, 180, 3, 4, 2],
      ["work", 1860, 240, 4, 4, 4],
      ["rest", 2100, 180, 4, 4, 2],
      ["cooldown", 2280, 300, 1, 1, undefined],
    ]);
    expect(totalSeconds(timeline)).toBe(10 * 60 + 4 * (240 + 180) + 5 * 60);
  });

  it.each([
    [tabata, "Tabata", 16, 8 * (20 + 10)],
    [hiit({ workSeconds: 20, restSeconds: 20, rounds: 3 }), "HIIT 20/20", 6, 3 * 40],
  ])("expands %#: %s", (program, name, steps, total) => {
    const timeline = buildTimeline(program);
    expect(program.name).toBe(name);
    expect(timeline).toHaveLength(steps);
    expect(timeline.at(-1)?.kind).toBe("rest");
    expect(totalSeconds(timeline)).toBe(total);
  });

  it("labels steps by kind unless they carry their own label", () => {
    expect(buildTimeline(sampler).map((s) => s.label)).toEqual([
      "Warm-up",
      "Work",
      "Rest",
      "Work",
      "Rest",
      "Easy spin",
    ]);
  });
});

describe("hiit", () => {
  it.each([
    { workSeconds: 20, restSeconds: 20, rounds: 0 },
    { workSeconds: 0, restSeconds: 20, rounds: 4 },
    { workSeconds: 20, restSeconds: 7.5, rounds: 4 },
  ])("rejects %o", (options) => {
    expect(() => hiit(options)).toThrow();
  });
});

describe("positionAt", () => {
  const timeline = buildTimeline(norwegian4x4);

  it.each([
    [-5, { finished: false, index: 0, remaining: 600 }],
    [0, { finished: false, index: 0, remaining: 600 }],
    [599.5, { finished: false, index: 0, remaining: 0.5 }],
    [600, { finished: false, index: 1, remaining: 240 }],
    [1000, { finished: false, index: 2, remaining: 20 }],
    [2579, { finished: false, index: 9, remaining: 1 }],
    [2580, { finished: true }],
    [86_400, { finished: true }],
  ])("at %d s elapsed", (elapsed, expected) => {
    expect(positionAt(timeline, elapsed)).toEqual(expected);
  });
});

describe("buildCues", () => {
  it("announces, counts down, previews, marks halfway and finishes", () => {
    expect(at(buildCues(buildTimeline(sampler)))).toEqual([
      [0, "Warm-up, 1 minute"],
      [30, "Halfway"],
      [50, "Next up: Work"],
      [57, "3"],
      [58, "2"],
      [59, "1"],
      [60, "Round 1 of 2. Work, 30 seconds"],
      [80, "Next up: Rest"],
      [87, "3"],
      [88, "2"],
      [89, "1"],
      [90, "Rest, 10 seconds"],
      [97, "3"],
      [98, "2"],
      [99, "1"],
      [100, "Round 2 of 2. Work, 30 seconds"],
      [120, "Next up: Rest"],
      [127, "3"],
      [128, "2"],
      [129, "1"],
      [130, "Rest, 10 seconds"],
      [137, "3"],
      [138, "2"],
      [139, "1"],
      [140, "Easy spin, 5 seconds"],
      [145, "Workout complete"],
    ]);
  });

  it("speaks Norwegian 4x4 durations in minutes", () => {
    const cues = at(buildCues(buildTimeline(norwegian4x4)));
    expect(cues).toEqual(
      expect.arrayContaining([
        [0, "Warm-up, 10 minutes"],
        [300, "Halfway"],
        [840, "Rest, 3 minutes"],
        [930, "Halfway"],
        [1020, "Round 2 of 4. Work, 4 minutes"],
        [2270, "Next up: Cool-down"],
        [2280, "Cool-down, 5 minutes"],
        [2580, "Workout complete"],
      ]),
    );
    expect(cues.at(-1)).toEqual([2580, "Workout complete"]);
  });

  it("gives Tabata only announcements and countdowns", () => {
    const cues = buildCues(buildTimeline(tabata));
    expect(cues).toHaveLength(16 * 4 + 1);
    expect(at(cues.slice(0, 5))).toEqual([
      [0, "Round 1 of 8. Work, 20 seconds"],
      [17, "3"],
      [18, "2"],
      [19, "1"],
      [20, "Rest, 10 seconds"],
    ]);
  });

  it("keeps the step announcement when it lands on another cue", () => {
    const rules = {
      ...defaultCueRules,
      nextUpMinSeconds: 10,
      countdownMinSeconds: 3,
      halfwayMinSeconds: 6,
    };
    const timeline = buildTimeline(hiit({ workSeconds: 10, restSeconds: 3, rounds: 1 }));
    expect(at(buildCues(timeline, rules))).toEqual([
      [0, "Work, 10 seconds"],
      [5, "Halfway"],
      [7, "3"],
      [8, "2"],
      [9, "1"],
      [10, "Rest, 3 seconds"],
      [11, "2"],
      [12, "1"],
      [13, "Workout complete"],
    ]);
  });

  it("keeps the countdown when the next-up preview lands on it", () => {
    const rules = { ...defaultCueRules, nextUpMinSeconds: 10, nextUpLeadSeconds: 3 };
    const timeline = buildTimeline(hiit({ workSeconds: 10, restSeconds: 10, rounds: 1 }));
    expect(at(buildCues(timeline, rules))).toEqual([
      [0, "Work, 10 seconds"],
      [7, "3"],
      [8, "2"],
      [9, "1"],
      [10, "Rest, 10 seconds"],
      [17, "3"],
      [18, "2"],
      [19, "1"],
      [20, "Workout complete"],
    ]);
  });
});

describe("cuesBetween", () => {
  const cues = buildCues(buildTimeline(sampler));

  it.each([
    [Number.NEGATIVE_INFINITY, 0, [[0, "Warm-up, 1 minute"]]],
    [0, 0, []],
    [
      55,
      61,
      [
        [57, "3"],
        [58, "2"],
        [59, "1"],
        [60, "Round 1 of 2. Work, 30 seconds"],
      ],
    ],
  ])("returns cues after %d s up to %d s", (from, to, expected) => {
    expect(at(cuesBetween(cues, from, to))).toEqual(expected);
  });

  it("fires every cue exactly once across irregular wake-ups", () => {
    const wakes = [Number.NEGATIVE_INFINITY, 0, 0.4, 29.9, 30, 88.5, 144, 999];
    const fired = wakes.slice(1).flatMap((to, index) => cuesBetween(cues, wakes[index] ?? 0, to));
    expect(fired).toEqual(cues);
  });
});
