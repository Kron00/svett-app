import { StyleSheet, View } from "react-native";

import { useColor } from "../design/hooks";

/**
 * A field's edge, drawn over it so focusing changes no layout. Unfocused it is a
 * hairline, which keeps a field visible on a sheet's glass as well as on a card.
 * A field with a problem keeps a red edge until it is focused.
 */
export function FieldOutline({
  focused,
  problem = false,
}: {
  readonly focused: boolean;
  readonly problem?: boolean;
}) {
  const separator = useColor("separator");
  const accent = useColor("accent");
  const destructive = useColor("destructive");
  return (
    <View
      className="absolute inset-0 rounded-field"
      style={{
        pointerEvents: "none",
        borderWidth: focused ? 2 : problem ? 1 : StyleSheet.hairlineWidth,
        borderColor: focused ? accent : problem ? destructive : separator,
      }}
    />
  );
}
