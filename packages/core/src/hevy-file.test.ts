import { readFileSync } from "node:fs";

import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decodeHevyFile, hevyFileLabel, parseCsv, readTime, wallTimeAsUtc } from "./hevy-file.ts";

const sample = (name: string) =>
  readFileSync(new URL(`../test-data/${name}`, import.meta.url), "utf8");

const HEADER =
  '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"';

const row = (exercise: string, index: number) =>
  `"Arms","1 Feb 2025, 10:00","1 Feb 2025, 11:00","","${exercise}",,"",${index},"normal",20,10,,,`;

/** A file whose third row is a Legs set with these fields after the exercise title. */
const legsWith = (fields: string) =>
  `${HEADER}\n${row("Squat (Barbell)", 0)}\n"Legs","1 Feb 2025, 10:00","1 Feb 2025, 11:00","","Squat (Barbell)",${fields}`;

const decode = (text: string) => decodeHevyFile(text, wallTimeAsUtc);

const failureOf = (text: string) => {
  const result = decode(text);
  return Result.isFailure(result) ? result.failure : undefined;
};

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, commas and line breaks in fields, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","said ""hi""\nthen left"\r\n\r\n1,\n')).toEqual([
      ["a", "b"],
      ["x, y", 'said "hi"\nthen left'],
      ["1", ""],
    ]);
  });

  it("gives nothing for text that ends inside a quote", () => {
    expect(parseCsv('a,"b')).toBeUndefined();
  });
});

describe("readTime", () => {
  it("reads Hevy's clock time, with no zone, in the zone it is given", () => {
    const inStockholmWinter = readTime(
      "15 Jan 2024, 18:30",
      (time) => wallTimeAsUtc(time) - 3_600_000,
    );
    expect(inStockholmWinter).toEqual({
      text: "2024-01-15T18:30:00",
      instant: Date.UTC(2024, 0, 15, 17, 30),
      wall: Date.UTC(2024, 0, 15, 18, 30),
      zoned: false,
    });
  });

  it("reads ISO times, and keeps a zone the file gives", () => {
    expect(readTime("2024-01-15 18:30:05", wallTimeAsUtc)?.text).toBe("2024-01-15T18:30:05");
    expect(readTime("2024-01-15T18:30:00+01:00", wallTimeAsUtc)).toMatchObject({
      text: "2024-01-15T18:30:00+01:00",
      instant: Date.UTC(2024, 0, 15, 17, 30),
      zoned: true,
    });
    expect(readTime("2024-01-15T18:30:00Z", wallTimeAsUtc)?.text).toBe("2024-01-15T18:30:00+00:00");
  });

  it("refuses what is not a time", () => {
    expect(readTime("", wallTimeAsUtc)).toBeUndefined();
    expect(readTime("15 Foo 2024, 18:30", wallTimeAsUtc)).toBeUndefined();
    expect(readTime("31 Feb 2024, 18:30", wallTimeAsUtc)).toBeUndefined();
    expect(readTime("15 Jan 2024, 24:00", wallTimeAsUtc)).toBeUndefined();
  });
});

