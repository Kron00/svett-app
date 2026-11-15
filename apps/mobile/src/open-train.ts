import type { RootNavigation } from "./navigation";

/** Opens the Train tab, where every kind of workout starts, from any screen. */
export const openTrain = (navigation: Pick<RootNavigation, "navigate">) =>
  navigation.navigate("Tabs", { screen: "Train" });
