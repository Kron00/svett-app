import { type Exercise, ExerciseId, ExerciseRepository } from "@svett/core";
import { Effect, Option, Schema } from "effect";
import { useCallback } from "react";

import type { OpenDatabase } from "../data/current";
import { type Loaded, useOnFocus } from "../data/loaded";
import { readFrom, writeTo } from "../data/store";

/** Runs one call on the exercise repository of `database`. */
export const withExercises = <A, E>(
  database: OpenDatabase,
  body: (exercises: typeof ExerciseRepository.Service) => Effect.Effect<A, E>,
): Promise<A> => readFrom(database, Effect.flatMap(Effect.service(ExerciseRepository), body));

/**
 * Saves through the exercise repository of `database`, the one the screen opened in. It refuses
 * once someone signed in or out, so a form never saves into another owner's exercises.
 */
export const changeExercises = <A, E>(
  database: OpenDatabase,
  body: (exercises: typeof ExerciseRepository.Service) => Effect.Effect<A, E>,
): Promise<A> => writeTo(database, Effect.flatMap(Effect.service(ExerciseRepository), body));

const listAll = (database: OpenDatabase) => withExercises(database, (exercises) => exercises.list);

/** Every exercise, library and custom, that is not deleted. */
export const useExerciseList = (): Loaded<ReadonlyArray<Exercise>> => useOnFocus(listAll);

/** The exercise a link or a list row names, or null when there is none. */
export function useExercise(id: string): Loaded<Exercise | null> {
  const load = useCallback(
    (database: OpenDatabase) =>
      Schema.is(ExerciseId)(id)
        ? withExercises(database, (exercises) => exercises.get(id)).then(Option.getOrNull)
        : Promise.resolve(null),
    [id],
  );
  return useOnFocus(load);
}
