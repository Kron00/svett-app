import { ActivityRepository } from "@svett/core";
import { Effect } from "effect";
import { useEffect, useState } from "react";

import { AppText } from "../ui/AppText";
import { appDatabase } from "./database";

/** Proof that the data layer runs in the app. P1 replaces it with the history screen. */
export function WorkoutCounts() {
  const [text, setText] = useState("Opening the database");
  useEffect(() => {
    appDatabase()
      .runPromise(Effect.flatMap(Effect.service(ActivityRepository), (repo) => repo.counts))
      .then(
        ({ activities, sets }) => setText(`${activities} workouts, ${sets} sets`),
        (error: unknown) => setText(`The database did not open. ${String(error)}`),
      );
  }, []);
  return (
    <AppText testID="workout-counts" tone="secondary" className="text-center">
      {text}
    </AppText>
  );
}
