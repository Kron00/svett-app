import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { CompositeNavigationProp, NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

export type TabParamList = {
  Home: undefined;
  Train: undefined;
  Progress: undefined;
  /** `ask` is a question svett://coach?ask=... sends as soon as the coach is ready. */
  Coach: { ask?: string | undefined } | undefined;
  You: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  Gallery: { sheet?: "open" } | undefined;
  PhoneChecks: undefined;
  ChatGPT: undefined;
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

export type CoachNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<TabParamList, "Coach">,
  RootNavigation
>;
