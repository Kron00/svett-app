import { useNavigation } from "@react-navigation/native";

import type { RootNavigation } from "../navigation";
import { ListRow } from "../ui/List";

/** The You tab's way into export and import. */
export function DataRow() {
  const navigation = useNavigation<RootNavigation>();
  return (
    <ListRow
      title="Export and import"
      testID="data-row"
      icon={{ symbol: "arrow.up.arrow.down", color: "accent" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("Data") }}
    />
  );
}
