import { formatDay } from "@svett/core";
import { useNavigation } from "@react-navigation/native";
import { ScrollView } from "react-native";

import { useQuery } from "../data/useQuery";
import type { RootNavigation } from "../navigation";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { performedExercises } from "./queries";
import { QueryView } from "./QueryView";

/** Every exercise with logged sets, most recently done first. Each opens its charts. */
export function ExercisesScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { state } = useQuery(performedExercises);
  return (
    <QueryView state={state}>
      {(exercises) => (
        <ScrollView
          testID="progress-exercises"
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-background"
          contentContainerStyle={{ paddingVertical: 16 }}
        >
          {exercises.length === 0 ? (
            <EmptyState
              symbol="chart.xyaxis.line"
              title="No exercises yet"
              message="Exercises from your finished workouts show here, each with its charts."
            />
          ) : (
            <ListSection>
              {exercises.map(({ exercise, workouts, lastPerformedAt }) => (
                <ListRow
                  key={exercise.id}
                  title={exercise.name}
                  subtitle={`${workouts} ${workouts === 1 ? "workout" : "workouts"}, last on ${formatDay(lastPerformedAt)}`}
                  testID={`exercise-row-${exercise.id}`}
                  trailing={{
                    type: "chevron",
                    onPress: () =>
                      navigation.navigate("ExerciseProgress", { exerciseId: exercise.id }),
                  }}
                />
              ))}
            </ListSection>
          )}
        </ScrollView>
      )}
    </QueryView>
  );
}
