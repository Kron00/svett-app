import { projectRoute, type RoutePoint } from "@svett/core";
import { useState } from "react";
import { View } from "react-native";
import Svg, { Polyline } from "react-native-svg";

import { useColor } from "../design/hooks";
import { AppText } from "../ui/AppText";

/**
 * The visible stretch of a route, drawn as its shape. The ends were cut off on the server,
 * so nothing here can show where the route started or finished.
 */
export function RouteShape({
  route,
  height = 180,
  testID,
}: {
  readonly route: ReadonlyArray<ReadonlyArray<RoutePoint>>;
  readonly height?: number;
  readonly testID?: string;
}) {
  const [width, setWidth] = useState(0);
  const stroke = useColor("accent");
  const lines = projectRoute(route, width, height);
  if (route.length === 0) {
    return (
      <View
        testID={testID}
        accessible
        accessibilityLabel="No route to show. The hidden start and end cover all of it."
        className="items-center justify-center rounded-card bg-control p-4"
      >
        <AppText tone="secondary" className="text-center">
          The hidden start and end cover the whole route.
        </AppText>
      </View>
    );
  }
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Route map. The start and end are hidden."
      className="overflow-hidden rounded-card bg-control"
      style={{ height }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Svg width={width} height={height}>
        {lines.map((points) => (
          <Polyline
            key={points}
            points={points}
            fill="none"
            stroke={stroke}
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </Svg>
    </View>
  );
}
