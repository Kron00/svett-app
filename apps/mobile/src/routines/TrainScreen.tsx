import { endPosition, type Folder, moveItem, type RoutineSection } from "@svett/core";
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { ActionSheetIOS, Alert, ScrollView, View } from "react-native";

import { ExerciseLibraryRow } from "../exercises/ExerciseLibraryRow";
import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { ListRow, ListSection, SectionHeader } from "../ui/List";
import { startEmpty } from "../workout/actions";
import { type RoutineOverview, useRoutineOverview, withRoutines } from "./data";

const folderPrompt = (title: string, name: string, onSave: (name: string) => void) =>
  Alert.prompt(
    title,
    undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Save",
        isPreferred: true,
        onPress: (text?: string) => {
          const trimmed = text?.trim() ?? "";
          if (trimmed !== "") onSave(trimmed);
        },
      },
    ],
    "plain-text",
    name,
  );

function FolderHeader({
  folder,
  folders,
  routineCount,
  onChanged,
}: {
  readonly folder: Folder;
  readonly folders: ReadonlyArray<Folder>;
  readonly routineCount: number;
  readonly onChanged: () => void;
}) {
  const navigation = useNavigation<RootNavigation>();
  const index = folders.findIndex((other) => other.id === folder.id);
  const move = (to: number) =>
    void withRoutines((routines) =>
      routines.orderFolders(moveItem(folders, index, to).map((other) => other.id)),
    ).then(onChanged);

  const actions: ReadonlyArray<{ readonly label: string; readonly run: () => void }> = [
    {
      label: "New routine in this folder",
      run: () => navigation.navigate("NewRoutine", { folder: folder.id }),
    },
    {
      label: "Rename folder",
      run: () =>
        folderPrompt(
          "Rename folder",
          folder.name,
          (name) =>
            void withRoutines((routines) => routines.updateFolder(folder.id, { name })).then(
              onChanged,
            ),
        ),
    },
    ...(index > 0 ? [{ label: "Move folder up", run: () => move(index - 1) }] : []),
    ...(index < folders.length - 1
      ? [{ label: "Move folder down", run: () => move(index + 1) }]
      : []),
  ];

  const remove = () =>
    Alert.alert(
      `Delete ${folder.name}?`,
      routineCount === 0
        ? "The folder is empty."
        : `Its ${routineCount === 1 ? "routine is" : `${routineCount} routines are`} deleted with it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void withRoutines((routines) => routines.removeFolder(folder.id)).then(onChanged),
        },
      ],
    );

  const openActions = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: folder.name,
        options: [...actions.map((action) => action.label), "Delete folder", "Cancel"],
        destructiveButtonIndex: actions.length,
        cancelButtonIndex: actions.length + 1,
      },
      (chosen) => {
        if (chosen < actions.length) actions[chosen]?.run();
        if (chosen === actions.length) remove();
      },
    );

  return (
    <View className="flex-row items-center gap-2 pl-8 pr-gutter">
      <AppText
        variant="headline"
        tone="secondary"
        accessibilityRole="header"
        className="flex-1"
        testID="folder-name"
      >
        {folder.name}
      </AppText>
      <IconButton
        symbol="ellipsis.circle"
        label={`${folder.name} folder options`}
        variant="plain"
        onPress={openActions}
        testID="folder-options"
      />
    </View>
  );
}

function Section({
  section,
  overview,
  onChanged,
}: {
  readonly section: RoutineSection;
  readonly overview: RoutineOverview;
  readonly onChanged: () => void;
}) {
  const navigation = useNavigation<RootNavigation>();
  const rows: ReactNode =
    section.routines.length === 0 ? (
      <ListRow key="empty" title="No routines in this folder" />
    ) : (
      section.routines.map((routine) => (
        <ListRow
          key={routine.id}
          title={routine.title}
          subtitle={overview.summaries.get(routine.id)}
          trailing={{
            type: "chevron",
            onPress: () => navigation.navigate("Routine", { id: routine.id }),
          }}
          testID="routine-row"
        />
      ))
    );
  return (
    <View className="gap-2">
      {section.folder !== null ? (
        <FolderHeader
          folder={section.folder}
          folders={overview.folders}
          routineCount={section.routines.length}
          onChanged={onChanged}
        />
      ) : overview.folders.length > 0 ? (
        <AppText variant="headline" tone="secondary" accessibilityRole="header" className="px-8">
          Not in a folder
        </AppText>
      ) : null}
      <ListSection>{rows}</ListSection>
    </View>
  );
}

function Routines({
  overview,
  onChanged,
}: {
  readonly overview: RoutineOverview;
  readonly onChanged: () => void;
}) {
  const navigation = useNavigation<RootNavigation>();
  const empty = overview.sections.every((section) => section.routines.length === 0);
  return (
    <View className="gap-6" testID="routine-list">
      {empty && overview.folders.length === 0 ? (
        <EmptyState
          symbol="list.bullet.clipboard"
          title="No routines yet"
          message="A routine is a workout you plan once and start whenever you like."
          action={{ label: "New routine", onPress: () => navigation.navigate("NewRoutine") }}
        />
      ) : (
        overview.sections.map((section) => (
          <Section
            key={section.folder?.id ?? "loose"}
            section={section}
            overview={overview}
            onChanged={onChanged}
          />
        ))
      )}
    </View>
  );
}

/**
 * The Train tab: the workout in progress, routines by folder, and the exercise library.
 */
export function TrainScreen() {
  const navigation = useNavigation<RootNavigation>();
  const loaded = useRoutineOverview();
  const newFolder = () =>
    folderPrompt("New folder", "", (name) => {
      if (loaded.state !== "ready") return;
      void withRoutines((routines) =>
        routines.createFolder({ name, position: endPosition(loaded.value.folders) }),
      ).then(loaded.reload);
    });

  return (
    <ScrollView
      testID="train"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 24, paddingVertical: 16 }}
    >
      {loaded.state === "ready" && loaded.value.inProgress !== null ? (
        <ListSection header="Workout in progress">
          <ListRow
            key="workout"
            title={loaded.value.inProgress.title}
            subtitle="Not finished yet"
            icon={{ symbol: "dumbbell.fill", color: "sport-strength" }}
            trailing={{ type: "chevron", onPress: () => navigation.navigate("ActiveWorkout") }}
            testID="workout-in-progress-row"
          />
        </ListSection>
      ) : null}
      {loaded.state === "ready" && loaded.value.inProgress === null ? (
        <View className="px-gutter">
          <Button
            label="Start empty workout"
            symbol="plus"
            onPress={() =>
              void startEmpty().then((started) => {
                if (started !== null) navigation.navigate("ActiveWorkout");
              })
            }
            testID="start-empty-workout"
          />
        </View>
      ) : null}
      <View className="gap-3">
        <SectionHeader title="Routines" action={{ label: "New folder", onPress: newFolder }} />
        <View className="px-gutter">
          <Button
            label="New routine"
            symbol="plus"
            variant="secondary"
            onPress={() => navigation.navigate("NewRoutine")}
            testID="new-routine"
          />
        </View>
      </View>
      {loaded.state === "ready" ? (
        <Routines overview={loaded.value} onChanged={loaded.reload} />
      ) : null}
      {loaded.state === "failed" ? (
        <EmptyState
          symbol="exclamationmark.triangle"
          title="The routines did not load"
          message={loaded.message}
        />
      ) : null}
      <ListSection header="Library">
        <ExerciseLibraryRow key="exercises" />
      </ListSection>
    </ScrollView>
  );
}
