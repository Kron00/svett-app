import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "./duration.ts";
import { ActivityId, EpochMillis, Fingerprint, SourceIdentity } from "./schema.ts";
import {
  healthActivityName,
  heartRateSummary,
  type LocalActivity,
  planSourceImport,
  sourceActivityId,
  sourceImportOutcome,
  type SourceWorkout,
} from "./source-import.ts";

const HOUR = 3_600_000;
const T = Date.UTC(2026, 10, 3, 17);

const workout = (identity: string, start: number, minutes: number): SourceWorkout => ({
  source: "apple_health",
  identity: SourceIdentity.make(identity),
  fingerprint: Fingerprint.make("a".repeat(64)),
  kind: "strength",
  title: "Evening workout",
  startedAt: EpochMillis.make(start),
  endedAt: EpochMillis.make(start + minutes * 60_000),
  durationS: DurationSeconds.make(minutes * 60),
  distanceM: null,
  energyKcal: null,
  route: [],
  heartRate: [],
});

const local = (
  id: string,
  start: number,
  source: LocalActivity["source"],
  overrides: Partial<LocalActivity> = {},
): LocalActivity => ({
  id: ActivityId.make(id),
  kind: "strength",
  title: id,
  startedAt: EpochMillis.make(start),
  durationS: DurationSeconds.make(3600),
  source,
  sourceId: source === "svett" ? null : SourceIdentity.make(id),
  fingerprint: source === "svett" ? null : Fingerprint.make("b".repeat(64)),
  ...overrides,
});

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("planSourceImport", () => {
  it("matches a workout to the activity from another source it overlaps most", () => {
    const plan = planSourceImport(
      {
        activities: [
          local(UUID(1), T - HOUR + 5 * 60_000, "svett"),
          local(UUID(2), T, "hevy"),
          local(UUID(3), T, "apple_health"),
        ],
        links: [],
      },
      [workout("a", T + 5 * 60_000, 50), workout("b", T + 2 * HOUR, 30)],
    );
    expect(plan.duplicates.map((item) => [item.workout.identity, item.match.id])).toEqual([
      ["a", UUID(2)],
    ]);
    expect(plan.added).toBe(1);
  });

  it("counts a workout already linked, or already here, as unchanged, and one repeated in the file once", () => {
    const here = workout("here", T - 3 * HOUR, 30);
    const plan = planSourceImport(
      {
        activities: [
          local(sourceActivityId(here), here.startedAt, "apple_health", {
            fingerprint: here.fingerprint,
          }),
          local(UUID(2), T, "hevy"),
        ],
        links: [
          {
            activityId: ActivityId.make(UUID(2)),
            source: "apple_health",
            sourceId: SourceIdentity.make("linked"),
          },
        ],
      },
      [here, workout("linked", T, 60), workout("linked", T, 60)],
    );
    expect(plan.unchanged).toBe(2);
    expect(plan.items).toHaveLength(2);
  });

  it("does not match activities that only touch end to start", () => {
    const plan = planSourceImport({ activities: [local(UUID(2), T - HOUR, "hevy")], links: [] }, [
      workout("next", T, 30),
    ]);
    expect(plan.added).toBe(1);
  });
});

describe("heartRateSummary", () => {
  it("gives the rounded mean and the highest reading", () => {
    expect(
      heartRateSummary([
        { kind: "heart_rate", bpm: 120 },
        { kind: "location" },
        { kind: "heart_rate", bpm: 141 },
      ]),
    ).toEqual({ averageBpm: 131, maxBpm: 141 });
    expect(heartRateSummary([{ kind: "location" }])).toBeNull();
  });
});

describe("sourceImportOutcome", () => {
  it("says what the import did", () => {
    expect(sourceImportOutcome({ added: 3, linked: 1, replaced: 0 })).toBe(
      "Added 3 workouts and linked 1 workout to one already here.",
    );
    expect(sourceImportOutcome({ added: 1, linked: 2, replaced: 1 })).toBe(
      "Added 1 workout, linked 2 workouts to ones already here and took the new version of 1 workout.",
    );
    expect(sourceImportOutcome({ added: 0, linked: 0, replaced: 0 })).toBe("Nothing changed.");
  });
});

describe("healthActivityName", () => {
  it("reads Health's activity type as words", () => {
    expect(healthActivityName("HKWorkoutActivityTypeHighIntensityIntervalTraining")).toBe(
      "High intensity interval training",
    );
    expect(healthActivityName("HKWorkoutActivityTypeYoga")).toBe("Yoga");
  });
});
