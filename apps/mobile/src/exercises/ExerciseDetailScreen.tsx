import {
  CATEGORY_LABEL,
  EQUIPMENT_LABEL,
  type Exercise,
  exerciseSummary,
  muscleList,
  SOURCE_LABEL,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { ScrollView, View } from "react-native";

import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { useExercise } from "./data";

function Details({ exercise }: { readonly exercise: Exercise }) {
  const navigation = useNavigation<RootNavigation>();
  return (
    <>
      <View className="gap-1 px-gutter">
        <AppText variant="title1" accessibilityRole="header" testID="exercise-name">
          {exercise.name}
        </AppText>
        <AppText tone="secondary">{exerciseSummary(exercise)}</AppText>
      </View>
      <ListSection>
        <ListRow key="primary" title="Main muscles" value={muscleList(exercise.primaryMuscles)} />
        <ListRow
          key="secondary"
          title="Other muscles"
          value={
            exercise.secondaryMuscles.length === 0 ? "None" : muscleList(exercise.secondaryMuscles)
          }
        />
        <ListRow key="equipment" title="Equipment" value={EQUIPMENT_LABEL[exercise.equipment]} />
        <ListRow key="category" title="Category" value={CATEGORY_LABEL[exercise.category]} />
        <ListRow
          key="source"
          title="From"
          value={SOURCE_LABEL[exercise.source]}
          testID="exercise-source"
        />
      </ListSection>
      {exercise.source === "svett" ? (
        <View className="px-gutter">
          <Button
            label="Edit exercise"
            symbol="pencil"
            variant="secondary"
            onPress={() => navigation.navigate("EditExercise", { id: exercise.id })}
            testID="edit-exercise"
          />
        </View>
      ) : null}
    </>
  );
}

/** One exercise: its muscles, equipment, category and where it came from. */
export function ExerciseDetailScreen() {
  const { id } = useRoute<RouteProp<RootStackParamList, "Exercise">>().params;
  const loaded = useExercise(id);
  return (
    <ScrollView
      testID="exercise-detail"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 24, paddingVertical: 16 }}
    >
      {loaded.state === "ready" && loaded.value !== null ? (
        <Details exercise={loaded.value} />
      ) : null}
      {loaded.state === "ready" && loaded.value === null ? (
        <EmptyState
          symbol="questionmark.circle"
          title="Exercise not found"
          message="It may have been deleted, or the link names no exercise."
        />
      ) : null}
      {loaded.state === "failed" ? (
        <EmptyState
          symbol="exclamationmark.triangle"
          title="The exercise did not load"
          message={loaded.message}
        />
      ) : null}
    </ScrollView>
  );
}
