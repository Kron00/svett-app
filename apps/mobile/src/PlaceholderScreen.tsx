import type { ReactNode } from "react";
import { Text, View } from "react-native";

import type { Tab } from "./tabs";

export function PlaceholderScreen({
  tab,
  children,
}: {
  readonly tab: Tab;
  readonly children?: ReactNode;
}) {
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-black px-8">
      <Text className="text-2xl font-semibold text-white">{tab.name}</Text>
      <Text className="text-center text-base text-neutral-400">{tab.summary}</Text>
      {children}
    </View>
  );
}
