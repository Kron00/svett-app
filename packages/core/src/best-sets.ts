import { isLiftedSet, isWorkingSet } from "./performed-set.ts";
import type { LoggedSet } from "./repositories/training.ts";

const byTime = (a: LoggedSet, b: LoggedSet) => a.startedAt - b.startedAt || a.position - b.position;

/**
 * The best working sets, best first. Warm-ups never count. Among sets of at least one rep with a
 * weight, the rule the heaviest weight record keeps, a heavier set beats a lighter one, then more
 * reps win, then the earlier set. When no set is like that, as for pull-ups or planks, weight
 * plays no part: the most reps win, then the longest time, and a set with neither, such as a
 * failed attempt of 0 reps, is never a best set.
 */
export function rankBestSets(
  sets: ReadonlyArray<LoggedSet>,
  limit: number,
): ReadonlyArray<LoggedSet> {
  const working = sets.filter(isWorkingSet);
  const lifted = working.filter(isLiftedSet);
  const ranked =
    lifted.length > 0
      ? [...lifted].sort(
          (a, b) =>
            (b.weightKg ?? 0) - (a.weightKg ?? 0) || (b.reps ?? 0) - (a.reps ?? 0) || byTime(a, b),
        )
      : working
          .filter((set) => (set.reps ?? 0) >= 1 || (set.durationS ?? 0) > 0)
          .sort(
            (a, b) =>
              (b.reps ?? 0) - (a.reps ?? 0) ||
              (b.durationS ?? 0) - (a.durationS ?? 0) ||
              byTime(a, b),
          );
  return ranked.slice(0, limit);
}

export interface ExerciseSession {
  readonly activityId: LoggedSet["activityId"];
  readonly title: string;
  readonly startedAt: number;
  /** Sets other than warm-ups. */
  readonly workingSets: number;
  /** The best working set of the session, by the rule of `rankBestSets`. */
  readonly topSet: LoggedSet | null;
  readonly totalReps: number;
  /** Weight times reps, summed over the working sets. */
  readonly volumeKg: number;
}

/** One entry per workout the sets come from, newest first. */
export function exerciseSessions(sets: ReadonlyArray<LoggedSet>): ReadonlyArray<ExerciseSession> {
  const byWorkout = new Map<string, Array<LoggedSet>>();
  for (const set of sets) {
    const list = byWorkout.get(set.activityId);
    if (list === undefined) byWorkout.set(set.activityId, [set]);
    else list.push(set);
  }
  const sessions = [...byWorkout.values()].map((group): ExerciseSession => {
    const first = group[0]!;
    const working = group.filter(isWorkingSet);
    return {
      activityId: first.activityId,
      title: first.title,
      startedAt: first.startedAt,
      workingSets: working.length,
      topSet: rankBestSets(working, 1)[0] ?? null,
      totalReps: working.reduce((total, set) => total + (set.reps ?? 0), 0),
      volumeKg: working.reduce((total, set) => total + (set.weightKg ?? 0) * (set.reps ?? 0), 0),
    };
  });
  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}
