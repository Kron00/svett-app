import { Effect, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  type ManualEntry,
  manualEntryDraft,
  parseDistanceKm,
  parseDuration,
} from "./manual-entry.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { openTestDatabase, T0 } from "./test-database.ts";

const entry = (overrides: Partial<ManualEntry> = {}): ManualEntry => ({
  kind: "ride",
  startedAt: T0 - 7_200_000,
  duration: "1:05:00",
  distance: "25,4",
  notes: "  Along the coast ",
  ...overrides,
});

const problem = (overrides: Partial<ManualEntry>) => {
  const result = manualEntryDraft(entry(overrides), T0, 9);
  return Result.isFailure(result) ? result.failure.field : null;
};

describe("parseDuration", () => {
  it("reads minutes, minutes and seconds, or hours, minutes and seconds", () => {
    expect(parseDuration("45")).toBe(2700);
    expect(parseDuration("45:30")).toBe(2730);
    expect(parseDuration("1:05:00")).toBe(3900);
    expect(parseDuration("12.5")).toBe(750);
  });

  it("refuses what is not a time", () => {
    for (const text of ["", "abc", "1:75", "1:2:3:4", "-5"])
      expect(parseDuration(text), text).toBeNull();
  });
});

describe("parseDistanceKm", () => {
  it("reads kilometres with a point or a comma, and nothing as no distance", () => {
    expect(parseDistanceKm("5.2")).toBe(5200);
    expect(parseDistanceKm("5,2")).toBe(5200);
    expect(parseDistanceKm(" ")).toBeNull();
    expect(parseDistanceKm("five")).toBeNaN();
  });
});

describe("manualEntryDraft", () => {
  it("saves a ride with its distance, notes and a title from the hour it started", async () => {
    const draft = Result.getOrThrow(manualEntryDraft(entry(), T0, 18));
    expect(draft).toMatchObject({
      kind: "ride",
      startedAt: T0 - 7_200_000,
      durationS: 3900,
      title: "Evening ride",
      notes: "Along the coast",
      origin: { source: "svett" },
      track: { distanceM: 25_400, samples: [] },
    });
    const database = openTestDatabase();
    const saved = await database.runtime.runPromise(
      Effect.gen(function* () {
        const activities = yield* ActivityRepository;
        return yield* activities.get(yield* activities.create(draft));
      }),
    );
    expect(Option.getOrThrow(saved).track?.distanceM).toBe(25_400);
  });

  it("saves a sport with no distance without a track", () => {
    const draft = Result.getOrThrow(
      manualEntryDraft(entry({ kind: "other", distance: "" }), T0, 7),
    );
    expect(draft.track).toBeNull();
    expect(draft.title).toBe("Morning workout");
  });

  it("names the field to fix", () => {
    expect(problem({ duration: "0" })).toBe("duration");
    expect(problem({ duration: "soon" })).toBe("duration");
    expect(problem({ distance: "far" })).toBe("distance");
    expect(problem({ startedAt: T0 + 60_000 })).toBe("start");
  });
});
