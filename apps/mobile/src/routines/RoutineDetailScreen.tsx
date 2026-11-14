import {
  ActivityRepository,
  type FolderId,
  moveItem,
  type RoutineId,
  startWorkoutFromRoutine,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { Effect, Option } from "effect";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import type { OpenDatabase } from "../data/current";
import { writeTo } from "../data/store";
import { useWorkoutSettings } from "../settings/store";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { OptionSheet } from "../ui/OptionSheet";
import { changeRoutines, type RoutineView, useRoutine } from "./data";
import { RoutineExercises } from "./RoutineExercises";

type Started = { readonly started: true } | { readonly started: false; readonly title: string };

/** Starts the routine in `database`, or names the workout already in progress there. */
const start = (database: OpenDatabase, id: RoutineId) =>
  writeTo(
    database,
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

const notChanged = (error: unknown) => Alert.alert("The routine was not changed", String(error));

function Details({
  database,
  view,
  reload,
}: {
  readonly database: OpenDatabase;
  readonly view: RoutineView;
  readonly reload: () => void;
}) {
  const navigation = useNavigation<RootNavigation>();
  const { routine, exercises } = view.detail;
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [starting, setStarting] = useState(false);
  const { unit } = useWorkoutSettings();
  const folder = view.folders.find((candidate) => candidate.id === routine.folderId);
  const index = view.siblings.findIndex((sibling) => sibling.id === routine.id);

  const startWorkout = () => {
    setStarting(true);
    start(database, routine.id)
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
    void changeRoutines(database, (routines) =>
      routines.orderRoutines(moveItem(view.siblings, index, to).map((sibling) => sibling.id)),
    ).then(reload, notChanged);

  const moveToFolder = (folderId: FolderId | null) =>
    void changeRoutines(database, (routines) => routines.moveRoutine(routine.id, folderId)).then(
      reload,
      notChanged,
    );

  const duplicate = () =>
    void changeRoutines(database, (routines) => routines.duplicateRoutine(routine.id)).then(
      (copy) => navigation.push("Routine", { id: copy }),
      notChanged,
    );

  const remove = () =>
    Alert.alert(`Delete ${routine.title}?`, "Workouts you logged from it stay in your history.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void changeRoutines(database, (routines) => routines.removeRoutine(routine.id)).then(
            () => navigation.goBack(),
            notChanged,
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
      <RoutineExercises
        names={view.names}
        unit={unit}
        exercises={exercises.map(({ exercise, sets }) => ({
          key: exercise.id,
          exerciseId: exercise.exerciseId,
          notes: exercise.notes,
          sets: sets.map((set) => ({ ...set, key: set.id })),
        }))}
      />
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
        <Details database={loaded.database} view={loaded.value} reload={loaded.reload} />
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
