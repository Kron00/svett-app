import { type Exercise, ExerciseId, ExerciseRepository } from "@svett/core";
import { Effect, Option, Schema } from "effect";
import { useCallback } from "react";

import { appDatabase } from "../data/database";
import { type Loaded, useOnFocus } from "../data/loaded";

/** Runs one call on the exercise repository of the database this launch opened. */
export const withExercises = <A, E>(
  body: (exercises: typeof ExerciseRepository.Service) => Effect.Effect<A, E>,
): Promise<A> => appDatabase().runPromise(Effect.flatMap(Effect.service(ExerciseRepository), body));

const listAll = () => withExercises((exercises) => exercises.list);

/** Every exercise, library and custom, that is not deleted. */
export const useExerciseList = (): Loaded<ReadonlyArray<Exercise>> => useOnFocus(listAll);

/** The exercise a link or a list row names, or null when there is none. */
export function useExercise(id: string): Loaded<Exercise | null> {
  const load = useCallback(
    () =>
      Schema.is(ExerciseId)(id)
        ? withExercises((exercises) => exercises.get(id)).then(Option.getOrNull)
        : Promise.resolve(null),
    [id],
  );
  return useOnFocus(load);
}
