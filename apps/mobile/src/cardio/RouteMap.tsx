import { hideRouteEnds, type LatLng, regionFitting } from "@svett/core";
import { AppleMaps } from "expo-maps";
import { useMemo } from "react";
import { View } from "react-native";

import { useColor } from "../design/hooks";
import type { TintColor } from "../design/tokens";

const MAP_HEIGHT = 280;
const LINE_WIDTH = 5;

const line = (id: string, points: ReadonlyArray<LatLng>, color: string) =>
  points.length > 1 ? [{ id, coordinates: [...points], color, width: LINE_WIDTH }] : [];

/**
 * The route on an Apple Maps map. The stretches hidden from others at each end are
 * drawn grey, so the owner sees what others will not.
 */
export function RouteMap({
  route,
  hideStartM,
  hideEndM,
  color,
  accessibilityLabel,
}: {
  readonly route: ReadonlyArray<LatLng>;
  readonly hideStartM: number;
  readonly hideEndM: number;
  readonly color: TintColor;
  readonly accessibilityLabel: string;
}) {
  const shown = useColor(color);
  const hidden = useColor("tertiary-label");
  const start = useColor("success");
  const end = useColor("destructive");
  const parts = useMemo(
    () => hideRouteEnds(route, hideStartM, hideEndM),
    [route, hideStartM, hideEndM],
  );
  const region = useMemo(() => regionFitting(route), [route]);
  const visibleStart = parts.visible[0];
  const visibleEnd = parts.visible.at(-1);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID="activity-map"
      className="mx-gutter overflow-hidden rounded-card bg-surface"
      style={{ height: MAP_HEIGHT }}
    >
      {region === null ? null : (
        <AppleMaps.View
          style={{ flex: 1 }}
          colorScheme={AppleMaps.MapColorScheme.DARK}
          cameraPosition={{ coordinates: region.center, zoom: region.zoom }}
          polylines={[
            ...line("hidden-start", parts.start, hidden),
            ...line("visible", parts.visible, shown),
            ...line("hidden-end", parts.end, hidden),
          ]}
          circles={[
            ...(visibleStart
              ? [{ id: "start", center: visibleStart, radius: 12, color: start }]
              : []),
            ...(visibleEnd ? [{ id: "end", center: visibleEnd, radius: 12, color: end }] : []),
          ]}
          uiSettings={{
            compassEnabled: false,
            myLocationButtonEnabled: false,
            togglePitchEnabled: false,
          }}
          properties={{
            pointsOfInterest: { including: [] },
            selectionEnabled: false,
          }}
        />
      )}
    </View>
  );
}
