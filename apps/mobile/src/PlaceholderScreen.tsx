import type { ReactNode } from "react";
import { View } from "react-native";

import type { Tab } from "./tabs";
import { AppText } from "./ui/AppText";

export function PlaceholderScreen({
  tab,
  children,
}: {
  readonly tab: Tab;
  readonly children?: ReactNode;
}) {
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-background px-8">
      <AppText tone="secondary" className="text-center">
        {tab.summary}
      </AppText>
      {children}
    </View>
  );
}
