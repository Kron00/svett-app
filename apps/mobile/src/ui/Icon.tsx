import { SymbolView } from "expo-symbols";

import { useColor, useSymbolSize } from "../design/hooks";
import type { ColorToken, SymbolName } from "../design/tokens";

/** A decorative SF Symbol. The control around it carries the accessibility label. */
export function Icon({
  name,
  color = "label",
  size = 17,
  weight = "regular",
}: {
  readonly name: SymbolName;
  readonly color?: ColorToken;
  /** Points at the default text size. It grows with Dynamic Type. */
  readonly size?: number;
  readonly weight?: "regular" | "semibold" | "bold";
}) {
  const scaled = useSymbolSize(size);
  return (
    <SymbolView
      name={name}
      tintColor={useColor(color)}
      size={scaled}
      weight={weight}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: scaled, height: scaled }}
    />
  );
}
