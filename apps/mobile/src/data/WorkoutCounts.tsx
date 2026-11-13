import { ActivityRepository } from "@svett/core";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import { Text } from "react-native";

import { launchTarget, openDatabase } from "./database";

let database: ReturnType<typeof openDatabase> | undefined;

/** Proof that the data layer runs in the app. P1 replaces it with the history screen. */
export function WorkoutCounts() {
  const [text, setText] = useState("Opening the database");
  useEffect(() => {
    database ??= openDatabase(launchTarget());
    database
      .runPromise(Effect.flatMap(Effect.service(ActivityRepository), (repo) => repo.counts))
      .then(
        ({ activities, sets }) => setText(`${activities} workouts, ${sets} sets`),
        (error: unknown) => setText(`The database did not open. ${String(error)}`),
      );
  }, []);
  return (
    <Text
      testID="workout-counts"
      className="text-center text-base text-neutral-500 dark:text-neutral-400"
    >
      {text}
    </Text>
  );
}
