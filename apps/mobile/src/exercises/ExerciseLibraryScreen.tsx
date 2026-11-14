import {
  ActivityExerciseId,
  addExercises,
  EQUIPMENT_LABEL,
  EQUIPMENT_OPTIONS,
  type Exercise,
  exerciseFilterFromParams,
  exerciseFilterParams,
  exerciseSummary,
  linkParam,
  linkParams,
  MUSCLE_LABEL,
  MUSCLE_OPTIONS,
  searchExercises,
} from "@svett/core";
import { LegendList } from "@legendapp/list/react-native";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { useDeferredValue, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useColor } from "../design/hooks";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/Icon";
import { ListRow } from "../ui/List";
import { OptionSheet } from "../ui/OptionSheet";
import { SearchField } from "../ui/SearchField";
import { changeDraft, currentDraft } from "../routines/draft";
import { addExercises as addWorkoutExercises, replaceExercise } from "../workout/actions";
import { currentWorkout } from "../workout/store";
import { useExerciseList } from "./data";

function Separator() {
  return (
    <View
      className="ml-gutter"
      style={{ height: StyleSheet.hairlineWidth, backgroundColor: useColor("separator") }}
    />
  );
}

/** The header button that opens an empty new exercise form. */
export function NewExerciseButton({ onPress }: { readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New exercise"
      onPress={onPress}
      testID="new-exercise"
      className="min-h-target min-w-target items-center justify-center"
    >
      <Icon name="plus" color="accent" size={20} weight="semibold" />
    </Pressable>
  );
}

const NONE: ReadonlyArray<Exercise> = [];

const countText = (count: number) => `${count} ${count === 1 ? "exercise" : "exercises"}`;

/**
 * The exercise library: search, filters by muscle and equipment, and every custom
 * exercise. The search text and filters are route params, so a link such as
 * svett://exercises?q=bench&muscle=chest opens it already filtered.
 */
export function ExerciseLibraryScreen() {
  const navigation = useNavigation<RootNavigation>();
  const route =
    useRoute<
      RouteProp<
        RootStackParamList,
        "Exercises" | "PickExercise" | "AddWorkoutExercise" | "ReplaceWorkoutExercise"
      >
    >();
  const filter = exerciseFilterFromParams(route.params);
  // Opened from the routine editor or the workout, a row adds its exercise there and goes back.
  const choose = (exercise: Exercise) => {
    const params = linkParams(route.params);
    const replacing = linkParam(ActivityExerciseId, params["exercise"]);
    if (route.name === "PickExercise" && currentDraft() !== null) {
      changeDraft((form) => addExercises(form, [exercise.id]));
      navigation.goBack();
    } else if (route.name === "AddWorkoutExercise" && currentWorkout() !== null) {
      addWorkoutExercises([exercise.id]);
      navigation.goBack();
    } else if (
      route.name === "ReplaceWorkoutExercise" &&
      replacing !== null &&
      currentWorkout() !== null
    ) {
      replaceExercise(replacing, exercise.id);
      navigation.goBack();
    } else {
      navigation.navigate("Exercise", { id: exercise.id });
    }
  };
  const loaded = useExerciseList();
  const [picker, setPicker] = useState<"muscle" | "equipment" | null>(null);

  // The field keeps its own text so typing never waits on a navigation round trip.
  // A link that brings new text replaces it.
  const [text, setText] = useState(filter.text);
  const [linkedText, setLinkedText] = useState(filter.text);
  if (filter.text !== linkedText) {
    setLinkedText(filter.text);
    setText(filter.text);
  }
  const deferredText = useDeferredValue(text);
  const setFilter = (change: Partial<typeof filter>) =>
    navigation.setParams(exerciseFilterParams({ ...filter, text, ...change }));

  const exercises = loaded.state === "ready" ? loaded.value : NONE;
  const { muscle, equipment } = filter;
  const results = useMemo(
    () => searchExercises(exercises, { text: deferredText, muscle, equipment }),
    [exercises, muscle, equipment, deferredText],
  );

  const newExercise = () =>
    navigation.navigate("NewExercise", {
      name: text.trim() === "" ? undefined : text.trim(),
      muscle: filter.muscle ?? undefined,
      equipment: filter.equipment ?? undefined,
    });

  const filtered = filter.muscle !== null || filter.equipment !== null;
  const header = (
    <View className="gap-3 px-gutter pt-2 pb-3">
      <SearchField
        label="Search exercises"
        placeholder="Search exercises"
        value={text}
        onChangeText={(next) => {
          setText(next);
          setFilter({ text: next });
        }}
        testID="exercise-search"
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={filter.muscle === null ? "All muscles" : MUSCLE_LABEL[filter.muscle]}
          accessibilityHint="Filters the exercises by their main muscle"
          symbol="figure.strengthtraining.traditional"
          variant="secondary"
          onPress={() => setPicker("muscle")}
          testID="muscle-filter"
        />
        <Button
          label={filter.equipment === null ? "All equipment" : EQUIPMENT_LABEL[filter.equipment]}
          accessibilityHint="Filters the exercises by their equipment"
          symbol="dumbbell"
          variant="secondary"
          onPress={() => setPicker("equipment")}
          testID="equipment-filter"
        />
        {filtered ? (
          <Button
            label="Clear filters"
            variant="plain"
            onPress={() => setFilter({ muscle: null, equipment: null })}
          />
        ) : null}
      </View>
      {loaded.state === "ready" ? (
        <AppText variant="footnote" tone="secondary" testID="exercise-count">
          {countText(results.length)}
        </AppText>
      ) : null}
    </View>
  );

  const empty =
    loaded.state === "loading" ? null : loaded.state === "failed" ? (
      <EmptyState
        symbol="exclamationmark.triangle"
        title="The exercises did not load"
        message={loaded.message}
      />
    ) : (
      <EmptyState
        symbol="magnifyingglass"
        title="No exercises found"
        message={
          text.trim() === ""
            ? "No exercise matches these filters."
            : `Nothing in the library matches "${text.trim()}".`
        }
        action={{
          label: text.trim() === "" ? "New exercise" : `Create "${text.trim()}"`,
          onPress: newExercise,
        }}
      />
    );

  return (
    <View testID="exercise-library" className="flex-1 bg-background">
      <LegendList
        data={results}
        keyExtractor={(exercise) => exercise.id}
        estimatedItemSize={64}
        recycleItems
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ItemSeparatorComponent={Separator}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        renderItem={({ item, index }) => (
          <ListRow
            title={item.name}
            subtitle={exerciseSummary(item)}
            value={item.source === "svett" ? "Custom" : undefined}
            trailing={{ type: "chevron", onPress: () => choose(item) }}
            testID={`exercise-result-${index}`}
          />
        )}
      />
      <OptionSheet
        title="Muscle"
        mode="single"
        noneLabel="All muscles"
        options={MUSCLE_OPTIONS}
        selected={filter.muscle}
        onSelect={(chosen) => setFilter({ muscle: chosen })}
        isPresented={picker === "muscle"}
        onDismiss={() => setPicker(null)}
        testID="muscle-options"
      />
      <OptionSheet
        title="Equipment"
        mode="single"
        noneLabel="All equipment"
        options={EQUIPMENT_OPTIONS}
        selected={filter.equipment}
        onSelect={(chosen) => setFilter({ equipment: chosen })}
        isPresented={picker === "equipment"}
        onDismiss={() => setPicker(null)}
        testID="equipment-options"
      />
    </View>
  );
}
