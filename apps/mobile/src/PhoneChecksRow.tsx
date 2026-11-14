import { useNavigation } from "@react-navigation/native";

import type { RootNavigation } from "./navigation";
import { ListRow } from "./ui/List";

/** The You tab's way into Phone checks. */
export function PhoneChecksRow() {
  const navigation = useNavigation<RootNavigation>();
  return (
    <ListRow
      title="Phone checks"
      testID="phone-checks-row"
      icon={{ symbol: "checklist", color: "accent" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("PhoneChecks") }}
    />
  );
}
