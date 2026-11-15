import { describe, expect, it } from "vite-plus/test";

import {
  adjustRest,
  decodeRestTimer,
  restNoticeSeconds,
  restStillRuns,
  startRest,
} from "./rest-timer.ts";
import { ActivityExerciseId, ActivityId } from "./schema.ts";
import { SQUAT_NEXT } from "./test-sets.ts";

const OTHER = "00000000-0000-4000-8000-000000009999";

const workout = {
  activityId: SQUAT_NEXT.activityId,
  exerciseIds: [SQUAT_NEXT.activityExerciseId],
};

describe("a rest kept on the phone", () => {
  it("reads back as the rest that was running", () => {
    const rest = startRest(90, SQUAT_NEXT, 1_000);
    expect(decodeRestTimer(JSON.stringify(rest))).toEqual(rest);
  });

  it("reads as no rest when nothing or something broken was kept", () => {
    expect(decodeRestTimer(undefined)).toBeNull();
    expect(decodeRestTimer(null)).toBeNull();
    expect(decodeRestTimer("{not json")).toBeNull();
    expect(decodeRestTimer(JSON.stringify({ endsAt: 1_000, totalS: 90 }))).toBeNull();
  });

  it("still runs after a relaunch while its time is left and its workout and exercise are there", () => {
    const rest = startRest(90, SQUAT_NEXT, 0);
    expect(restStillRuns(rest, workout, 60_000)).toBe(true);
  });

  it("has ended once its time is up", () => {
    const rest = startRest(90, SQUAT_NEXT, 0);
    expect(restStillRuns(rest, workout, 90_000)).toBe(false);
    expect(restStillRuns(rest, workout, 200_000)).toBe(false);
  });

  it("has ended when its workout is gone, another is in progress, or its exercise was removed", () => {
    const rest = startRest(90, SQUAT_NEXT, 0);
    expect(restStillRuns(rest, null, 1_000)).toBe(false);
    expect(restStillRuns(rest, { ...workout, activityId: ActivityId.make(OTHER) }, 1_000)).toBe(
      false,
    );
    expect(
      restStillRuns(rest, { ...workout, exerciseIds: [ActivityExerciseId.make(OTHER)] }, 1_000),
    ).toBe(false);
  });
});

describe("the notification that ends a rest", () => {
  it("is due when the rest ends, in whole seconds", () => {
    const rest = startRest(90, SQUAT_NEXT, 0);
    expect(restNoticeSeconds(rest, 0)).toBe(90);
    expect(restNoticeSeconds(rest, 29_600)).toBe(60);
  });

  it("is due in a second when less than that is left", () => {
    expect(restNoticeSeconds(startRest(90, SQUAT_NEXT, 0), 89_700)).toBe(1);
  });

  it("is not needed once the rest is cut to nothing", () => {
    const rest = adjustRest(startRest(30, SQUAT_NEXT, 0), -45, 10_000);
    expect(rest.endsAt).toBe(10_000);
    expect(restNoticeSeconds(rest, 10_000)).toBeNull();
  });
});
