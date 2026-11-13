import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

export type RootStackParamList = {
  Tabs: undefined;
  Gallery: { sheet?: "open" } | undefined;
  PhoneChecks: undefined;
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
