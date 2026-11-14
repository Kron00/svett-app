import { useNavigation } from "@react-navigation/native";

import type { RootNavigation } from "../navigation";
import { ListRow } from "../ui/List";

/** The Train tab's way into the exercise library. */
export function ExerciseLibraryRow() {
  const navigation = useNavigation<RootNavigation>();
  return (
    <ListRow
      title="Exercises"
      subtitle="Search the library and add your own"
      testID="exercise-library-row"
      icon={{ symbol: "dumbbell.fill", color: "sport-strength" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("Exercises") }}
    />
  );
}