describe("decodeHevyFile", () => {
  it("reads the sample as three workouts with their exercises and sets", () => {
    const file = Result.getOrThrow(decode(sample("hevy-sample.csv")));
    expect(file.sets).toBe(25);
    expect(file.emptySets).toBe(0);
    expect(file.localTimes).toBe(true);
    expect(
      file.workouts.map((workout) => ({
        start: workout.start,
        title: workout.title,
        durationS: workout.durationS,
        exercises: workout.exercises.map((exercise) => `${exercise.name} x${exercise.sets.length}`),
      })),
    ).toEqual([
      {
        start: "2026-11-03T18:30:00",
        title: "Push Day",
        durationS: 3_900,
        exercises: ["Bench Press (Barbell) x3", "Triceps Rope Pushdown x3", "Landmine Press x2"],
      },
      {
        start: "2026-11-05T07:15:00",
        title: "Pull Day",
        durationS: 3_900,
        exercises: [
          "Deadlift (Barbell) x2",
          "Lat Pulldown (Cable) x3",
          "Chest Supported Machine Row x3",
        ],
      },
      {
        start: "2026-11-07T17:00:00",
        title: "Legs",
        durationS: 4_200,
        exercises: ["Squat (Barbell) x5", "Seated Leg Curl (Machine) x3", "Treadmill x1"],
      },
    ]);
    const [push, pull, legs] = file.workouts;
    expect(push?.description).toBe("Felt strong");
    expect(legs?.description).toBe('Knee felt fine, "finally"');
    expect(push?.exercises[0]?.notes).toBe("Pause each rep");
    expect(push?.exercises[0]?.sets).toEqual([
      { setType: "warm_up", weightKg: 60, reps: 10, durationS: null, distanceM: null, rpe: null },
      { setType: "normal", weightKg: 100, reps: 5, durationS: null, distanceM: null, rpe: 8 },
      { setType: "normal", weightKg: 100, reps: 5, durationS: null, distanceM: null, rpe: 8.5 },
    ]);
    expect(pull?.exercises.map((exercise) => exercise.supersetGroup)).toEqual([null, 0, 0]);
    expect(legs?.exercises[0]?.sets.at(-1)?.setType).toBe("drop");
    expect(legs?.exercises[2]?.sets).toEqual([
      {
        setType: "normal",
        weightKg: null,
        reps: null,
        durationS: 900,
        distanceM: 2_000,
        rpe: null,
      },
    ]);
  });

  it("gives a workout the same fingerprint until something other than its start changes", () => {
    const [before] = Result.getOrThrow(decode(sample("hevy-sample.csv"))).workouts;
    const [after, renamed] = Result.getOrThrow(decode(sample("hevy-sample-changed.csv"))).workouts;
    const [, pull] = Result.getOrThrow(decode(sample("hevy-sample.csv"))).workouts;
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
    expect(renamed?.fingerprint).not.toBe(pull?.fingerprint);
    const moved = sample("hevy-sample.csv")
      .replaceAll("3 Nov 2026, 18:30", "3 Nov 2026, 18:00")
      .replaceAll("3 Nov 2026, 19:35", "3 Nov 2026, 19:05");
    expect(Result.getOrThrow(decode(moved)).workouts[0]?.fingerprint).toBe(before?.fingerprint);
  });

  it("ignores columns it does not know, in any order", () => {
    const text = [
      '"exercise_title","rpe","start_time","title","heart_rate","reps","weight_kg"',
      '"Squat (Barbell)",,"1 Feb 2025, 10:00","Legs",151,5,100',
    ].join("\n");
    const file = Result.getOrThrow(decode(text));
    expect(file.workouts[0]?.exercises[0]?.sets).toEqual([
      { setType: "normal", weightKg: 100, reps: 5, durationS: null, distanceM: null, rpe: null },
    ]);
    expect(file.workouts[0]?.durationS).toBe(0);
  });

  it("converts pounds and miles", () => {
    const text = [
      '"title","start_time","end_time","exercise_title","set_index","set_type","weight_lbs","reps","distance_miles","duration_seconds"',
      '"Mix","1 Feb 2025, 10:00","1 Feb 2025, 11:00","Bench Press (Barbell)",0,"normal",225,5,,',
      '"Mix","1 Feb 2025, 10:00","1 Feb 2025, 11:00","Treadmill",0,"normal",,,1,600',
    ].join("\n");
    const [workout] = Result.getOrThrow(decode(text)).workouts;
    expect(workout?.exercises[0]?.sets[0]?.weightKg).toBe(102.058);
    expect(workout?.exercises[1]?.sets[0]?.distanceM).toBe(1_609.3);
  });

  it("starts a new exercise when the same name comes back after another", () => {
    const text = [
      HEADER,
      row("Bicep Curl (Dumbbell)", 0),
      row("Hammer Curl (Dumbbell)", 0),
      row("Bicep Curl (Dumbbell)", 0),
      row("Bicep Curl (Dumbbell)", 1),
    ].join("\n");
    const [workout] = Result.getOrThrow(decode(text)).workouts;
    expect(workout?.exercises.map((exercise) => [exercise.name, exercise.sets.length])).toEqual([
      ["Bicep Curl (Dumbbell)", 1],
      ["Hammer Curl (Dumbbell)", 1],
      ["Bicep Curl (Dumbbell)", 2],
    ]);
  });

  it("leaves out and counts sets that record no reps, time or distance", () => {
    const text = [
      HEADER,
      '"Legs","1 Feb 2025, 10:00","1 Feb 2025, 11:00","","Squat (Barbell)",,"",0,"normal",100,,,,',
      '"Legs","1 Feb 2025, 10:00","1 Feb 2025, 11:00","","Squat (Barbell)",,"",1,"normal",100,5,,,',
    ].join("\n");
    const file = Result.getOrThrow(decode(text));
    expect(file.sets).toBe(1);
    expect(file.emptySets).toBe(1);
  });

  it("tells two workouts with one start apart by title or end", () => {
    const text = [
      HEADER,
      '"Morning","1 Feb 2025, 10:00","1 Feb 2025, 11:00","","Squat (Barbell)",,"",0,"normal",100,5,,,',
      '"Again","1 Feb 2025, 10:00","1 Feb 2025, 10:30","","Squat (Barbell)",,"",0,"normal",100,5,,,',
    ].join("\n");
    const file = Result.getOrThrow(decode(text));
    expect(file.workouts.map((workout) => [workout.title, workout.position])).toEqual([
      ["Morning", 0],
      ["Again", 1],
    ]);
  });

  it("refuses a file that is not a Hevy export, or that it cannot read", () => {
    expect(failureOf("")).toMatchObject({ reason: "not_hevy" });
    expect(failureOf('{"format":"svett"}')).toMatchObject({ reason: "not_hevy" });
    expect(
      failureOf(`${HEADER}\n"Legs","yesterday","","","Squat",,"",0,"normal",1,1,,,`),
    ).toMatchObject({
      reason: "invalid",
      message: 'Row 2 has a start time svett cannot read, "yesterday".',
    });
    expect(
      failureOf(
        `${HEADER}\n"Legs","1 Feb 2025, 10:00","1 Feb 2025, 11:00","","",,"",0,"normal",1,1,,,`,
      ),
    ).toMatchObject({
      reason: "invalid",
      message: "Row 2 has no exercise.",
    });
    expect(failureOf(`${HEADER}\n"Legs,"1 Feb`)).toMatchObject({ reason: "invalid" });
  });

  it.each<readonly [fields: string, message: string]>([
    [',"",1,"normal",10O,5,,,', 'Row 3 has a weight_kg svett cannot read, "10O".'],
    [',"",1,"normal",100,five,,,', 'Row 3 has a reps svett cannot read, "five".'],
    [',"",1,"normal",100,5.5,,,', 'Row 3 has a reps svett cannot read, "5.5".'],
    [',"",1,"normal",-20,5,,,', 'Row 3 has a weight_kg svett cannot read, "-20".'],
    [',"",1,"normal",1e3,5,,,', 'Row 3 has a weight_kg svett cannot read, "1e3".'],
    [',"",1,"normal",100,5,,,11', 'Row 3 has a rpe svett cannot read, "11".'],
    [',"",1,"normal",100,5,,60s,', 'Row 3 has a duration_seconds svett cannot read, "60s".'],
    [',"",x,"normal",100,5,,,', 'Row 3 has a set_index svett cannot read, "x".'],
    ['A,"",1,"normal",100,5,,,', 'Row 3 has a superset_id svett cannot read, "A".'],
    [',"",1,"normal",100,5,"1,5",,', 'Row 3 has a distance_km svett cannot read, "1,5".'],
  ])("refuses a number it cannot read, naming the row and the column: %s", (fields, message) => {
    expect(failureOf(legsWith(fields))).toMatchObject({ reason: "invalid", message });
  });

  it("reads a number with spaces around it", () => {
    const file = Result.getOrThrow(decode(legsWith(',"",1,"normal", 102.5 ,5,,,')));
    expect(file.workouts.at(-1)?.exercises[0]?.sets[0]).toMatchObject({ weightKg: 102.5, reps: 5 });
  });
});

describe("hevyFileLabel", () => {
  it("says how many workouts and sets the file holds, and how many sets it leaves out", () => {
    const file = Result.getOrThrow(decode(sample("hevy-sample.csv")));
    expect(hevyFileLabel(file)).toBe("A Hevy export with 3 workouts and 25 sets.");
    expect(
      hevyFileLabel({ ...file, workouts: file.workouts.slice(0, 1), sets: 1, emptySets: 1 }),
    ).toBe(
      "A Hevy export with 1 workout and 1 set. One set records no reps, time or distance, so svett leaves it out.",
    );
    expect(hevyFileLabel({ ...file, emptySets: 1_200 })).toBe(
      "A Hevy export with 3 workouts and 25 sets. 1,200 sets record no reps, time or distance, so svett leaves them out.",
    );
  });
});
