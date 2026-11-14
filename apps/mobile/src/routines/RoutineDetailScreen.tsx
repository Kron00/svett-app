import {
  ActivityRepository,
  type FolderId,
  moveItem,
  type RoutineId,
  setBadges,
  setTargetText,
  startWorkoutFromRoutine,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { Effect, Option } from "effect";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import { write } from "../data/store";
import { useWorkoutSettings } from "../settings/store";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { OptionSheet } from "../ui/OptionSheet";
import { changeRoutines, exerciseName, type RoutineView, useRoutine } from "./data";

type Started = { readonly started: true } | { readonly started: false; readonly title: string };

/** Starts the routine, or names the workout already in progress. */
const start = (id: RoutineId) =>
  write(
    startWorkoutFromRoutine(id).pipe(
      Effect.as<Started>({ started: true }),
      Effect.catchTag("WorkoutInProgressError", ({ activityId }) =>
        Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
          Effect.map(activities.get(activityId), (detail) => ({
            started: false as const,
            title: Option.match(detail, {
              onNone: () => "A workout",
              onSome: ({ activity }) => activity.title,
            }),
          })),
        ),
      ),
    ),
  );

function Details({ view, reload }: { readonly view: RoutineView; readonly reload: () => void }) {
  const navigation = useNavigation<RootNavigation>();
  const { routine, exercises } = view.detail;
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [starting, setStarting] = useState(false);
  const { unit } = useWorkoutSettings();
  const folder = view.folders.find((candidate) => candidate.id === routine.folderId);
  const index = view.siblings.findIndex((sibling) => sibling.id === routine.id);

  const startWorkout = () => {
    setStarting(true);
    start(routine.id)
      .then((result) => {
        if (result.started) {
          navigation.navigate("ActiveWorkout");
          return;
        }
        Alert.alert(
          "A workout is in progress",
          `Finish or discard ${result.title} before you start another.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Show workout", onPress: () => navigation.navigate("ActiveWorkout") },
          ],
        );
      })
      .catch((error: unknown) => Alert.alert("The workout did not start", String(error)))
      .finally(() => setStarting(false));
  };

  const move = (to: number) =>
    void changeRoutines((routines) =>
      routines.orderRoutines(moveItem(view.siblings, index, to).map((sibling) => sibling.id)),
    ).then(reload);

  const moveToFolder = (folderId: FolderId | null) =>
    void changeRoutines((routines) => routines.moveRoutine(routine.id, folderId)).then(reload);

  const duplicate = () =>
    void changeRoutines((routines) => routines.duplicateRoutine(routine.id)).then((copy) =>
      navigation.push("Routine", { id: copy }),
    );

  const remove = () =>
    Alert.alert(`Delete ${routine.title}?`, "Workouts you logged from it stay in your history.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void changeRoutines((routines) => routines.removeRoutine(routine.id)).then(() =>
            navigation.goBack(),
          ),
      },
    ]);

  return (
    <>
      <View className="gap-1 px-gutter">
        <AppText variant="title1" accessibilityRole="header" testID="routine-title">
          {routine.title}
        </AppText>
        {routine.notes !== "" ? <AppText tone="secondary">{routine.notes}</AppText> : null}
      </View>
      <View className="px-gutter">
        <Button
          label="Start workout"
          symbol="play.fill"
          onPress={startWorkout}
          disabled={starting}
          testID="start-routine"
        />
      </View>
      {exercises.map(({ exercise, sets }, exerciseIndex) => {
        const badges = setBadges(sets.map((set) => set.setType));
        return (
          <ListSection
            key={exercise.id}
            header={exerciseName(view.names, exercise.exerciseId)}
            footer={exercise.notes === "" ? undefined : exercise.notes}
          >
            {sets.length === 0 ? (
              <ListRow key="none" title="No sets" />
            ) : (
              sets.map((set, setIndex) => {
                const target = setTargetText(set, unit);
                const badge = badges[setIndex]!;
                return (
                  <ListRow
                    key={set.id}
                    title={badge.label}
                    value={target.text}
                    accessibilityLabel={`${badge.label}, ${target.label}`}
                    testID={`routine-set-${exerciseIndex}-${setIndex}`}
                  />
                );
              })
            )}
          </ListSection>
        );
      })}
      <ListSection header="Routine">
        <ListRow
          key="edit"
          title="Edit routine"
          trailing={{
            type: "chevron",
            onPress: () => navigation.navigate("EditRoutine", { id: routine.id }),
          }}
          testID="edit-routine"
        />
        <ListRow
          key="duplicate"
          title="Duplicate routine"
          trailing={{ type: "chevron", onPress: duplicate }}
          testID="duplicate-routine"
        />
        <ListRow
          key="folder"
          title="Folder"
          value={folder?.name ?? "None"}
          trailing={{ type: "chevron", onPress: () => setChoosingFolder(true) }}
          testID="routine-folder"
        />
        {index > 0 ? (
          <ListRow
            key="up"
            title="Move up"
            trailing={{ type: "chevron", onPress: () => move(index - 1) }}
            testID="move-routine-up"
          />
        ) : null}
        {index >= 0 && index < view.siblings.length - 1 ? (
          <ListRow
            key="down"
            title="Move down"
            trailing={{ type: "chevron", onPress: () => move(index + 1) }}
            testID="move-routine-down"
          />
        ) : null}
      </ListSection>
      <View className="px-gutter">
        <Button
          label="Delete routine"
          symbol="trash"
          variant="destructive"
          onPress={remove}
          testID="delete-routine"
        />
      </View>
      <OptionSheet
        title="Folder"
        mode="single"
        noneLabel="No folder"
        options={view.folders.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
        selected={routine.folderId}
        onSelect={moveToFolder}
        isPresented={choosingFolder}
        onDismiss={() => setChoosingFolder(false)}
        testID="folder-options-sheet"
      />
    </>
  );
}

/** One routine: its exercises and targets, Start workout, and what can be done to it. */
export function RoutineDetailScreen() {
  const { id } = useRoute<RouteProp<RootStackParamList, "Routine">>().params;
  const loaded = useRoutine(id);
  return (
    <ScrollView
      testID="routine-detail"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 24, paddingVertical: 16 }}
    >
      {loaded.state === "ready" && loaded.value !== null ? (
        <Details view={loaded.value} reload={loaded.reload} />
      ) : null}
      {loaded.state === "ready" && loaded.value === null ? (
        <EmptyState
          symbol="questionmark.circle"
          title="Routine not found"
          message="It may have been deleted, or the link names no routine."
        />
      ) : null}
      {loaded.state === "failed" ? (
        <EmptyState
          symbol="exclamationmark.triangle"
          title="The routine did not load"
          message={loaded.message}
        />
      ) : null}
    </ScrollView>
  );
}
