/**
 * Supersets. Exercises next to each other that share a superset group are done as one
 * round: a set of each in turn, then the rest. Only neighbours count, so an exercise moved
 * away from its group leaves it, and a group sync splits stays two supersets.
 */

type Grouped = { readonly supersetGroup: number | null };

/** Where an exercise sits in its superset, or null when it is in none. */
export type SupersetPlace = {
  /** "A" for the workout's first superset, "B" for the next, and so on. */
  readonly letter: string;
  readonly first: boolean;
  readonly last: boolean;
};

const letterOf = (index: number): string =>
  index < 26
    ? String.fromCharCode(65 + index)
    : `${letterOf(Math.floor(index / 26) - 1)}${letterOf(index % 26)}`;

const sameRun = (exercises: ReadonlyArray<Grouped>, a: number, b: number) => {
  const left = exercises[a]?.supersetGroup ?? null;
  return left !== null && left === (exercises[b]?.supersetGroup ?? null);
};

/** Each exercise's place in its superset, lettered in workout order. */
export const supersetPlaces = (
  exercises: ReadonlyArray<Grouped>,
): ReadonlyArray<SupersetPlace | null> => {
  let runs = 0;
  return exercises.map((_, index) => {
    const before = sameRun(exercises, index, index - 1);
    const after = sameRun(exercises, index, index + 1);
    if (!before && !after) return null;
    if (!before) runs += 1;
    return { letter: letterOf(runs - 1), first: !before, last: !after };
  });
};

/** A change to one exercise's superset group, by its place in the workout. */
export type SupersetChange = { readonly index: number; readonly supersetGroup: number | null };

const nextGroup = (exercises: ReadonlyArray<Grouped>) =>
  exercises.reduce((most, exercise) => Math.max(most, (exercise.supersetGroup ?? -1) + 1), 0);

/**
 * Joins the exercise at `index` with the one after it. The next exercise, and the rest of
 * its own superset, join this one's. Nothing changes for the last exercise.
 */
export const supersetWithNext = (
  exercises: ReadonlyArray<Grouped>,
  index: number,
): ReadonlyArray<SupersetChange> => {
  if (index < 0 || index >= exercises.length - 1 || sameRun(exercises, index, index + 1)) {
    return [];
  }
  const own = exercises[index]!.supersetGroup;
  const group = own !== null && sameRun(exercises, index, index - 1) ? own : nextGroup(exercises);
  const changes: Array<SupersetChange> = [];
  if (exercises[index]!.supersetGroup !== group) changes.push({ index, supersetGroup: group });
  for (let at = index + 1; at < exercises.length; at += 1) {
    if (at > index + 1 && !sameRun(exercises, at, at - 1)) break;
    changes.push({ index: at, supersetGroup: group });
  }
  return changes;
};

/**
 * Takes the exercise at `index` out of its superset. When it sat in the middle, the
 * exercises after it become a superset of their own, and one left alone is in none.
 */
export const leaveSuperset = (
  exercises: ReadonlyArray<Grouped>,
  index: number,
): ReadonlyArray<SupersetChange> => {
  const places = supersetPlaces(exercises);
  if (places[index] === null || places[index] === undefined) return [];
  const changes: Array<SupersetChange> = [{ index, supersetGroup: null }];
  const before = index > 0 && sameRun(exercises, index, index - 1);
  if (before && !sameRun(exercises, index - 1, index - 2)) {
    changes.push({ index: index - 1, supersetGroup: null });
  }
  let end = index;
  while (sameRun(exercises, end, end + 1)) end += 1;
  if (end === index + 1) {
    changes.push({ index: index + 1, supersetGroup: null });
  } else if (end > index + 1 && before) {
    const group = nextGroup(exercises);
    for (let at = index + 1; at <= end; at += 1) changes.push({ index: at, supersetGroup: group });
  }
  return changes;
};

/** What the logger says beside a superset, such as "Superset A". */
export const supersetLabel = (place: SupersetPlace): string => `Superset ${place.letter}`;
