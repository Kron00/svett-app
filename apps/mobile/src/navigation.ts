import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

export type RootStackParamList = {
  Tabs: undefined;
  Gallery: { sheet?: "open" } | undefined;
  PhoneChecks: undefined;
  ChatGPT: undefined;
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
