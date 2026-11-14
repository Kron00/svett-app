import { StyleSheet, View } from "react-native";

import { useColor } from "../design/hooks";

/**
 * A field's edge, drawn over it so focusing changes no layout. Unfocused it is a
 * hairline, which keeps a field visible on a sheet's glass as well as on a card.
 */
export function FieldOutline({ focused }: { readonly focused: boolean }) {
  const separator = useColor("separator");
  const accent = useColor("accent");
  return (
    <View
      className="absolute inset-0 rounded-field"
      style={{
        pointerEvents: "none",
        borderWidth: focused ? 2 : StyleSheet.hairlineWidth,
        borderColor: focused ? accent : separator,
      }}
    />
  );
}
