import { describe, expect, it } from "vite-plus/test";

import {
  adjustRest,
  DEFAULT_REST_S,
  restAfterSet,
  restLabel,
  restLeft,
  restNotice,
  restText,
  startRest,
} from "./rest-timer.ts";
import {
  leaveSuperset,
  supersetPlaces,
  supersetWithNext,
  type SupersetChange,
} from "./superset.ts";

const groups = (...values: ReadonlyArray<number | null>) =>
  values.map((supersetGroup) => ({ supersetGroup }));

const apply = (
  exercises: ReadonlyArray<{ readonly supersetGroup: number | null }>,
  changes: ReadonlyArray<SupersetChange>,
) => {
  const next = exercises.map((exercise) => exercise.supersetGroup);
  for (const change of changes) next[change.index] = change.supersetGroup;
  return groups(...next);
};

/** Each exercise as its letter, "-" when it is in no superset. */
const letters = (exercises: ReadonlyArray<{ readonly supersetGroup: number | null }>) =>
  supersetPlaces(exercises)
    .map((place) => place?.letter ?? "-")
    .join("");

describe("supersets", () => {
  it("letters runs of neighbours that share a group, in workout order", () => {
    expect(letters(groups(null, 4, 4, null, 1, 1, 1))).toBe("-AA-BBB");
    expect(supersetPlaces(groups(2, 2, 2))).toEqual([
      { letter: "A", first: true, last: false },
      { letter: "A", first: false, last: false },
      { letter: "A", first: false, last: true },
    ]);
  });

  it("treats an exercise moved away from its group as in none, and a split group as two", () => {
    expect(letters(groups(0, null, 0))).toBe("---");
    expect(letters(groups(0, 0, null, 0, 0))).toBe("AA-BB");
  });

  it("joins an exercise with the next, and a whole superset with the next exercise", () => {
    let workout = groups(null, null, null);
    workout = apply(workout, supersetWithNext(workout, 0));
    expect(letters(workout)).toBe("AA-");
    workout = apply(workout, supersetWithNext(workout, 1));
    expect(letters(workout)).toBe("AAA");
    expect(supersetWithNext(workout, 0)).toEqual([]);
    expect(supersetWithNext(workout, 2)).toEqual([]);
  });

  it("merges the next exercise's superset into this one", () => {
    const workout = groups(null, 3, 3, null);
    expect(letters(apply(workout, supersetWithNext(workout, 0)))).toBe("AAA-");
  });

  it("takes an exercise out, and leaves no superset of one", () => {
    const pair = groups(0, 0);
    expect(letters(apply(pair, leaveSuperset(pair, 0)))).toBe("--");
    const three = groups(0, 0, 0);
    expect(letters(apply(three, leaveSuperset(three, 0)))).toBe("-AA");
    expect(letters(apply(three, leaveSuperset(three, 1)))).toBe("---");
    expect(letters(apply(three, leaveSuperset(three, 2)))).toBe("AA-");
    const five = groups(0, 0, 0, 0, 0);
    expect(letters(apply(five, leaveSuperset(five, 2)))).toBe("AA-BB");
    expect(leaveSuperset(groups(null, null), 0)).toEqual([]);
  });
});

const exercise = (supersetGroup: number | null, restS: number | null) => ({
  supersetGroup,
  restS,
});

describe("the rest timer", () => {
  it("rests for the exercise's time after a set, and not when it is off", () => {
    expect(restAfterSet([exercise(null, 120)], 0)).toEqual({ seconds: 120, next: 0 });
    expect(restAfterSet([exercise(null, 0)], 0)).toBeNull();
    expect(restAfterSet([exercise(null, null)], 0)).toBeNull();
  });

  it("goes straight on in a superset, and rests after the round's last exercise", () => {
    const workout = [exercise(null, 90), exercise(1, 60), exercise(1, 30), exercise(1, 120)];
    expect(restAfterSet(workout, 1)).toBeNull();
    expect(restAfterSet(workout, 2)).toBeNull();
    expect(restAfterSet(workout, 3)).toEqual({ seconds: 120, next: 1 });
    expect(restAfterSet(workout, 0)).toEqual({ seconds: 90, next: 0 });
  });

  it("counts down in whole seconds and ends at zero", () => {
    const timer = startRest(90, "Barbell Squat", 1_000);
    expect(restLeft(timer, 1_000)).toBe(90);
    expect(restLeft(timer, 1_500)).toBe(90);
    expect(restLeft(timer, 2_000)).toBe(89);
    expect(restLeft(timer, 91_000)).toBe(0);
    expect(restLeft(timer, 200_000)).toBe(0);
  });

  it("moves 15 seconds either way, never below zero", () => {
    const timer = startRest(30, "Barbell Squat", 0);
    const longer = adjustRest(timer, 15, 10_000);
    expect(restLeft(longer, 10_000)).toBe(35);
    expect(longer.totalS).toBe(45);
    const shorter = adjustRest(timer, -15, 10_000);
    expect(restLeft(shorter, 10_000)).toBe(5);
    expect(restLeft(adjustRest(shorter, -15, 10_000), 10_000)).toBe(0);
  });

  it("shows and reads rest times, and says which exercise is next", () => {
    expect(restText(DEFAULT_REST_S)).toBe("1:30");
    expect(restText(0)).toBe("Off");
    expect(restLabel(90)).toBe("1 minute 30 seconds");
    expect(restLabel(120)).toBe("2 minutes");
    expect(restLabel(15)).toBe("15 seconds");
    expect(restNotice(startRest(90, "Barbell Squat", 0))).toEqual({
      title: "Rest is over",
      body: "Time for your next set of Barbell Squat.",
    });
  });
});
