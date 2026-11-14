import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import {
  ActivityRepository,
  exerciseSummary,
  formatRecordValue,
  formatVolumeKg,
  formatWorkoutDuration,
  HistoryRepository,
  RECORD_RULES,
  RECORDS_RULE,
  weekStreak,
  type WorkoutSummary,
} from "@svett/core";
import { Effect } from "effect";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { useQuery } from "../data/store";
import { useIsAccessibilityTextSize } from "../design/hooks";
import { SPORTS } from "../design/tokens";
import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection, SectionHeader } from "../ui/List";
import { StatTile } from "../ui/StatTile";
import { formatDay, PHONE_OFFSET, useNow } from "./dates";
import { type DeletedWorkout, setDeletedWorkout, undoDelete, useDeletedWorkout } from "./deleted";
import { recentRecords } from "./queries";

const PAGE = 60;
const RECENT = recentRecords(5);

const weeks = (count: number) => (count === 1 ? "week" : "weeks");

function HistoryRow({
  row,
  onPress,
}: {
  readonly row: WorkoutSummary;
  readonly onPress: () => void;
}) {
  const { activity } = row;
  const sport = SPORTS[activity.kind];
  const when = `${formatDay(activity.startedAt)} · ${formatWorkoutDuration(activity.durationS)}`;
  const exercises = activity.kind === "strength" ? exerciseSummary(row.exerciseNames) : sport.label;
  const totals =
    row.setCount === 0 ? null : `${row.setCount} sets · ${formatVolumeKg(row.volumeKg)}`;
  return (
    <View testID="history-row" className="px-gutter pb-3">
      <Pressable
        testID={`workout-${activity.id}`}
        accessibilityRole="button"
        accessibilityLabel={[activity.title || sport.label, when, exercises, totals]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint="Opens the workout"
        onPress={onPress}
        className="min-h-target gap-1 rounded-card bg-surface p-4"
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <View className="flex-row items-center gap-2">
          <Icon name={sport.symbol} color={sport.color} size={15} />
          <AppText variant="headline" className="flex-1">
            {activity.title || sport.label}
          </AppText>
        </View>
        <AppText variant="subheadline" tone="secondary">
          {when}
        </AppText>
        <AppText variant="subheadline">{exercises}</AppText>
        {totals ? (
          <AppText variant="footnote" tone="secondary" numeric>
            {totals}
          </AppText>
        ) : null}
      </Pressable>
    </View>
  );
}

function UndoDeleteBar({ workout }: { readonly workout: DeletedWorkout }) {
  const stacked = useIsAccessibilityTextSize();
  return (
    <View testID="undo-delete-banner" className="absolute inset-x-0 bottom-0 px-gutter pb-3">
      <View
        className={`gap-3 rounded-card bg-control p-4 ${stacked ? "" : "flex-row items-center"}`}
      >
        <AppText className={stacked ? "" : "flex-1"}>Deleted {workout.title}.</AppText>
        <View className="flex-row flex-wrap gap-2">
          <Button
            label="Undo"
            symbol="arrow.uturn.backward"
            testID="undo-delete"
            accessibilityHint="Brings the workout back"
            onPress={() => void undoDelete(workout)}
          />
          <Button
            label="Close"
            variant="plain"
            testID="undo-delete-close"
            onPress={() => setDeletedWorkout(null)}
          />
        </View>
      </View>
    </View>
  );
}

function RecentRecords() {
  const navigation = useNavigation<RootNavigation>();
  const query = useQuery("recent-records", () => RECENT);
  const records = query.status === "ready" ? query.value : [];
  return (
    <View className="gap-3">
      <SectionHeader title="Recent records" />
      {query.status === "ready" && records.length === 0 ? (
        <EmptyState
          symbol="trophy"
          title="No records yet"
          message="A set shows here when it beats every earlier workout with its exercise."
        />
      ) : (
        <ListSection>
          {records.map(({ record, exerciseName }) => (
            <ListRow
              key={`${record.setId} ${record.kind}`}
              title={exerciseName}
              subtitle={`${RECORD_RULES[record.kind].label}, ${formatDay(record.achievedAt)}`}
              value={formatRecordValue(RECORD_RULES[record.kind].unit, record.value)}
              testID="recent-record"
              icon={{ symbol: "trophy.fill", color: "set-warm-up" }}
              trailing={{
                type: "chevron",
                onPress: () =>
                  navigation.navigate("ExerciseProgress", { exerciseId: record.exerciseId }),
              }}
            />
          ))}
        </ListSection>
      )}
      <AppText testID="progress-end" variant="footnote" tone="secondary" className="px-8">
        {RECORDS_RULE}
      </AppText>
    </View>
  );
}

function Summary() {
  const navigation = useNavigation<RootNavigation>();
  const now = useNow();
  const query = useQuery("summary", () =>
    Effect.gen(function* () {
      const history = yield* HistoryRepository;
      const activities = yield* ActivityRepository;
      return { starts: yield* history.starts, counts: yield* activities.counts };
    }),
  );
  const streak =
    query.status === "ready"
      ? weekStreak(
          query.value.starts.map((start) => start.startedAt),
          now,
          PHONE_OFFSET,
        )
      : null;
  const counts =
    query.status === "ready"
      ? `${query.value.counts.activities} workouts, ${query.value.counts.sets} sets`
      : query.status === "failed"
        ? `The database did not open. ${query.message}`
        : "Opening the database";

  return (
    <View className="gap-4 pb-4 pt-4">
      <View className="flex-row flex-wrap gap-3 px-gutter">
        <StatTile
          testID="streak-current"
          label="Streak"
          value={String(streak?.current ?? 0)}
          unit={weeks(streak?.current ?? 0)}
          symbol="flame.fill"
          color="warning"
        />
        <StatTile
          testID="streak-longest"
          label="Longest streak"
          value={String(streak?.longest ?? 0)}
          unit={weeks(streak?.longest ?? 0)}
          symbol="trophy.fill"
          color="warning"
        />
      </View>
      <AppText testID="workout-counts" variant="footnote" tone="secondary" className="px-gutter">
        {counts}
      </AppText>
      <ListSection footer="The streak counts weeks, Monday to Sunday, with at least one workout.">
        <ListRow
          testID="calendar-row"
          title="Calendar"
          icon={{ symbol: "calendar", color: "accent" }}
          trailing={{ type: "chevron", onPress: () => navigation.navigate("Calendar") }}
        />
        <ListRow
          title="Exercises"
          subtitle="Charts and records for each exercise"
          testID="progress-exercises-row"
          icon={{ symbol: "chart.xyaxis.line", color: "accent" }}
          trailing={{ type: "chevron", onPress: () => navigation.navigate("ProgressExercises") }}
        />
        <ListRow
          title="Muscles"
          subtitle="Sets per muscle each week"
          testID="progress-muscles-row"
          icon={{ symbol: "figure.strengthtraining.traditional", color: "sport-strength" }}
          trailing={{ type: "chevron", onPress: () => navigation.navigate("MuscleSets") }}
        />
        <ListRow
          title="Body measurements"
          subtitle="Weight, body fat and tape measurements"
          testID="progress-measurements-row"
          icon={{ symbol: "ruler", color: "sport-walk" }}
          trailing={{ type: "chevron", onPress: () => navigation.navigate("Measurements") }}
        />
      </ListSection>
      <RecentRecords />
      <SectionHeader title="History" />
    </View>
  );
}

/**
 * The Progress tab, with the streak, the ways into the calendar, charts, muscles
 * and measurements, the newest records and every workout, newest first.
 */
export function ProgressScreen() {
  const navigation = useNavigation<RootNavigation>();
  const deleted = useDeletedWorkout();
  const [limit, setLimit] = useState(PAGE);
  const query = useQuery(`history-${limit}`, () =>
    Effect.flatMap(Effect.service(HistoryRepository), (history) => history.page({ limit })),
  );
  const rows = query.status === "ready" ? query.value : [];
  const more = rows.length === limit;

  return (
    <View testID="progress" className="flex-1 bg-background">
      <LegendList
        testID="history-list"
        data={rows}
        keyExtractor={(row) => row.activity.id}
        renderItem={({ item }) => (
          <HistoryRow
            row={item}
            onPress={() => navigation.navigate("Workout", { id: item.activity.id })}
          />
        )}
        recycleItems
        estimatedItemSize={132}
        // Rows a screen and a half ahead are drawn before they scroll in, so a fast fling shows no gaps.
        drawDistance={1200}
        onEndReached={() => {
          if (more) setLimit((current) => current + PAGE);
        }}
        onEndReachedThreshold={1}
        contentInsetAdjustmentBehavior="automatic"
        ListHeaderComponent={<Summary />}
        ListEmptyComponent={
          query.status === "ready" ? (
            <EmptyState
              symbol="clock.arrow.circlepath"
              title="No workouts yet"
              message="Workouts you finish or import show up here, newest first."
            />
          ) : null
        }
        ListFooterComponent={<View style={{ height: deleted ? 160 : 24 }} />}
      />
      {deleted ? <UndoDeleteBar workout={deleted} /> : null}
    </View>
  );
}
