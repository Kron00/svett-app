import {
  addSet,
  moveExercise,
  removeExercise,
  ROUTINE_TITLE_MAX_LENGTH,
  type RoutineFormExercise,
  type ExerciseId,
  type RoutineId,
  routineForm,
  routineFormFromParams,
  routineFromForm,
  setBadges,
  setTargetText,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { currentDatabase } from "../data/current";
import { useOnFocus } from "../data/loaded";
import { useIsAccessibilityTextSize } from "../design/hooks";
import { useExerciseList } from "../exercises/data";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { ListRow, ListSection } from "../ui/List";
import { OptionSheet } from "../ui/OptionSheet";
import { TextField } from "../ui/TextField";
import { exerciseName, readRoutines, saveRoutine, useRoutine } from "./data";
import { changeDraft, closeDraft, openDraft, type RoutineDraft, useDraft } from "./draft";

function ExerciseCard({
  exercise,
  index,
  count,
  name,
}: {
  readonly exercise: RoutineFormExercise;
  readonly index: number;
  readonly count: number;
  readonly name: string;
}) {
  const navigation = useNavigation<RootNavigation>();
  const badges = setBadges(exercise.sets.map((set) => set.setType));
  const stacked = useIsAccessibilityTextSize();
  return (
    <View className="gap-2" testID={`routine-exercise-${index}`}>
      <View className={`gap-2 px-gutter ${stacked ? "" : "flex-row items-center"}`}>
        <AppText
          variant="headline"
          accessibilityRole="header"
          className={stacked ? "" : "min-w-0 flex-1"}
        >
          {name}
        </AppText>
        <View className="flex-row gap-2">
          <IconButton
            symbol="arrow.up"
            label={`Move ${name} up`}
            disabled={index === 0}
            onPress={() => changeDraft((form) => moveExercise(form, index, index - 1))}
          />
          <IconButton
            symbol="arrow.down"
            label={`Move ${name} down`}
            disabled={index === count - 1}
            onPress={() => changeDraft((form) => moveExercise(form, index, index + 1))}
          />
          <IconButton
            symbol="trash"
            label={`Remove ${name}`}
            destructive
            onPress={() => changeDraft((form) => removeExercise(form, index))}
            testID={`remove-exercise-${index}`}
          />
        </View>
      </View>
      <ListSection>
        {exercise.sets.map((set, setIndex) => {
          const target = setTargetText(set);
          const badge = badges[setIndex]!;
          return (
            <ListRow
              // A set in the editor has no identity of its own. Its row is its place.
              // eslint-disable-next-line react/no-array-index-key
              key={setIndex}
              title={badge.label}
              value={target.text}
              accessibilityLabel={`${badge.label}, ${target.label}`}
              trailing={{
                type: "chevron",
                onPress: () =>
                  navigation.navigate("SetTarget", {
                    exercise: String(index),
                    set: String(setIndex),
                  }),
              }}
              testID={`routine-set-${index}-${setIndex}`}
            />
          );
        })}
      </ListSection>
      <View className="flex-row px-gutter">
        <Button
          label="Add set"
          symbol="plus"
          variant="plain"
          onPress={() => changeDraft((form) => addSet(form, index))}
          testID={`add-set-${index}`}
        />
      </View>
    </View>
  );
}

function Editor({
  draft,
  onSaved,
}: {
  readonly draft: RoutineDraft;
  readonly onSaved: (id: RoutineId) => void;
}) {
  const navigation = useNavigation<RootNavigation>();
  const { form } = draft;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const folders = useOnFocus(loadFolders);
  const exercises = useExerciseList();
  const names = useMemo(
    () =>
      new Map<ExerciseId, string>(
        exercises.state === "ready"
          ? exercises.value.map((exercise) => [exercise.id, exercise.name])
          : [],
      ),
    [exercises],
  );

  const folderList = folders.state === "ready" ? folders.value : [];
  const folderName = folderList.find((folder) => folder.id === form.folderId)?.name ?? "None";

  const save = () => {
    const result = routineFromForm(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setSaving(true);
    saveRoutine(draft.database, draft.routineId, result.routine)
      .then(onSaved)
      .catch((cause: unknown) => setError(`The routine was not saved. ${String(cause)}`))
      .finally(() => setSaving(false));
  };

  return (
    <>
      <View className="gap-4 px-gutter">
        <TextField
          label="Name"
          value={form.title}
          onChangeText={(title) => changeDraft((current) => ({ ...current, title }))}
          placeholder="Push day"
          maxLength={ROUTINE_TITLE_MAX_LENGTH}
          testID="routine-name-field"
        />
        <TextField
          label="Notes"
          value={form.notes}
          onChangeText={(notes) => changeDraft((current) => ({ ...current, notes }))}
          placeholder="Optional"
          testID="routine-notes-field"
        />
      </View>
      <ListSection>
        <ListRow
          key="folder"
          title="Folder"
          value={folderName}
          trailing={{ type: "chevron", onPress: () => setChoosingFolder(true) }}
          testID="routine-folder"
        />
      </ListSection>
      {form.exercises.map((exercise, index) => (
        <ExerciseCard
          key={exercise.key}
          exercise={exercise}
          index={index}
          count={form.exercises.length}
          name={exerciseName(names, exercise.exerciseId)}
        />
      ))}
      <View className="gap-3 px-gutter">
        <Button
          label="Add exercises"
          symbol="plus"
          variant="secondary"
          onPress={() => navigation.navigate("PickExercise")}
          testID="add-exercise"
        />
        {error !== null ? (
          <AppText tone="destructive" testID="routine-error">
            {error}
          </AppText>
        ) : null}
        <Button label="Save routine" onPress={save} disabled={saving} testID="save-routine" />
      </View>
      <OptionSheet
        title="Folder"
        mode="single"
        noneLabel="No folder"
        options={folderList.map((folder) => ({ value: folder.id, label: folder.name }))}
        selected={form.folderId}
        onSelect={(folderId) => changeDraft((current) => ({ ...current, folderId }))}
        isPresented={choosingFolder}
        onDismiss={() => setChoosingFolder(false)}
        testID="routine-folder-sheet"
      />
    </>
  );
}

const loadFolders = () => readRoutines((routines) => routines.listFolders);

function EditorScroll({ children }: { readonly children: ReactNode }) {
  return (
    <ScrollView
      testID="routine-editor"
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 24, paddingVertical: 16 }}
    >
      {children}
    </ScrollView>
  );
}

