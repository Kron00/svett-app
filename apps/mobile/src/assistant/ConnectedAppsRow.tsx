import { useNavigation } from "@react-navigation/native";

import type { RootNavigation } from "../navigation";
import { ListRow } from "../ui/List";

/** The You tab's way into the apps connected to the svett account, such as ChatGPT. */
export function ConnectedAppsRow() {
  const navigation = useNavigation<RootNavigation>();
  return (
    <ListRow
      title="Connected apps"
      testID="connected-apps-row"
      icon={{ symbol: "link", color: "accent" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("ConnectedApps") }}
    />
  );
}
