import { type ParamListBase, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { View } from "react-native";

import { ListRow, ListSection } from "../ui/List";

/** The You tab's way into the design gallery. */
export function DesignGalleryRow() {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  return (
    <View className="mt-6 self-stretch">
      <ListSection>
        <ListRow
          title="Design gallery"
          testID="design-gallery-row"
          icon={{ symbol: "swatchpalette.fill", color: "accent" }}
          trailing={{ type: "chevron", onPress: () => navigation.navigate("Gallery") }}
        />
      </ListSection>
    </View>
  );
}
