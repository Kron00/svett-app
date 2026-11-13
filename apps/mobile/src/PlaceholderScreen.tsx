import { Text, View } from "react-native";

import type { Tab } from "./tabs";

export function PlaceholderScreen({ tab }: { readonly tab: Tab }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-white px-8 dark:bg-black">
      <Text className="text-2xl font-semibold text-black dark:text-white">{tab.name}</Text>
      <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
        {tab.summary}
      </Text>
    </View>
  );
}
