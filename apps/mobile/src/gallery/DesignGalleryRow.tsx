import { useNavigation } from "@react-navigation/native";

import type { RootNavigation } from "../navigation";
import { ListRow } from "../ui/List";

/** The You tab's way into the design gallery. */
export function DesignGalleryRow() {
  const navigation = useNavigation<RootNavigation>();
  return (
    <ListRow
      title="Design gallery"
      testID="design-gallery-row"
      icon={{ symbol: "swatchpalette.fill", color: "accent" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("Gallery") }}
    />
  );
}
