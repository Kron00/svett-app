import type { LoggedSet } from "./repositories/training.ts";

/**
 * The best working sets, best first. Warm-ups never count. A heavier set beats a lighter one,
 * then more reps win, then the earlier set. When no set has a weight, as for pull-ups, the
 * most reps win, then the longest time.
 */
export function rankBestSets(
  sets: ReadonlyArray<LoggedSet>,
  limit: number,
): ReadonlyArray<LoggedSet> {
  const working = sets.filter((set) => set.setType !== "warm_up");
  const weighted = working.filter((set) => set.weightKg !== null && set.weightKg > 0);
  const pool = weighted.length > 0 ? weighted : working;
  const ranked = [...pool].sort(
    (a, b) =>
      (b.weightKg ?? 0) - (a.weightKg ?? 0) ||
      (b.reps ?? 0) - (a.reps ?? 0) ||
      (b.durationS ?? 0) - (a.durationS ?? 0) ||
      a.startedAt - b.startedAt ||
      a.position - b.position,
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
    const working = group.filter((set) => set.setType !== "warm_up");
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
