import { ActivityRepository, plannedSetText, setBadges } from "@svett/core";
import { useNavigation } from "@react-navigation/native";
import { Effect } from "effect";
import { Alert, ScrollView, View } from "react-native";

import type { RootNavigation } from "../navigation";
import { runOnDatabase, useWorkoutInProgress, type WorkoutView } from "../routines/data";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";

function Workout({ workout }: { readonly workout: WorkoutView }) {
  const navigation = useNavigation<RootNavigation>();
  const discard = () =>
    Alert.alert("Discard this workout?", "Nothing from it is saved to your history.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () =>
          void runOnDatabase(
            Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
              activities.remove(workout.activity.id),
            ),
          ).then(() => navigation.goBack()),
      },
    ]);

  return (
    <>
      <View className="gap-1 px-gutter">
        <AppText variant="title1" accessibilityRole="header" testID="workout-title">
          {workout.activity.title}
        </AppText>
        <AppText tone="secondary">In progress</AppText>
      </View>
      {workout.exercises.map((exercise, exerciseIndex) => {
        const badges = setBadges(exercise.sets.map((set) => set.setType));
        return (
          <ListSection
            key={exercise.id}
            header={exercise.name}
            footer={exercise.notes === "" ? undefined : exercise.notes}
          >
            {exercise.sets.map((set, setIndex) => {
              const text = plannedSetText(set);
              const badge = badges[setIndex]!;
              const status = set.done ? "Done" : "To do";
              return (
                <ListRow
                  key={set.id}
                  title={badge.label}
                  subtitle={text.text}
                  value={status}
                  accessibilityLabel={`${badge.label}, ${text.label}, ${status}`}
                  testID={`workout-set-${exerciseIndex}-${setIndex}`}
                />
              );
            })}
          </ListSection>
        );
      })}
      <View className="px-gutter">
        <Button
          label="Discard workout"
          symbol="trash"
          variant="destructive"
          onPress={discard}
          testID="discard-workout"
        />
      </View>
    </>
  );
}

/** The workout in progress: its exercises and the sets still to do, filled in from the routine. */
export function WorkoutScreen() {
  const loaded = useWorkoutInProgress();
  return (
    <ScrollView
      testID="workout"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 24, paddingVertical: 16 }}
    >
      {loaded.state === "ready" && loaded.value !== null ? (
        <Workout workout={loaded.value} />
      ) : null}
      {loaded.state === "ready" && loaded.value === null ? (
        <EmptyState
          symbol="dumbbell"
          title="No workout in progress"
          message="Start a routine from the Train tab."
        />
      ) : null}
      {loaded.state === "failed" ? (
        <EmptyState
          symbol="exclamationmark.triangle"
          title="The workout did not load"
          message={loaded.message}
        />
      ) : null}
    </ScrollView>
  );
}
