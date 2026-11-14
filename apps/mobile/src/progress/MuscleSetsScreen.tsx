import {
  addWeeks,
  describeMuscleSets,
  formatSetCount,
  formatShortDay,
  formatWeek,
  isMuscle,
  MUSCLE_LABEL,
  MUSCLE_SET_RULE,
  type Muscle,
  muscleSets,
  parseWeekKey,
  weekKey,
  weeklyMuscleSets,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { useMemo } from "react";
import { ScrollView, View } from "react-native";

import { useQuery } from "../data/useQuery";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { ChartCard } from "./ChartCard";
import { CHART_WEEKS, muscleWeeks } from "./queries";
import { QueryView } from "./QueryView";

const sets = (count: number) => `${formatSetCount(count)} ${count === 1 ? "set" : "sets"}`;

/**
 * Sets per muscle in one week, counted by MUSCLE_SET_RULE, which the screen
 * shows. A chart shows one muscle's last 12 weeks. `week` and `muscle` come
 * from the route, so a link can open any week.
 */
export function MuscleSetsScreen() {
  const navigation = useNavigation<RootNavigation>();
  const params = useRoute<RouteProp<RootStackParamList, "MuscleSets">>().params;
  const weekParam = params?.week;
  const query = useMemo(
    () => muscleWeeks(weekParam === undefined ? null : parseWeekKey(weekParam)),
    [weekParam],
  );
  const { state } = useQuery(query);

  return (
    <QueryView state={state}>
      {({ thisWeek, weekStart, sets: logged, muscles }) => {
        const musclesOf = (id: string) => muscles.get(id);
        const weekEnd = addWeeks(weekStart, 1);
        const week = muscleSets(
          logged.filter((set) => set.startedAt >= weekStart && set.startedAt < weekEnd),
          musclesOf,
        );
        const fromParam: Muscle | undefined = isMuscle(params?.muscle) ? params.muscle : undefined;
        const charted: Muscle =
          fromParam ?? week[0]?.muscle ?? muscleSets(logged, musclesOf)[0]?.muscle ?? "chest";
        const weekly = weeklyMuscleSets(logged, musclesOf, charted, weekStart, CHART_WEEKS);
        const points = weekly.map(({ weekStart: start, sets: count }) => ({
          key: weekKey(start),
          at: start,
          value: count,
        }));
        const shown = weekly[weekly.length - 1]?.sets ?? 0;
        const goToWeek = (start: number) =>
          navigation.setParams({ week: weekKey(start), muscle: params?.muscle });
        return (
          <ScrollView
            testID="muscle-sets"
            contentInsetAdjustmentBehavior="automatic"
            className="flex-1 bg-background"
            contentContainerStyle={{ gap: 16, paddingVertical: 16 }}
          >
            <View className="gap-2 px-gutter">
              <AppText variant="headline" accessibilityRole="header" testID="muscle-week">
                {formatWeek(weekStart)}
              </AppText>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label="Previous week"
                  symbol="chevron.left"
                  variant="secondary"
                  testID="previous-week"
                  onPress={() => goToWeek(addWeeks(weekStart, -1))}
                />
                <Button
                  label="Next week"
                  symbol="chevron.right"
                  variant="secondary"
                  testID="next-week"
                  disabled={weekStart >= thisWeek}
                  onPress={() => goToWeek(addWeeks(weekStart, 1))}
                />
              </View>
            </View>
            <ChartCard
              testID="chart-muscle-weeks"
              title={`${MUSCLE_LABEL[charted]}, sets per week`}
              value={sets(shown)}
              detail={`Week of ${formatShortDay(weekStart)}, and the ${CHART_WEEKS - 1} weeks before.`}
              rule={MUSCLE_SET_RULE}
              points={points}
              format={sets}
              mark="bars"
              color="sport-strength"
            />
            {week.length === 0 ? (
              <EmptyState
                symbol="figure.strengthtraining.traditional"
                title="No sets this week"
                message="Sets from workouts you finish this week count here."
              />
            ) : (
              <ListSection header="Sets this week" footer={MUSCLE_SET_RULE}>
                {week.map((entry) => (
                  <ListRow
                    key={entry.muscle}
                    title={MUSCLE_LABEL[entry.muscle]}
                    subtitle={
                      entry.muscle === charted
                        ? `${describeMuscleSets(entry)}. In the chart.`
                        : describeMuscleSets(entry)
                    }
                    value={sets(entry.sets)}
                    testID={`muscle-row-${entry.muscle}`}
                    trailing={{
                      type: "chevron",
                      onPress: () =>
                        navigation.setParams({ week: params?.week, muscle: entry.muscle }),
                    }}
                  />
                ))}
              </ListSection>
            )}
            <View testID="muscle-sets-end" />
          </ScrollView>
        );
      }}
    </QueryView>
  );
}
