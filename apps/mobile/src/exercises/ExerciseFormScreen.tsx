import {
  CATEGORY_LABEL,
  CATEGORY_OPTIONS,
  EQUIPMENT_LABEL,
  EQUIPMENT_OPTIONS,
  EXERCISE_NAME_MAX_LENGTH,
  type ExerciseFields,
  type ExerciseForm,
  exerciseForm,
  exerciseFormFromParams,
  exerciseFromForm,
  MADE_HERE,
  MUSCLE_LABEL,
  MUSCLE_OPTIONS,
  muscleList,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { OptionSheet } from "../ui/OptionSheet";
import { TextField } from "../ui/TextField";
import { changeExercises, useExercise } from "./data";

type Picker = "primary" | "secondary" | "equipment" | "category";

function Form({
  initial,
  onSave,
}: {
  readonly initial: ExerciseForm;
  readonly onSave: (fields: ExerciseFields) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const change = (patch: Partial<ExerciseForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const choose = (target: Picker) => ({
    type: "chevron" as const,
    onPress: () => setPicker(target),
  });

  const save = () => {
    const result = exerciseFromForm(form);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setSaving(true);
    onSave(result.fields).catch((error: unknown) => {
      setProblem(`The exercise was not saved. ${String(error)}`);
      setSaving(false);
    });
  };

  return (
    <ScrollView
      testID="exercise-form"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 24, paddingVertical: 16 }}
    >
      <View className="px-gutter">
        <TextField
          label="Name"
          placeholder="Landmine press"
          value={form.name}
          onChangeText={(name) => change({ name })}
          maxLength={EXERCISE_NAME_MAX_LENGTH}
          testID="exercise-name-field"
        />
      </View>
      <ListSection>
        <ListRow
          key="primary"
          title="Main muscle"
          value={form.primaryMuscle === null ? "Choose" : MUSCLE_LABEL[form.primaryMuscle]}
          trailing={choose("primary")}
          testID="exercise-primary-muscle"
        />
        <ListRow
          key="secondary"
          title="Other muscles"
          value={form.secondaryMuscles.length === 0 ? "None" : muscleList(form.secondaryMuscles)}
          trailing={choose("secondary")}
        />
        <ListRow
          key="equipment"
          title="Equipment"
          value={EQUIPMENT_LABEL[form.equipment]}
          trailing={choose("equipment")}
        />
        <ListRow
          key="category"
          title="Category"
          value={CATEGORY_LABEL[form.category]}
          trailing={choose("category")}
        />
      </ListSection>
      <View className="gap-3 px-gutter">
        {problem === null ? null : (
          <AppText tone="destructive" accessibilityRole="alert" testID="exercise-form-problem">
            {problem}
          </AppText>
        )}
        <Button label="Save exercise" disabled={saving} onPress={save} testID="save-exercise" />
      </View>

      <OptionSheet
        title="Main muscle"
        mode="single"
        options={MUSCLE_OPTIONS}
        selected={form.primaryMuscle}
        onSelect={(primaryMuscle) => change({ primaryMuscle })}
        isPresented={picker === "primary"}
        onDismiss={() => setPicker(null)}
      />
      <OptionSheet
        title="Other muscles"
        mode="multiple"
        options={MUSCLE_OPTIONS.filter((option) => option.value !== form.primaryMuscle)}
        selected={form.secondaryMuscles}
        onSelect={(secondaryMuscles) => change({ secondaryMuscles })}
        isPresented={picker === "secondary"}
        onDismiss={() => setPicker(null)}
      />
      <OptionSheet
        title="Equipment"
        mode="single"
        options={EQUIPMENT_OPTIONS}
        selected={form.equipment}
        onSelect={(equipment) => change({ equipment: equipment ?? form.equipment })}
        isPresented={picker === "equipment"}
        onDismiss={() => setPicker(null)}
      />
      <OptionSheet
        title="Category"
        mode="single"
        options={CATEGORY_OPTIONS}
        selected={form.category}
        onSelect={(category) => change({ category: category ?? form.category })}
        isPresented={picker === "category"}
        onDismiss={() => setPicker(null)}
      />
    </ScrollView>
  );
}

/**
 * A new custom exercise. There is no limit on how many. A link such as
 * svett://exercises/new?name=Landmine%20press&muscle=shoulders fills it in.
 */
export function NewExerciseScreen() {
  const navigation = useNavigation<RootNavigation>();
  const params = useRoute<RouteProp<RootStackParamList, "NewExercise">>().params;
  return (
    <Form
      // A second link while the form is open starts it over with the new values.
      key={JSON.stringify(params ?? {})}
      initial={exerciseFormFromParams(params)}
      onSave={async (fields) => {
        const id = await changeExercises((exercises) =>
          exercises.create({ ...fields, origin: MADE_HERE }),
        );
        navigation.replace("Exercise", { id });
      }}
    />
  );
}

/** Edits a custom exercise. Library exercises are the same on every phone, so they stay as they are. */
export function EditExerciseScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { id } = useRoute<RouteProp<RootStackParamList, "EditExercise">>().params;
  const loaded = useExercise(id);

  if (loaded.state === "ready" && (loaded.value === null || loaded.value.source !== "svett")) {
    return (
      <View className="flex-1 bg-background pt-16">
        <EmptyState
          symbol="questionmark.circle"
          title="Nothing to edit"
          message="Only custom exercises can be edited."
        />
      </View>
    );
  }
  if (loaded.state === "failed") {
    return (
      <View className="flex-1 bg-background pt-16">
        <EmptyState
          symbol="exclamationmark.triangle"
          title="The exercise did not load"
          message={loaded.message}
        />
      </View>
    );
  }
  if (loaded.state !== "ready" || loaded.value === null) {
    return <View className="flex-1 bg-background" />;
  }
  const exerciseId = loaded.value.id;
  // The form takes its values once. A reload when the screen comes back keeps what was typed.
  return (
    <Form
      key={exerciseId}
      initial={exerciseForm(loaded.value)}
      onSave={async (fields) => {
        await changeExercises((exercises) => exercises.update(exerciseId, fields));
        navigation.goBack();
      }}
    />
  );
}
