import { describe, expect, it } from "vite-plus/test";

import { Result } from "effect";

import { DurationSeconds } from "./duration.ts";
import type { GpxPoint, GpxTrack } from "./gpx.ts";
import { ActivityId, EpochMillis, Fingerprint, ImportBatchId, SourceIdentity } from "./schema.ts";
import {
  fromGpx,
  healthActivityName,
  heartRateSummary,
  type LocalActivity,
  planSourceImport,
  sourceActivityId,
  sourceActivityRows,
  sourceImportOutcome,
  type SourcePlan,
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

const identities = (items: SourcePlan["items"]) =>
  items.map((item) => [item.workout.durationS, item.workout.identity]);

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
            fingerprint: Fingerprint.make("a".repeat(64)),
          },
        ],
      },
      [here, workout("linked", T, 60), workout("linked", T, 60)],
    );
    expect(plan.unchanged).toBe(2);
    expect(plan.items).toHaveLength(2);
    expect(plan.collisions).toEqual([]);
  });

  it("lists a linked workout whose content changed since it was linked", () => {
    const plan = planSourceImport(
      {
        activities: [local(UUID(2), T, "hevy")],
        links: [
          {
            activityId: ActivityId.make(UUID(2)),
            source: "apple_health",
            sourceId: SourceIdentity.make("linked"),
            fingerprint: Fingerprint.make("0".repeat(64)),
          },
        ],
      },
      [workout("linked", T, 60)],
    );
    expect(plan.changed).toMatchObject([
      { key: "apple_health:linked", local: UUID(2), linked: true },
    ]);
    expect(plan.unchanged).toBe(0);
  });

  it("keeps workouts that share an identity but not their content, with the same IDs in any order", () => {
    const first = workout("same", T, 30);
    const second = { ...workout("same", T, 45), fingerprint: Fingerprint.make("c".repeat(64)) };
    const plan = planSourceImport({ activities: [], links: [] }, [second, first, second]);
    expect(plan.added).toBe(2);
    expect(plan.collisions.map((item) => item.workout.identity).toSorted()).toEqual([
      "same",
      "same #2",
    ]);
    const again = planSourceImport({ activities: [], links: [] }, [first, second]);
    expect(identities(again.items)).toEqual(identities(plan.items));
    expect(identities(plan.items)).toEqual([
      [1800, "same"],
      [2700, "same #2"],
    ]);
  });

  it("does not match activities that only touch end to start", () => {
    const plan = planSourceImport({ activities: [local(UUID(2), T - HOUR, "hevy")], links: [] }, [
      workout("next", T, 30),
    ]);
    expect(plan.added).toBe(1);
  });
});

const MINUTE = 60_000;
/** About 100 metres of latitude. */
const STEP = 0.0009;

/** Points a minute apart heading north by `step` degrees, from `lat`, starting `start`. */
const northward = (start: number, lat: number, count: number, step = STEP): Array<GpxPoint> =>
  Array.from({ length: count }, (_, index) => ({
    recordedAt: start + index * MINUTE,
    latitude: lat + index * step,
    longitude: 18,
    altitudeM: null,
    heartRate: null,
  }));

const ride = (segments: GpxTrack["segments"], name: string | null = "Ride"): SourceWorkout =>
  Result.getOrThrow(fromGpx({ name, type: "cycling", segments }, () => 9));

describe("fromGpx", () => {
  it("counts no distance, time or splits across the gap between two segments", () => {
    // Two kilometres ridden, with a 5 km jump and half an hour between the segments.
    const gapped = ride([northward(T, 59, 11), northward(T + 40 * MINUTE, 59.05, 11)]);
    expect(gapped.distanceM).toBeCloseTo(2 * 10 * STEP * 111_195, -1);
    expect(gapped.durationS).toBe(20 * 60);
    expect(gapped.endedAt).toBe(T + 50 * MINUTE);

    const rows = sourceActivityRows(gapped, ImportBatchId.make(UUID(9)), EpochMillis.make(T));
    const samples = rows.activitySample ?? [];
    const locations = samples.filter((sample) => sample["kind"] === "location");
    expect(locations.map((sample) => sample["segment"])).toEqual([
      ...Array<number>(11).fill(0),
      ...Array<number>(11).fill(1),
    ]);
    const splits = samples.filter((sample) => sample["kind"] === "split");
    const total = (key: string) => splits.reduce((sum, split) => sum + (split[key] as number), 0);
    expect(total("distanceM")).toBeCloseTo(gapped.distanceM!, 6);
    expect(total("durationS")).toBeCloseTo(gapped.durationS, 6);
    expect(splits).toHaveLength(3);
  });

  it("reads a track too long to spread into Math.max", () => {
    const long = ride([northward(T, 0, 300_000, 0)]);
    expect(long.endedAt).toBe(T + 299_999 * MINUTE);
  });

  it("counts a renamed track as other content", () => {
    const points = [northward(T, 59, 3)];
    expect(ride(points, "Ride").fingerprint).toBe(ride(points, "Ride").fingerprint);
    expect(ride(points, "Ride to work").fingerprint).not.toBe(ride(points, "Ride").fingerprint);
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
    const long = Array.from({ length: 300_000 }, (_, index) => ({
      kind: "heart_rate",
      bpm: 100 + (index % 50),
    }));
    expect(heartRateSummary(long)?.maxBpm).toBe(149);
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
