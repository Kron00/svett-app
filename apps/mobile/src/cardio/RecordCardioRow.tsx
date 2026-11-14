import { useNavigation } from "@react-navigation/native";
import { isPaused } from "@svett/core";

import { SPORTS } from "../design/tokens";
import type { RootNavigation } from "../navigation";
import { ListRow } from "../ui/List";
import { useRecording } from "./recorder";

/** The Train tab's way into recording cardio, and back to a recording in progress. */
export function RecordCardioRow() {
  const navigation = useNavigation<RootNavigation>();
  const { current } = useRecording();
  const subtitle =
    current === undefined
      ? "Run, walk, hike or ride with GPS"
      : `${SPORTS[current.kind].label} ${isPaused(current) ? "paused" : "recording"}`;
  return (
    <ListRow
      title="Record cardio"
      subtitle={subtitle}
      testID="record-cardio-row"
      icon={{ symbol: SPORTS[current?.kind ?? "run"].symbol, color: "sport-run" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("RecordCardio") }}
    />
  );
}
