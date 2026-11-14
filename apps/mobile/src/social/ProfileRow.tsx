import { useNavigation } from "@react-navigation/native";

import type { RootNavigation } from "../navigation";
import { ListRow } from "../ui/List";

/** The You tab's way to your profile, follows and requests. */
export function ProfileRow() {
  const navigation = useNavigation<RootNavigation>();
  return (
    <ListRow
      title="Profile"
      testID="profile-row"
      icon={{ symbol: "person.2.fill", color: "accent" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("OwnProfile") }}
    />
  );
}
