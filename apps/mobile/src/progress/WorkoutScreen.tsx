import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityId,
  formatVolumeKg,
  formatWeightKg,
  formatWorkoutDuration,
  HistoryRepository,
  MUSCLE_LABELS,
  MUSCLE_SPLIT_RULE,
  type MuscleShare,
  RECORD_LABELS,
  type RecordKind,
  saveWorkoutAsRoutine,
  type WorkoutExercise,
  type WorkoutSet,
  type WorkoutView,
} from "@svett/core";
import { Effect, Option, Schema } from "effect";
import { useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { useQuery, write } from "../data/store";
import { useColor } from "../design/hooks";
import { SET_TYPE_COLOR, SPORTS } from "../design/tokens";
import type { RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/Icon";
import { SectionHeader } from "../ui/List";
import { StatTile } from "../ui/StatTile";
import { formatDayAndTime } from "./dates";
import { deleteWorkout } from "./deleted";

type Props = NativeStackScreenProps<RootStackParamList, "Workout">;

const parseActivityId = Schema.decodeUnknownOption(ActivityId);

function RecordBadge({ kind }: { readonly kind: RecordKind }) {
  return (
    <View className="flex-row items-center gap-1">
      <Icon name="trophy.fill" color="warning" size={12} />
      <AppText variant="caption1" tone="warning">
        {RECORD_LABELS[kind]}
      </AppText>
    </View>
  );
}

function SetLine({ set, onPress }: { readonly set: WorkoutSet; readonly onPress: () => void }) {
  const badgeColor = useColor(SET_TYPE_COLOR[set.setType]);
  const records = set.records.map((kind) => `${RECORD_LABELS[kind]} record`);
  return (
    <Pressable
      testID={`set-${set.id}`}
      accessibilityRole="button"
      accessibilityLabel={[set.badge.label, set.text, ...records].join(", ")}
      accessibilityHint="Edits the set"
      onPress={onPress}
      className="min-h-target flex-row items-center gap-3 py-2"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <AppText
        variant="headline"
        numeric
        className="min-w-8 text-center"
        style={{ color: badgeColor }}
      >
        {set.badge.text}
      </AppText>
      <View className="flex-1 gap-1">
        <AppText numeric>{set.text}</AppText>
        {set.records.length > 0 ? (
          <View className="flex-row flex-wrap gap-x-3 gap-y-1">
            {set.records.map((kind) => (
              <RecordBadge key={kind} kind={kind} />
            ))}
          </View>
        ) : null}
      </View>
      <Icon name="pencil" color="tertiary-label" size={14} />
    </Pressable>
  );
}

function ExerciseCard({
  entry,
  onEditSet,
}: {
  readonly entry: WorkoutExercise;
  readonly onEditSet: (set: WorkoutSet) => void;
}) {
  return (
    <View className="mx-gutter gap-1 rounded-card bg-surface px-4 py-3">
      <AppText variant="headline" accessibilityRole="header">
        {entry.name}
      </AppText>
      {entry.exercise.notes ? (
        <AppText variant="subheadline" tone="secondary">
          {entry.exercise.notes}
        </AppText>
      ) : null}
      {entry.sets.map((set) => (
        <SetLine key={set.id} set={set} onPress={() => onEditSet(set)} />
      ))}
    </View>
  );
}

function MuscleSplitCard({ split }: { readonly split: ReadonlyArray<MuscleShare> }) {
  return (
    <View testID="muscle-split" className="gap-2">
      <SectionHeader title="Muscle split" />
      <View className="mx-gutter gap-3 rounded-card bg-surface p-4">
        {split.map((share) => (
          <View
            key={share.muscle}
            accessible
            accessibilityLabel={`${MUSCLE_LABELS[share.muscle]}, ${share.percent} percent, ${formatWeightKg(share.sets)} sets`}
            className="gap-1"
          >
            <View className="flex-row flex-wrap justify-between gap-x-3">
              <AppText variant="subheadline">{MUSCLE_LABELS[share.muscle]}</AppText>
              <AppText variant="subheadline" tone="secondary" numeric>
                {share.percent}% · {formatWeightKg(share.sets)} sets
              </AppText>
            </View>
            <View className="h-2 overflow-hidden rounded-full bg-control">
              <View className="h-2 rounded-full bg-accent" style={{ width: `${share.percent}%` }} />
            </View>
          </View>
        ))}
      </View>
      <AppText variant="footnote" tone="secondary" className="px-8">
        {MUSCLE_SPLIT_RULE}
      </AppText>
    </View>
  );
}

type Saving =
  | { readonly status: "idle" | "saving" }
  | { readonly status: "saved"; readonly title: string }
  | { readonly status: "failed"; readonly message: string };

/** One past workout with record badges and its muscle split. Sets open for editing, and it saves as a routine or deletes. */
export function WorkoutScreen({ route, navigation }: Props) {
  const id = Option.getOrNull(parseActivityId(route.params.id));
  const query = useQuery(`workout-${route.params.id}`, () =>
    id === null
      ? Effect.succeed(Option.none())
      : Effect.flatMap(Effect.service(HistoryRepository), (history) => history.workout(id)),
  );
  const [saving, setSaving] = useState<Saving>({ status: "idle" });
  // A deleted workout stays on screen while the screen slides away, instead of reading as missing.
  const [leaving, setLeaving] = useState<WorkoutView | null>(null);
  const view = leaving ?? (query.status === "ready" ? Option.getOrNull(query.value) : null);
  const title = view ? view.activity.title || SPORTS[view.activity.kind].label : "Workout";

  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  if (query.status === "loading") return <View className="flex-1 bg-background" />;
  if (view === null || id === null) {
    return (
      <View className="flex-1 justify-center bg-background">
        <EmptyState
          symbol="questionmark.folder"
          title="This workout is not here"
          message={
            query.status === "failed"
              ? `It did not load. ${query.message}`
              : "It may have been deleted."
          }
          action={{
            label: "Back to history",
            onPress: () => navigation.navigate("Tabs", { screen: "Progress" }),
          }}
        />
      </View>
    );
  }

  const { activity } = view;
  return (
    <ScrollView
      testID="workout-detail"
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 pb-10 pt-4"
    >
      <View className="gap-1 px-gutter">
        <AppText variant="title2" accessibilityRole="header">
          {title}
        </AppText>
        <AppText variant="subheadline" tone="secondary">
          {formatDayAndTime(activity.startedAt)}
        </AppText>
        {activity.notes ? <AppText className="pt-2">{activity.notes}</AppText> : null}
      </View>

      <View className="flex-row flex-wrap gap-3 px-gutter">
        <StatTile
          label="Duration"
          value={formatWorkoutDuration(activity.durationS)}
          symbol="clock"
        />
        <StatTile label="Volume" value={formatVolumeKg(view.volumeKg)} symbol="scalemass" />
        <StatTile label="Sets" value={String(view.setCount)} symbol="number" />
        <StatTile
          testID="workout-records"
          label="Records"
          value={String(view.recordCount)}
          symbol="trophy.fill"
          color="warning"
        />
      </View>

      {view.split.length > 0 ? <MuscleSplitCard split={view.split} /> : null}

      {view.exercises.length > 0 ? (
        <View className="gap-3">
          <SectionHeader title="Exercises" />
          {view.exercises.map((entry) => (
            <ExerciseCard
              key={entry.exercise.id}
              entry={entry}
              onEditSet={(set) =>
                navigation.navigate("SetEdit", { activityId: activity.id, setId: set.id })
              }
            />
          ))}
        </View>
      ) : null}

      <View className="gap-3 px-gutter">
        <Button
          label="Save as routine"
          variant="secondary"
          symbol="square.and.arrow.down"
          testID="workout-save-routine"
          disabled={saving.status === "saving"}
          onPress={() => {
            setSaving({ status: "saving" });
            write(saveWorkoutAsRoutine(id)).then(
              () => setSaving({ status: "saved", title }),
              (error: unknown) => setSaving({ status: "failed", message: String(error) }),
            );
          }}
        />
        {saving.status === "saved" ? (
          <AppText testID="routine-saved" tone="success" accessibilityLiveRegion="polite">
            Saved as the routine {saving.title}, with these sets as its targets.
          </AppText>
        ) : null}
        {saving.status === "failed" ? (
          <AppText tone="destructive">The routine was not saved. {saving.message}</AppText>
        ) : null}
        <Button
          label="Delete workout"
          variant="destructive"
          symbol="trash"
          testID="workout-delete"
          accessibilityHint="Deletes it. History offers Undo."
          onPress={() => {
            setLeaving(view);
            void deleteWorkout({ id, title }).then(() =>
              navigation.navigate("Tabs", { screen: "Progress" }),
            );
          }}
        />
      </View>
    </ScrollView>
  );
}
