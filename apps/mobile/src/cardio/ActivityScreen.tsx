import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  type ActivityDetail,
  ActivityId,
  ActivityRepository,
  type ActivitySample,
  type ActivitySource,
  type CardioKind,
  CardioKind as CardioKindSchema,
  elevationProfile,
  formatClimbM,
  formatDuration,
  formatKm,
  formatPace,
  heartRateSummary,
  paceMeasure,
  type RouteLines,
  sourceName,
  trackParts,
} from "@svett/core";
import { Effect, Option, Schema } from "effect";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { appDatabase } from "../data/database";
import { SPORTS } from "../design/tokens";
import type { RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Chart, ChartGrid, ChartLine } from "../ui/Chart";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection, SectionHeader } from "../ui/List";
import { SegmentedControl } from "../ui/SegmentedControl";
import { StatTile } from "../ui/StatTile";
import { RouteMap } from "./RouteMap";

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | {
      readonly kind: "found";
      readonly detail: ActivityDetail;
      readonly samples: ReadonlyArray<ActivitySample>;
      readonly sources: ReadonlyArray<ActivitySource>;
    };

const HIDE_OPTIONS = [
  { value: "0", label: "Off" },
  { value: "200", label: "200 m" },
  { value: "500", label: "500 m" },
  { value: "1000", label: "1 km" },
] as const;
type HideOption = (typeof HIDE_OPTIONS)[number]["value"];

const decodeId = Schema.decodeUnknownOption(ActivityId);
const MISSING: Loaded = { kind: "missing" };
const isCardio = Schema.is(CardioKindSchema);

const repository = <A, E>(
  body: (activities: typeof ActivityRepository.Service) => Effect.Effect<A, E>,
) => appDatabase().runPromise(Effect.flatMap(Effect.service(ActivityRepository), body));

const fetchActivity = (id: ActivityId): Promise<Loaded> =>
  repository((activities) =>
    Effect.gen(function* () {
      const detail = yield* activities.get(id);
      if (Option.isNone(detail)) return MISSING;
      const track = detail.value.track;
      const samples = track === null ? [] : yield* activities.samples(track.id);
      const sources = yield* activities.sources(id);
      return { kind: "found", detail: detail.value, samples, sources } as const;
    }),
  ).catch(() => MISSING);

function useActivity(rawId: string) {
  const id = useMemo(() => decodeId(rawId), [rawId]);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    if (Option.isNone(id)) return;
    let current = true;
    void fetchActivity(id.value).then((next) => {
      if (current) setLoaded(next);
    });
    return () => {
      current = false;
    };
  }, [id]);
  const reload = useCallback(async () => {
    if (Option.isSome(id)) setLoaded(await fetchActivity(id.value));
  }, [id]);
  return { loaded: Option.isNone(id) ? MISSING : loaded, reload };
}

function Splits({
  kind,
  splits,
}: {
  readonly kind: CardioKind;
  readonly splits: ReturnType<typeof trackParts>["splits"];
}) {
  const unit = paceMeasure(kind).unit;
  return (
    <View testID="activity-splits">
      <ListSection header="Splits">
        {splits.map((split, index) => {
          const full = split.distanceM >= 1000;
          return (
            <ListRow
              key={split.id}
              title={full ? `Kilometre ${index + 1}` : `Last ${formatKm(split.distanceM)} km`}
              subtitle={formatDuration(split.durationS)}
              value={`${formatPace(kind, split.distanceM, split.durationS)} ${unit}`}
            />
          );
        })}
      </ListSection>
    </View>
  );
}

function Elevation({ lines }: { readonly lines: RouteLines }) {
  const profile = useMemo(() => elevationProfile(lines), [lines]);
  if (profile.length === 0) {
    return (
      <AppText tone="secondary" className="px-gutter">
        This route has no altitude.
      </AppText>
    );
  }
  const altitudes = profile.map((point) => point.altitudeM);
  const low = Math.round(Math.min(...altitudes));
  const high = Math.round(Math.max(...altitudes));
  return (
    <View className="mx-gutter rounded-card bg-surface p-4" testID="activity-elevation">
      <Chart
        points={profile.map((point, index) => ({
          key: String(index),
          label: index % 3 === 2 ? `${formatKm(point.distanceM)} km` : "",
          value: point.altitudeM,
        }))}
        formatValue={(value) => `${Math.round(value)} m`}
        accessibilityLabel={`Elevation along the route, from ${low} to ${high} metres`}
      >
        <ChartGrid />
        <ChartLine color="sport-hike" />
      </Chart>
    </View>
  );
}

function Sources({
  activity,
  linked,
}: {
  readonly activity: ActivityDetail["activity"];
  readonly linked: ReadonlyArray<ActivitySource>;
}) {
  if (activity.source === "svett" && linked.length === 0) return null;
  return (
    <View testID="activity-sources">
      <ListSection
        header="Sources"
        footer={
          linked.length > 0
            ? "One workout from more than one source. Neither imports it again."
            : undefined
        }
      >
        <ListRow
          key="first"
          title={
            activity.source === "svett"
              ? "Logged in svett"
              : `From ${sourceName(activity.source)}`
          }
          value="First"
        />
        {linked.map((link) => (
          <ListRow key={link.id} title={`From ${sourceName(link.source)}`} value="Linked" />
        ))}
      </ListSection>
    </View>
  );
}

