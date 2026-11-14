import { useFocusEffect } from "@react-navigation/native";
import { ActivityRepository } from "@svett/core";
import { Effect } from "effect";
import { useCallback, useState } from "react";

import { AppText } from "../ui/AppText";
import { appDatabase } from "./database";

/** Proof that the data layer runs in the app. P1 replaces it with the history screen. */
export function WorkoutCounts() {
  const [text, setText] = useState("Opening the database");
  // Counted again each time the tab shows, so an import or undo shows at once.
  useFocusEffect(
    useCallback(() => {
      let current = true;
      appDatabase()
        .runPromise(Effect.flatMap(Effect.service(ActivityRepository), (repo) => repo.counts))
        .then(
          ({ activities, sets }) => current && setText(`${activities} workouts, ${sets} sets`),
          (error: unknown) => current && setText(`The database did not open. ${String(error)}`),
        );
      return () => {
        current = false;
      };
    }, []),
  );
  return (
    <AppText testID="workout-counts" tone="secondary" className="text-center">
      {text}
    </AppText>
  );
}
