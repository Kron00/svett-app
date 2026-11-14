import { useNavigation } from "@react-navigation/native";

import type { RootNavigation } from "../navigation";
import { ListRow } from "../ui/List";

/** The You tab's way into the svett account. */
export function AccountRow() {
  const navigation = useNavigation<RootNavigation>();
  return (
    <ListRow
      title="Account"
      testID="account-row"
      icon={{ symbol: "person.crop.circle", color: "accent" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("Account") }}
    />
  );
}
