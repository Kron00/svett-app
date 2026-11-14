import { hideRouteEnds, type RouteLines, regionFitting } from "@svett/core";
import { AppleMaps } from "expo-maps";
import { useMemo } from "react";
import { View } from "react-native";

import { useColor } from "../design/hooks";
import type { TintColor } from "../design/tokens";

const MAP_HEIGHT = 280;
const LINE_WIDTH = 5;

const polylines = (id: string, lines: RouteLines, color: string) =>
  lines.map((line, index) => ({
    id: `${id}-${index}`,
    coordinates: line.map(({ latitude, longitude }) => ({ latitude, longitude })),
    color,
    width: LINE_WIDTH,
  }));

/**
 * The owner's own route on an Apple Maps map, one line for each stretch between
 * pauses. The stretches hidden from others at each end are drawn grey, so the owner
 * sees what others will not. Anyone else's view goes through `sharedTrack`.
 */
export function RouteMap({
  lines,
  hideStartM,
  hideEndM,
  color,
  accessibilityLabel,
}: {
  readonly lines: RouteLines;
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
    () => hideRouteEnds(lines, hideStartM, hideEndM),
    [lines, hideStartM, hideEndM],
  );
  const region = useMemo(() => regionFitting(lines.flat()), [lines]);
  const visibleStart = parts.visible[0]?.[0];
  const visibleEnd = parts.visible.at(-1)?.at(-1);

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
            ...polylines("hidden-start", parts.start, hidden),
            ...polylines("visible", parts.visible, shown),
            ...polylines("hidden-end", parts.end, hidden),
          ]}
          circles={[
            ...(visibleStart
              ? [
                  {
                    id: "start",
                    center: { latitude: visibleStart.latitude, longitude: visibleStart.longitude },
                    radius: 12,
                    color: start,
                  },
                ]
              : []),
            ...(visibleEnd
              ? [
                  {
                    id: "end",
                    center: { latitude: visibleEnd.latitude, longitude: visibleEnd.longitude },
                    radius: 12,
                    color: end,
                  },
                ]
              : []),
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
