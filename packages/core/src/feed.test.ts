import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "./duration.ts";
import {
  cleanComment,
  COMMENT_MAX_LENGTH,
  commentProblem,
  isPublished,
  type PostRows,
  thinRoute,
  viewPostDetail,
  visibleRoute,
} from "./feed.ts";
import {
  formatPostDistance,
  formatPostPace,
  hiddenNote,
  inboxLine,
  liftingLine,
  postCounts,
  postSetLines,
  projectRoute,
  splitLines,
  routeLine,
} from "./feed-format.ts";
import { privacy, SocialActivityId, type Visibility } from "./privacy.ts";
import {
  type Activity,
  type ActivityExercise,
  ActivityExerciseId,
  ActivityId,
  type ActivitySample,
  ActivitySampleId,
  type ActivitySet,
  ActivitySetId,
  type ActivityTrack,
  ActivityTrackId,
  EpochMillis,
  ExerciseId,
  HiddenField,
} from "./schema.ts";

const uuid = (n: number) => `0190a0b2-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ROW = { updatedAt: EpochMillis.make(1), deletedAt: null };

const activity = (kind: Activity["kind"], durationS = 1800): Activity => ({
  id: ActivityId.make(uuid(1)),
  ...ROW,
  kind,
  startedAt: EpochMillis.make(1_790_000_000_000),
  durationS: DurationSeconds.make(durationS),
  title: "Session",
  notes: "",
  energyKcal: 410,
  audience: "everyone",
  hiddenFields: [],
  source: "svett",
  sourceId: null,
  fingerprint: null,
  importBatchId: null,
});

const exercise = (n: number, position: number): ActivityExercise => ({
  id: ActivityExerciseId.make(uuid(100 + n)),
  ...ROW,
  activityId: ActivityId.make(uuid(1)),
  exerciseId: ExerciseId.make(uuid(200 + n)),
  position,
  supersetGroup: null,
  notes: "",
});

const set = (
  n: number,
  position: number,
  weightKg: number | null,
  reps: number,
  setType: ActivitySet["setType"] = "normal",
): ActivitySet => ({
  id: ActivitySetId.make(uuid(300 + n)),
  ...ROW,
  activityExerciseId: ActivityExerciseId.make(uuid(100)),
  position,
  setType,
  weightKg,
  reps,
  durationS: null,
  distanceM: null,
  rpe: null,
});

const lifting: PostRows = {
  exercises: [
    {
      exercise: exercise(2, 1),
      name: "Barbell Row",
      primaryMuscles: ["upper_back"],
      sets: [set(4, 0, 60, 10)],
    },
    {
      exercise: exercise(1, 0),
      name: "Bench Press",
      primaryMuscles: ["chest"],
      sets: [set(2, 1, 80, 8), set(1, 0, 40, 10, "warm_up"), set(3, 2, 80, 7)],
    },
  ],
  track: undefined,
};

// About 111 m per 0.001 degree of latitude, so each step north is about 111 m.
const north = (steps: number) =>
  Array.from({ length: steps + 1 }, (_, index) => ({
    latitude: 59.9 + index * 0.001,
    longitude: 10.7,
  }));

const track: ActivityTrack = {
  id: ActivityTrackId.make(uuid(400)),
  ...ROW,
  activityId: ActivityId.make(uuid(1)),
  distanceM: 5000,
  elevationGainM: 40,
  hideStartM: 200,
  hideEndM: 300,
};

const samples = (): ReadonlyArray<ActivitySample> => [
  ...north(10).map((point, index): ActivitySample => ({
    id: ActivitySampleId.make(uuid(500 + index)),
    updatedAt: ROW.updatedAt,
    deletedAt: null,
    activityTrackId: track.id,
    recordedAt: EpochMillis.make(1_790_000_000_000 + index * 1000),
    kind: "location",
    latitude: point.latitude,
    longitude: point.longitude,
    altitudeM: 12,
  })),
  {
    id: ActivitySampleId.make(uuid(600)),
    ...ROW,
    activityTrackId: track.id,
    recordedAt: EpochMillis.make(1_790_000_000_500),
    kind: "heart_rate",
    bpm: 150,
  },
  {
    id: ActivitySampleId.make(uuid(601)),
    ...ROW,
    activityTrackId: track.id,
    recordedAt: EpochMillis.make(1_790_000_001_500),
    kind: "heart_rate",
    bpm: 161,
  },
  {
    id: ActivitySampleId.make(uuid(602)),
    ...ROW,
    activityTrackId: track.id,
    recordedAt: EpochMillis.make(1_790_000_300_000),
    kind: "split",
    distanceM: 1000,
    durationS: DurationSeconds.make(318),
  },
];

const seen = (hidden: ReadonlyArray<HiddenField>): Visibility =>
  privacy({
    viewer: "user_viewer",
    owner: "user_owner",
    follow: "following",
    blocked: false,
    audience: "followers",
    hiddenFields: hidden,
  });

describe("viewPostDetail", () => {
  it("shows a lifting session's exercises and sets in order, with its muscle split and volume", () => {
    expect(viewPostDetail(activity("strength"), lifting, seen([]))).toEqual({
      type: "lifting",
      exercises: [
        {
          position: 0,
          name: "Bench Press",
          sets: [
            {
              position: 0,
              setType: "warm_up",
              weightKg: 40,
              reps: 10,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
            {
              position: 1,
              setType: "normal",
              weightKg: 80,
              reps: 8,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
            {
              position: 2,
              setType: "normal",
              weightKg: 80,
              reps: 7,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
          ],
        },
        {
          position: 1,
          name: "Barbell Row",
          sets: [
            {
              position: 0,
              setType: "normal",
              weightKg: 60,
              reps: 10,
              durationS: null,
              distanceM: null,
              rpe: null,
            },
          ],
        },
      ],
      split: [
        { muscle: "chest", sets: 2, percent: 67 },
        { muscle: "upper_back", sets: 1, percent: 33 },
      ],
      volumeKg: 80 * 8 + 80 * 7 + 60 * 10,
    });
  });

  it("leaves every weight and the volume out when weight is hidden", () => {
    const detail = viewPostDetail(activity("strength"), lifting, seen(["weight"]));
    expect(detail?.type).toBe("lifting");
    if (detail?.type !== "lifting") return;
    expect(detail.volumeKg).toBeNull();
    expect(detail.exercises.flatMap((entry) => entry.sets.map((one) => one.weightKg))).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(detail.exercises[0]?.sets[1]?.reps).toBe(8);
  });

  it("shows a run's distance, pace, splits, heart rate and route without its ends or any time", () => {
    const detail = viewPostDetail(
      activity("run", 1500),
      { exercises: [], track: { track, samples: samples() } },
      seen([]),
    );
    expect(detail).toEqual({
      type: "route",
      distanceM: 5000,
      elevationGainM: 40,
      paceSPerKm: 300,
      splits: [{ distanceM: 1000, endM: 1000, durationS: 318 }],
      // 200 m hides the first two readings, 300 m the last three.
      route: [north(10).slice(2, 8)],
      averageHeartRateBpm: 156,
    });
    expect(JSON.stringify(detail)).not.toContain("1790000000");
  });

  it("leaves out pace, split times and heart rate when the owner hides them", () => {
    const detail = viewPostDetail(
      activity("run", 1500),
      { exercises: [], track: { track, samples: samples() } },
      seen(["pace", "heart_rate"]),
    );
    expect(detail).toMatchObject({
      paceSPerKm: null,
      splits: [{ distanceM: 1000, endM: 1000, durationS: null }],
      averageHeartRateBpm: null,
    });
    expect(JSON.stringify(detail)).not.toContain("318");
    expect(JSON.stringify(detail)).not.toContain("156");
  });

  it("gives nothing to a viewer the privacy rule shuts out", () => {
    expect(viewPostDetail(activity("strength"), lifting, { visible: false })).toBeUndefined();
  });

  it("has no detail for an activity without sets or a route", () => {
    expect(
      viewPostDetail(activity("other"), { exercises: [], track: undefined }, seen([])),
    ).toBeNull();
  });
});

describe("visibleRoute", () => {
  it("drops every reading inside either circle", () => {
    expect(visibleRoute(north(10), 200, 300)).toEqual(north(10).slice(2, 8));
    expect(visibleRoute(north(10), 0, 0)).toEqual(north(10).slice(1, 10));
  });

  it("shows nothing when the circles cover the route", () => {
    expect(visibleRoute(north(4), 300, 300)).toEqual([]);
    expect(visibleRoute(north(0), 0, 0)).toEqual([]);
  });

  it("keeps a loop's middle when it starts and ends at the door", () => {
    const out = north(5);
    const loop = [...out, ...out.slice(0, -1).toReversed()];
    expect(visibleRoute(loop, 250, 250)).toEqual(loop.slice(3, 8));
  });
});

describe("thinRoute", () => {
  it("keeps at most the limit, with the first and last positions", () => {
    const long = north(999);
    const thin = thinRoute(long, 50);
    expect(thin).toHaveLength(50);
    expect(thin[0]).toEqual(long[0]);
    expect(thin.at(-1)).toEqual(long.at(-1));
    expect(thinRoute(north(3), 50)).toEqual(north(3));
  });
});

const OVERRIDE = String.fromCodePoint(0x202e);
const BELL = String.fromCodePoint(7);

describe("comments", () => {
  it("keeps line breaks and drops control and direction characters", () => {
    expect(cleanComment(`  Nice\r\nrun${OVERRIDE}!${BELL} `)).toBe("Nice\nrun!");
  });

  it("refuses an empty comment and one over the limit, counting characters as people do", () => {
    expect(commentProblem("")).toBe("Write something first.");
    expect(commentProblem("💪".repeat(COMMENT_MAX_LENGTH))).toBeUndefined();
    expect(commentProblem("a".repeat(COMMENT_MAX_LENGTH + 1))).toBe(
      `A comment holds up to ${COMMENT_MAX_LENGTH} characters. This one has ${COMMENT_MAX_LENGTH + 1}.`,
    );
  });
});

describe("isPublished", () => {
  it("keeps a workout in progress out of every feed", () => {
    expect(isPublished({ status: "in_progress" })).toBe(false);
    expect(isPublished({ status: "finished" })).toBe(true);
    expect(isPublished({ title: "Before drafts existed" })).toBe(true);
  });
});

describe("feed lines", () => {
  const post = {
    username: "anna",
    id: SocialActivityId.make(uuid(9)),
    kind: "run" as const,
    title: "Morning run",
    mine: true,
  };
  const item = { id: "i", username: "ben", at: EpochMillis.make(1), unread: true };

  it("says what each inbox item is", () => {
    expect(inboxLine({ ...item, kind: "like", post })).toBe("ben liked your run Morning run");
    expect(
      inboxLine({
        ...item,
        kind: "comment",
        body: "Fast!",
        post: { ...post, mine: false, title: "" },
      }),
    ).toBe("ben commented on anna's run");
    expect(inboxLine({ ...item, kind: "follow" })).toBe("ben follows you");
    expect(inboxLine({ ...item, kind: "follow_request" })).toBe("ben asked to follow you");
  });

  it("sums up a post", () => {
    const detail = viewPostDetail(activity("strength"), lifting, seen([]));
    if (detail?.type !== "lifting") throw new Error("expected a lifting detail");
    expect(liftingLine(detail)).toBe("2 exercises · 4 sets · 1,800 kg");
    expect(liftingLine({ ...detail, volumeKg: null })).toBe("2 exercises · 4 sets · Weight hidden");
    expect(
      routeLine({
        type: "route",
        distanceM: 4996,
        elevationGainM: null,
        paceSPerKm: 312.4,
        splits: [],
        route: [],
        averageHeartRateBpm: null,
      }),
    ).toBe("4.99 km · 5:12 /km");
    expect(formatPostDistance(10_000)).toBe("10.00 km");
    expect(formatPostPace(3725)).toBe("1:02:05 /km");
    expect(postCounts({ likes: 1, comments: 0 })).toBe("1 like · 0 comments");
  });
});

describe("projectRoute", () => {
  it("draws north up, centred in the box, at one scale for both directions", () => {
    const [line] = projectRoute([north(2)], 224, 124);
    // 2 steps north span 100 points of height, centred across the 224 points of width.
    expect(line).toBe("112.0,112.0 112.0,62.0 112.0,12.0");
    expect(projectRoute([], 224, 124)).toEqual([]);
    expect(projectRoute([north(2)], 0, 124)).toEqual([]);
  });
});

describe("post details", () => {
  it("numbers normal sets and letters the others, as P1's detail does", () => {
    const detail = viewPostDetail(activity("strength"), lifting, seen(["weight"]));
    if (detail?.type !== "lifting") throw new Error("expected a lifting detail");
    expect(postSetLines(detail.exercises[0]!.sets)).toEqual([
      {
        position: 0,
        setType: "warm_up",
        badge: { text: "W", label: "Warm-up set" },
        text: "10 reps",
      },
      { position: 1, setType: "normal", badge: { text: "1", label: "Set 1" }, text: "8 reps" },
      { position: 2, setType: "normal", badge: { text: "2", label: "Set 2" }, text: "7 reps" },
    ]);
  });

  it("gives each split its number and pace, or says its time is hidden", () => {
    expect(
      splitLines([
        { distanceM: 1000, endM: 1000, durationS: DurationSeconds.make(330) },
        { distanceM: 500, endM: 1500, durationS: null },
      ]),
    ).toEqual([
      { endM: 1000, number: 1, title: "Split 1, 1.00 km", pace: "5:30 /km" },
      { endM: 1500, number: 2, title: "Split 2, 0.50 km", pace: "Hidden" },
    ]);
  });

  it("says which fields the owner hides", () => {
    expect(hiddenNote("anna", [])).toBeUndefined();
    expect(hiddenNote("anna", ["weight"])).toBe("anna hides weight.");
    expect(hiddenNote("anna", ["heart_rate", "start_time", "pace"])).toBe(
      "anna hides heart rate, start time and pace.",
    );
  });
});
