import { useNavigation } from "@react-navigation/native";
import { SymbolView } from "expo-symbols";
import { Pressable, Text } from "react-native";

import type { RootNavigation } from "./navigation";

export function PhoneChecksRow() {
  const navigation = useNavigation<RootNavigation>();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => navigation.navigate("PhoneChecks")}
      className="mt-6 flex-row items-center gap-3 rounded-xl bg-neutral-100 px-4 py-3 active:opacity-70 dark:bg-neutral-900"
    >
      <SymbolView name="checklist" tintColor="#E11D48" size={20} />
      <Text className="text-base text-black dark:text-white">Phone checks</Text>
      <SymbolView name="chevron.right" tintColor="#A3A3A3" size={14} />
    </Pressable>
  );
}
