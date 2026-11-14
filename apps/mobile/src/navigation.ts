import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

export type RootStackParamList = {
  Tabs: undefined;
  Gallery: { sheet?: "open" } | undefined;
  PhoneChecks: undefined;
  RecordCardio: undefined;
  Activity: { id: string };
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
