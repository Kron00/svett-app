import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityRepository,
  MANUAL_KINDS,
  type ManualKind,
  type ManualProblem,
  manualEntryDraft,
} from "@svett/core";
import { Effect, Result } from "effect";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { appDatabase } from "../data/database";
import { useColor } from "../design/hooks";
import { SPORTS } from "../design/tokens";
import type { RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { SegmentedControl } from "../ui/SegmentedControl";
import { TextField } from "../ui/TextField";

type Props = NativeStackScreenProps<RootStackParamList, "ManualCardio">;

const HOUR = 3_600_000;

const isManualKind = (value: string | undefined): value is ManualKind =>
  (MANUAL_KINDS as ReadonlyArray<string | undefined>).includes(value);

/** A start from a link, or an hour ago, so a workout just finished needs no change. */
const initialStart = (start: string | undefined) => {
  const parsed = start === undefined ? Number.NaN : Number(start);
  return new Date(Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now() - HOUR);
};

/**
 * Enter a workout svett did not record: its sport, start, duration, distance and notes.
 * A svett://manual link can fill the fields, for the simulator proof.
 */
export function ManualCardioScreen({ route, navigation }: Props) {
  const params = route.params ?? {};
  const [kind, setKind] = useState<ManualKind>(isManualKind(params.kind) ? params.kind : "run");
  const [start, setStart] = useState(() => initialStart(params.start));
  const [duration, setDuration] = useState(params.duration ?? "");
  const [distance, setDistance] = useState(params.distance ?? "");
  const [notes, setNotes] = useState(params.notes ?? "");
  const [problem, setProblem] = useState<ManualProblem>();
  const [saving, setSaving] = useState(false);
  const accent = useColor("accent");
  const [opened] = useState(() => new Date());

  const save = async () => {
    const draft = manualEntryDraft(
      { kind, startedAt: start.getTime(), duration, distance, notes },
      Date.now(),
      start.getHours(),
    );
    if (Result.isFailure(draft)) {
      setProblem(draft.failure);
      return;
    }
    setProblem(undefined);
    setSaving(true);
    try {
      const id = await appDatabase().runPromise(
        Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
          activities.create(draft.success),
        ),
      );
      navigation.replace("Activity", { id });
    } catch (error) {
      setSaving(false);
      setProblem({ field: "start", message: `It was not saved. ${String(error)}` });
    }
  };

  const problemFor = (field: ManualProblem["field"]) =>
    problem?.field === field ? problem.message : undefined;

  return (
    <ScrollView
      testID="manual-cardio"
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 px-gutter pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <SegmentedControl
        accessibilityLabel="Sport"
        options={MANUAL_KINDS.map((value) => ({ value, label: SPORTS[value].label }))}
        selected={kind}
        onSelect={setKind}
      />
      <View className="gap-1.5">
        <AppText variant="subheadline" tone="secondary">
          Start
        </AppText>
        <View className="min-h-target flex-row flex-wrap items-center gap-3">
          <DateTimePicker
            testID="manual-start"
            value={start}
            mode="datetime"
            display="compact"
            maximumDate={opened}
            accentColor={accent}
            onValueChange={(_, date) => setStart(date)}
          />
        </View>
        {problemFor("start") ? (
          <AppText variant="footnote" tone="destructive">
            {problemFor("start")}
          </AppText>
        ) : null}
      </View>
      <TextField
        label="Duration"
        value={duration}
        onChangeText={setDuration}
        placeholder="45, or 1:05:00"
        keyboardType="numbers-and-punctuation"
        problem={problemFor("duration")}
        testID="manual-duration"
      />
      <TextField
        label="Distance in km"
        value={distance}
        onChangeText={setDistance}
        placeholder="Leave empty if it has none"
        keyboardType="decimal-pad"
        problem={problemFor("distance")}
        testID="manual-distance"
      />
      <TextField
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        multiline
        testID="manual-notes"
      />
      <View className="flex-row">
        <Button
          label={saving ? "Saving" : "Save"}
          symbol="checkmark"
          disabled={saving}
          onPress={() => void save()}
          testID="manual-save"
        />
      </View>
    </ScrollView>
  );
}
