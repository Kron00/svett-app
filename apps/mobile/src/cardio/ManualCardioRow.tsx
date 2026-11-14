import { useNavigation } from "@react-navigation/native";

import type { RootNavigation } from "../navigation";
import { ListRow } from "../ui/List";

/** The Train tab's way into entering a workout svett did not record. */
export function ManualCardioRow() {
  const navigation = useNavigation<RootNavigation>();
  return (
    <ListRow
      title="Add cardio by hand"
      subtitle="Sport, start, duration and distance"
      testID="manual-cardio-row"
      icon={{ symbol: "square.and.pencil", color: "sport-other" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("ManualCardio") }}
    />
  );
}
