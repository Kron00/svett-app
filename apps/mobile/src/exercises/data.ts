import { type Exercise, ExerciseId, ExerciseRepository } from "@svett/core";
import { useFocusEffect } from "@react-navigation/native";
import { Effect, Option, Schema } from "effect";
import { useCallback, useState } from "react";

import { appDatabase } from "../data/current";

export type Loaded<A> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly value: A }
  | { readonly state: "failed"; readonly message: string };

/** Runs one call on the exercise repository of the database this launch opened. */
export const withExercises = <A, E>(
  body: (exercises: typeof ExerciseRepository.Service) => Effect.Effect<A, E>,
): Promise<A> => appDatabase().runPromise(Effect.flatMap(Effect.service(ExerciseRepository), body));

/** Loads on focus, so a screen shows what another screen saved before it came back. */
function useOnFocus<A>(load: () => Promise<A>): Loaded<A> {
  const [loaded, setLoaded] = useState<Loaded<A>>({ state: "loading" });
  useFocusEffect(
    useCallback(() => {
      let current = true;
      load().then(
        (value) => current && setLoaded({ state: "ready", value }),
        (error: unknown) => current && setLoaded({ state: "failed", message: String(error) }),
      );
      return () => {
        current = false;
      };
    }, [load]),
  );
  return loaded;
}

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