type Props = NativeStackScreenProps<RootStackParamList, "Activity">;

/** An activity: its map, numbers, splits and elevation for cardio, and its heart rate and sources. */
export function ActivityScreen({ route, navigation }: Props) {
  const { loaded, reload } = useActivity(route.params.id);
  const title = loaded.kind === "found" ? loaded.detail.activity.title : "";
  useLayoutEffect(() => navigation.setOptions({ title }), [navigation, title]);

  const parts = useMemo(() => trackParts(loaded.kind === "found" ? loaded.samples : []), [loaded]);
  const heart = useMemo(
    () => heartRateSummary(loaded.kind === "found" ? loaded.samples : []),
    [loaded],
  );

  if (loaded.kind === "loading") return <View className="flex-1 bg-background" />;
  if (loaded.kind === "missing") {
    return (
      <View className="flex-1 justify-center bg-background">
        <EmptyState
          symbol="questionmark.circle"
          title="Activity not found"
          message="It may have been deleted."
        />
      </View>
    );
  }

  const { activity, track, exercises } = loaded.detail;
  const kind = activity.kind;
  const cardio = isCardio(kind) ? kind : undefined;
  const sport = SPORTS[kind];
  const distanceM = track?.distanceM ?? (cardio ? 0 : null);
  const hidden = String(track?.hideStartM ?? 0) as HideOption;
  const sets = exercises.reduce((total, exercise) => total + exercise.sets.length, 0);
  const hasRoute = cardio !== undefined && parts.route.length > 0 && track !== null;

  const hide = async (value: HideOption) => {
    if (track === null) return;
    const metres = Number(value);
    await repository((activities) =>
      activities.updateTrack(track.id, { hideStartM: metres, hideEndM: metres }),
    );
    await reload();
  };

  return (
    <ScrollView
      testID="activity"
      contentInsetAdjustmentBehavior="automatic"
      className="bg-background"
      contentContainerClassName="gap-6 py-4"
    >
      <View className="flex-row flex-wrap items-center gap-2 px-gutter">
        <Icon name={sport.symbol} color={sport.color} weight="semibold" />
        <AppText variant="headline">{sport.label}</AppText>
        <AppText variant="subheadline" tone="secondary">
          {new Date(activity.startedAt).toLocaleString()}
        </AppText>
      </View>
      {hasRoute ? (
        <RouteMap
          lines={parts.lines}
          hideStartM={track.hideStartM}
          hideEndM={track.hideEndM}
          color={sport.color}
          accessibilityLabel={`Map of the ${sport.label.toLowerCase()} route, ${formatKm(distanceM ?? 0)} kilometres`}
        />
      ) : null}
      <View className="flex-row flex-wrap gap-3 px-gutter">
        {distanceM === null ? null : (
          <StatTile
            label="Distance"
            value={formatKm(distanceM)}
            unit="km"
            testID="activity-distance"
          />
        )}
        <StatTile
          label={cardio ? "Moving time" : "Time"}
          value={formatDuration(activity.durationS)}
          testID="activity-time"
        />
        {cardio === undefined ? null : (
          <>
            <StatTile
              label={paceMeasure(cardio).label}
              value={formatPace(cardio, distanceM ?? 0, activity.durationS)}
              unit={paceMeasure(cardio).unit}
              testID="activity-pace"
            />
            <StatTile
              label="Climb"
              value={formatClimbM(track?.elevationGainM ?? null)}
              unit="m"
              testID="activity-climb"
            />
          </>
        )}
        {sets > 0 ? <StatTile label="Sets" value={String(sets)} testID="activity-sets" /> : null}
        {heart === null ? null : (
          <>
            <StatTile
              label="Average heart rate"
              value={String(heart.averageBpm)}
              unit="bpm"
              symbol="heart.fill"
              color="destructive"
              testID="activity-heart-average"
            />
            <StatTile
              label="Max heart rate"
              value={String(heart.maxBpm)}
              unit="bpm"
              symbol="heart.fill"
              color="destructive"
              testID="activity-heart-max"
            />
          </>
        )}
      </View>
      {activity.notes === "" ? null : (
        <AppText className="px-gutter" testID="activity-notes">
          {activity.notes}
        </AppText>
      )}
      <Sources activity={activity} linked={loaded.sources} />
      {cardio !== undefined && parts.splits.length > 0 ? (
        <Splits kind={cardio} splits={parts.splits} />
      ) : null}
      {hasRoute ? (
        <View className="gap-3">
          <SectionHeader title="Elevation" />
          <Elevation lines={parts.lines} />
        </View>
      ) : null}
      {hasRoute ? (
        <View className="gap-3 px-gutter" testID="activity-hide">
          <AppText variant="title3" accessibilityRole="header">
            Hide start and end
          </AppText>
          <SegmentedControl
            accessibilityLabel="Hide start and end"
            options={HIDE_OPTIONS}
            selected={hidden}
            onSelect={(value) => void hide(value)}
          />
          <AppText variant="footnote" tone="secondary">
            Others will not see the grey stretch at each end of the map, so it does not show where
            you start or stop.
          </AppText>
        </View>
      ) : null}
    </ScrollView>
  );
}
