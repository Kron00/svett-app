import type { ReactNode } from "react";
import { View } from "react-native";

import type { QueryState } from "../data/useQuery";
import { AppText } from "../ui/AppText";
import { EmptyState } from "../ui/EmptyState";

/** A screen's content once its query is ready, or what it shows while loading or after a failure. */
export function QueryView<A>({
  state,
  children,
}: {
  readonly state: QueryState<A>;
  readonly children: (value: A) => ReactNode;
}) {
  switch (state.status) {
    case "loading":
      return (
        <View
          testID="progress-loading"
          className="flex-1 items-center justify-center bg-background"
        >
          <AppText tone="secondary">Reading your workouts</AppText>
        </View>
      );
    case "failed":
      return (
        <View className="flex-1 justify-center bg-background">
          <EmptyState
            symbol="exclamationmark.triangle"
            title="Your data did not load"
            message={state.message}
          />
        </View>
      );
    case "ready":
      return children(state.value);
  }
}