/** Owns the draft while the editor is open, and drops it when the editor closes. */
function useOwnedDraft(owner: string): RoutineDraft | null {
  const draft = useDraft();
  useEffect(() => () => closeDraft(owner), [owner]);
  return draft?.owner === owner ? draft : null;
}

/**
 * A new routine. A link such as svett://routines/new?title=Push opens it with the name
 * filled in, and ?folder=<id> puts it in that folder.
 */
export function NewRoutineScreen() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<RouteProp<RootStackParamList, "NewRoutine">>();
  const draft = useOwnedDraft(route.key);
  useEffect(() => {
    openDraft({
      owner: route.key,
      routineId: null,
      database: currentDatabase(),
      form: routineFormFromParams(route.params),
    });
  }, [route.key, route.params]);
  return (
    <EditorScroll>
      {draft !== null ? (
        <Editor draft={draft} onSaved={(id) => navigation.replace("Routine", { id })} />
      ) : null}
    </EditorScroll>
  );
}

/** Edits a saved routine. Saving replaces its exercises and sets with the editor's. */
export function EditRoutineScreen() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<RouteProp<RootStackParamList, "EditRoutine">>();
  const draft = useOwnedDraft(route.key);
  const loaded = useRoutine(route.params.id);
  const detail = loaded.state === "ready" ? loaded.value?.detail : undefined;
  useEffect(() => {
    if (detail !== undefined && draft === null) {
      openDraft({
        owner: route.key,
        routineId: detail.routine.id,
        database: currentDatabase(),
        form: routineForm(detail),
      });
    }
  }, [detail, draft, route.key]);
  return (
    <EditorScroll>
      {draft !== null ? <Editor draft={draft} onSaved={() => navigation.goBack()} /> : null}
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
    </EditorScroll>
  );
}
