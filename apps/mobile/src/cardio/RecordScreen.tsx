import { useNavigation } from "@react-navigation/native";
import {
  type CardioKind,
  DurationSeconds,
  formatDuration,
  formatKm,
  formatPace,
  isPaused,
  movingMs,
  paceMeasure,
  type Recording,
  recordedDistanceM,
} from "@svett/core";
import { useEffect, useState } from "react";
import { Alert, Linking, ScrollView, View } from "react-native";

import { useStore } from "../checks/store";
import { SPORTS } from "../design/tokens";
import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { SegmentedControl } from "../ui/SegmentedControl";
import { StatTile } from "../ui/StatTile";
import {
  discardRecording,
  finishRecording,
  pauseRecording,
  recording,
  resumeRecording,
  startRecording,
  type StartOutcome,
} from "./recorder";

const KINDS: ReadonlyArray<CardioKind> = ["run", "walk", "hike", "ride"];

/** The current time, moving on every second while `ticking`. A paused clock needs no time. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function Setup() {
  const [kind, setKind] = useState<CardioKind>("run");
  const [problem, setProblem] = useState<Exclude<StartOutcome, { kind: "started" }>>();
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    const outcome = await startRecording(kind);
    setStarting(false);
    setProblem(outcome.kind === "started" ? undefined : outcome);
  };

  return (
    <View className="gap-6 px-gutter">
      <SegmentedControl
        accessibilityLabel="Sport"
        options={KINDS.map((value) => ({ value, label: SPORTS[value].label }))}
        selected={kind}
        onSelect={setKind}
      />
      <AppText tone="secondary">
        svett records your route with GPS, also with the screen locked. Pause when you stop, and
        finish to save it.
      </AppText>
      <Button
        label={`Start ${SPORTS[kind].label.toLowerCase()}`}
        symbol="play.fill"
        disabled={starting}
        onPress={() => void start()}
        testID="record-start"
      />
      {problem?.kind === "denied" ? (
        <View className="gap-3">
          <AppText tone="destructive">
            svett needs your location to record a route. Allow it in Settings.
          </AppText>
          <Button
            label="Open Settings"
            variant="secondary"
            onPress={() => void Linking.openSettings()}
          />
        </View>
      ) : null}
      {problem?.kind === "error" ? (
        <AppText tone="destructive">The recording did not start. {problem.message}</AppText>
      ) : null}
    </View>
  );
}

const confirmDiscard = () =>
  Alert.alert("Discard this recording?", "Its route and time are deleted.", [
    { text: "Keep it", style: "cancel" },
    { text: "Discard", style: "destructive", onPress: () => void discardRecording() },
  ]);

function Live({ current }: { readonly current: Recording }) {
  const navigation = useNavigation<RootNavigation>();
  const paused = isPaused(current);
  const now = useNow(!paused);
  const [finishing, setFinishing] = useState(false);
  const durationS = movingMs(current, now) / 1000;
  const distanceM = recordedDistanceM(current);
  const sport = SPORTS[current.kind];
  const measure = paceMeasure(current.kind);

  const finish = async () => {
    setFinishing(true);
    try {
      const id = await finishRecording();
      navigation.replace("Activity", { id });
    } catch (error) {
      setFinishing(false);
      Alert.alert("The recording was not saved", String(error));
    }
  };

  return (
    <View className="gap-6">
      <View
        className="flex-row flex-wrap items-center gap-2 px-gutter"
        accessible
        accessibilityLabel={`${sport.label}, ${paused ? "paused" : "recording"}`}
        testID="record-status"
      >
        <Icon name={sport.symbol} color={sport.color} size={20} weight="semibold" />
        <AppText variant="headline">{sport.label}</AppText>
        <AppText variant="headline" tone={paused ? "warning" : "success"}>
          {paused ? "Paused" : "Recording"}
        </AppText>
      </View>
      <View className="flex-row flex-wrap gap-3 px-gutter">
        <StatTile
          label="Time"
          value={formatDuration(DurationSeconds.make(durationS))}
          symbol="stopwatch"
          testID="record-time"
        />
        <StatTile
          label="Distance"
          value={formatKm(distanceM)}
          unit="km"
          symbol="point.topleft.down.to.point.bottomright.curvepath"
          testID="record-distance"
        />
        <StatTile
          label={measure.label}
          value={formatPace(current.kind, distanceM, durationS)}
          unit={measure.unit}
          symbol="speedometer"
          testID="record-pace"
        />
      </View>
      <View className="gap-3 px-gutter">
        {paused ? (
          <>
            <Button
              label="Resume"
              symbol="play.fill"
              onPress={() => void resumeRecording()}
              testID="record-resume"
            />
            <Button
              label="Finish and save"
              symbol="flag.checkered"
              variant="secondary"
              disabled={finishing}
              onPress={() => void finish()}
              testID="record-finish"
            />
            <Button
              label="Discard"
              symbol="trash"
              variant="destructive"
              disabled={finishing}
              onPress={confirmDiscard}
              testID="record-discard"
            />
          </>
        ) : (
          <Button
            label="Pause"
            symbol="pause.fill"
            onPress={() => void pauseRecording()}
            testID="record-pause"
          />
        )}
      </View>
    </View>
  );
}

/** Starts a run, walk, hike or ride, and shows it live until it is saved or discarded. */
export function RecordScreen() {
  const current = useStore(recording);
  return (
    <ScrollView
      testID="record-cardio"
      contentInsetAdjustmentBehavior="automatic"
      className="bg-background"
      contentContainerClassName="py-6"
    >
      {current === undefined ? <Setup /> : <Live current={current} />}
    </ScrollView>
  );
}
