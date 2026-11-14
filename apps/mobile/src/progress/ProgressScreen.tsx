import { formatDay, formatRecordValue, RECORD_RULES, RECORDS_RULE } from "@svett/core";
import { useNavigation } from "@react-navigation/native";
import { ScrollView, View } from "react-native";

import { WorkoutCounts } from "../data/WorkoutCounts";
import { useQuery } from "../data/useQuery";
import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection, SectionHeader } from "../ui/List";
import { recentRecords } from "./queries";
import { QueryView } from "./QueryView";

const RECENT = recentRecords(5);

/** The Progress tab: the ways into charts, muscles and measurements, and the newest records. */
export function ProgressScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { state } = useQuery(RECENT);
  return (
    <QueryView state={state}>
      {(records) => (
        <ScrollView
          testID="progress"
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-background"
          contentContainerStyle={{ gap: 24, paddingVertical: 16 }}
        >
          <View className="px-gutter">
            <WorkoutCounts />
          </View>
          <ListSection>
            <ListRow
              title="Exercises"
              subtitle="Charts and records for each exercise"
              testID="progress-exercises-row"
              icon={{ symbol: "chart.xyaxis.line", color: "accent" }}
              trailing={{
                type: "chevron",
                onPress: () => navigation.navigate("ProgressExercises"),
              }}
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
          <View className="gap-3">
            <SectionHeader title="Recent records" />
            {records.length === 0 ? (
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
          </View>
          <AppText testID="progress-end" variant="footnote" tone="secondary" className="px-8">
            {RECORDS_RULE}
          </AppText>
        </ScrollView>
      )}
    </QueryView>
  );
}
