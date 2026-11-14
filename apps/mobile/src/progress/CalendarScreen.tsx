import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  type CalendarDay,
  calendarWeeks,
  HistoryRepository,
  localDayNumber,
  monthKey,
  monthOf,
  parseMonthKey,
  shiftMonth,
  weekStreak,
  type WorkoutStart,
} from "@svett/core";
import { Effect } from "effect";
import { Pressable, ScrollView, View } from "react-native";

import { openActivity } from "../cardio/open-activity";
import { useQuery } from "../data/store";
import { useIsAccessibilityTextSize } from "../design/hooks";
import { SPORTS } from "../design/tokens";
import type { RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection } from "../ui/List";
import { StatTile } from "../ui/StatTile";
import { formatDay, formatDayNumber, formatMonth, PHONE_OFFSET, useNow } from "./dates";

type Props = NativeStackScreenProps<RootStackParamList, "Calendar">;

const WEEKDAYS = [
  { name: "Monday", letter: "M" },
  { name: "Tuesday", letter: "T" },
  { name: "Wednesday", letter: "W" },
  { name: "Thursday", letter: "T" },
  { name: "Friday", letter: "F" },
  { name: "Saturday", letter: "S" },
  { name: "Sunday", letter: "S" },
] as const;

const weeks = (count: number) => (count === 1 ? "week" : "weeks");

function MonthButton({
  label,
  symbol,
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly symbol: "chevron.left" | "chevron.right";
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="size-target items-center justify-center rounded-full bg-control"
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      <Icon name={symbol} color="accent" size={15} weight="semibold" />
    </Pressable>
  );
}

function DayCell({
  cell,
  today,
  onOpen,
}: {
  readonly cell: CalendarDay<WorkoutStart> | null;
  readonly today: number;
  readonly onOpen: (workout: WorkoutStart) => void;
}) {
  if (cell === null) return <View className="flex-1" />;
  const [first] = cell.workouts;
  const isToday = cell.dayNumber === today;
  const circle = `size-10 items-center justify-center rounded-full ${first ? "bg-accent-fill" : ""} ${isToday ? "border-2 border-accent" : ""}`;
  const digits = (
    <View className={circle}>
      <AppText numeric tone={first ? "onAccent" : "label"}>
        {cell.day}
      </AppText>
    </View>
  );
  const day = formatDayNumber(cell.dayNumber);
  if (first === undefined) {
    return (
      <View
        accessible
        accessibilityLabel={`${day}${isToday ? ", today" : ""}, no workout`}
        className="min-h-target flex-1 items-center justify-center"
      >
        {digits}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${day}${isToday ? ", today" : ""}, ${cell.workouts.map((workout) => workout.title || SPORTS[workout.kind].label).join(", ")}`}
      accessibilityHint="Opens the workout"
      onPress={() => onOpen(first)}
      className="min-h-target flex-1 items-center justify-center"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {digits}
    </Pressable>
  );
}

/** A month of workouts with the weekly streak. At accessibility text sizes the month is a list. */
export function CalendarScreen(props: Props) {
  const now = useNow();
  return now === null ? (
    <View className="flex-1 bg-background" />
  ) : (
    <Calendar {...props} now={now} />
  );
}

function Calendar({ route, navigation, now }: Props & { readonly now: number }) {
  const stacked = useIsAccessibilityTextSize();
  const thisMonth = monthOf(now, PHONE_OFFSET);
  const month = parseMonthKey(route.params?.month ?? "") ?? thisMonth;
  const query = useQuery("starts", () =>
    Effect.flatMap(Effect.service(HistoryRepository), (history) => history.starts),
  );
  const starts = query.status === "ready" ? query.value : [];
  const streak = weekStreak(
    starts.map((start) => start.startedAt),
    now,
    PHONE_OFFSET,
  );
  const grid = calendarWeeks(month, starts, PHONE_OFFSET);
  const inMonth = grid
    .flat()
    .flatMap((cell) => cell?.workouts ?? [])
    .sort((a, b) => a.startedAt - b.startedAt);
  const atThisMonth = monthKey(month) >= monthKey(thisMonth);
  const open = (workout: WorkoutStart) => openActivity(navigation, workout);
  const go = (by: number) => navigation.setParams({ month: monthKey(shiftMonth(month, by)) });

  return (
    <ScrollView
      testID="calendar"
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-5 pb-10 pt-4"
    >
      <View className="flex-row flex-wrap gap-3 px-gutter">
        <StatTile
          testID="calendar-streak"
          label="Streak"
          value={String(streak.current)}
          unit={weeks(streak.current)}
          symbol="flame.fill"
          color="warning"
        />
        <StatTile
          label="Longest streak"
          value={String(streak.longest)}
          unit={weeks(streak.longest)}
          symbol="trophy.fill"
          color="warning"
        />
      </View>

      <View className="mx-gutter gap-3 rounded-card bg-surface p-4">
        <View className="flex-row items-center gap-3">
          <MonthButton
            label="Previous month"
            symbol="chevron.left"
            disabled={false}
            onPress={() => go(-1)}
          />
          <AppText
            testID="calendar-month"
            variant="title3"
            accessibilityRole="header"
            className="flex-1 text-center"
          >
            {formatMonth(month)}
          </AppText>
          <MonthButton
            label="Next month"
            symbol="chevron.right"
            disabled={atThisMonth}
            onPress={() => go(1)}
          />
        </View>
        {stacked ? null : (
          <View className="gap-1">
            <View
              className="flex-row"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {WEEKDAYS.map((weekday) => (
                <AppText
                  key={weekday.name}
                  variant="caption1"
                  tone="secondary"
                  className="flex-1 text-center"
                >
                  {weekday.letter}
                </AppText>
              ))}
            </View>
            {grid.map((week) => (
              <View key={week.find((cell) => cell !== null)?.day} className="flex-row">
                {week.map((cell, index) => (
                  <DayCell
                    key={cell?.day ?? `blank-${index}`}
                    cell={cell}
                    today={localDayNumber(now, PHONE_OFFSET)}
                    onOpen={open}
                  />
                ))}
              </View>
            ))}
          </View>
        )}
        <AppText testID="calendar-count" variant="subheadline" tone="secondary">
          {inMonth.length === 1 ? "1 workout" : `${inMonth.length} workouts`} in{" "}
          {formatMonth(month)}
        </AppText>
      </View>

      {inMonth.length > 0 ? (
        <ListSection header="Workouts this month">
          {inMonth.map((workout) => (
            <ListRow
              key={workout.id}
              title={workout.title || SPORTS[workout.kind].label}
              subtitle={formatDay(workout.startedAt)}
              icon={{ symbol: SPORTS[workout.kind].symbol, color: SPORTS[workout.kind].color }}
              trailing={{ type: "chevron", onPress: () => open(workout) }}
            />
          ))}
        </ListSection>
      ) : null}
    </ScrollView>
  );
}
