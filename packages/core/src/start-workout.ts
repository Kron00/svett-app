import { Effect, Option } from "effect";

import { ActivityRepository } from "./repositories/activities.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import { workoutFromRoutine } from "./routine-plan.ts";
import type { RoutineId } from "./schema.ts";
import { RowNotFoundError } from "./table.ts";

/**
 * Starts a workout from a routine: its exercises in order, each set still to do and filled
 * in from the routine's target. Fails with WorkoutInProgressError while another workout is
 * in progress.
 */
export const startWorkoutFromRoutine = (id: RoutineId) =>
  Effect.gen(function* () {
    const routines = yield* RoutineRepository;
    const activities = yield* ActivityRepository;
    const detail = yield* routines.getRoutine(id);
    if (Option.isNone(detail)) return yield* new RowNotFoundError({ table: "routine", id });
    return yield* activities.startWorkout(workoutFromRoutine(detail.value));
  });
