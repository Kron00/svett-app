import { BottomTabBar, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { View } from "react-native";

import { WorkoutBar } from "../ui/WorkoutBar";
import { useWorkout } from "./store";
import { useElapsed } from "./timing";

function Bar({
  title,
  startedAt,
  onPress,
}: {
  readonly title: string;
  readonly startedAt: number;
  readonly onPress: () => void;
}) {
  return (
    <View className="px-gutter pb-2">
      <WorkoutBar
        title={title}
        elapsed={useElapsed(startedAt)}
        onPress={onPress}
        testID="workout-bar"
      />
    </View>
  );
}

/** The tab bar, with the workout in progress above it on every tab until it is finished or discarded. */
export function WorkoutTabBar(props: BottomTabBarProps) {
  const workout = useWorkout();
  const log = workout.status === "ready" ? workout.log : null;
  return (
    <View>
      {log !== null ? (
        <Bar
          title={log.activity.title}
          startedAt={log.activity.startedAt}
          onPress={() => props.navigation.navigate("ActiveWorkout")}
        />
      ) : null}
      <BottomTabBar {...props} />
    </View>
  );
}
