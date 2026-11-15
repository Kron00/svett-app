import { useNavigation } from "@react-navigation/native";

import type { RootNavigation } from "../navigation";
import { useWorkoutSettings } from "../settings/store";
import { ListRow } from "../ui/List";

/** The You tab's way into units, RPE, and your plates and bars. */
export function WorkoutSettingsRow() {
  const navigation = useNavigation<RootNavigation>();
  const { unit } = useWorkoutSettings();
  return (
    <ListRow
      title="Units and plates"
      value={unit}
      testID="workout-settings-row"
      icon={{ symbol: "scalemass.fill", color: "sport-strength" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("WorkoutSettings") }}
    />
  );
}
