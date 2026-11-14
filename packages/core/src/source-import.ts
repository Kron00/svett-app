import { Result } from "effect";

import { activityTitle, DEFAULT_HIDE_M, elevationGainM, splitsOf } from "./cardio.ts";
import { DurationSeconds } from "./duration.ts";
import { pathLengthM } from "./geo.ts";
import { GpxError, type GpxTrack } from "./gpx.ts";
import type { HealthWorkout } from "./health-export.ts";
import { contentFingerprint, importedId } from "./ids.ts";
import { CardioKind } from "./recording.ts";
import {
  type Activity,
  ActivityId,
  type ActivityKind,
  type ActivitySample,
  ActivitySampleId,
  type ActivitySource,
  ActivitySourceId,
  type ActivityTrack,
  ActivityTrackId,
  EpochMillis,
  Fingerprint,
  type ImportBatchId,
  type ImportedSource,
  type Source,
  SourceIdentity,
} from "./schema.ts";
import { TABLES } from "./table.ts";
import type { TableKey, TableRows } from "./transfer.ts";

export interface TimedRoutePoint {
  /** Which stretch of the route it is on, counting from 0, as a GPX track segment. */
  readonly segment: number;
  readonly recordedAt: EpochMillis;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeM: number | null;
}

export interface HeartRateReading {
  readonly recordedAt: EpochMillis;
  readonly bpm: number;
}

/** A workout from Apple Health or a GPX file, read and checked, before it is saved. */
export interface SourceWorkout {
  readonly source: ImportedSource;
  /** Who it is in its source: for Health its source, start and type, for GPX its first point's time. */
  readonly identity: SourceIdentity;
  readonly fingerprint: Fingerprint;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly startedAt: EpochMillis;
  readonly endedAt: EpochMillis;
  readonly durationS: DurationSeconds;
  readonly distanceM: number | null;
  readonly energyKcal: number | null;
  readonly route: ReadonlyArray<TimedRoutePoint>;
  readonly heartRate: ReadonlyArray<HeartRateReading>;
}

const isCardio = (kind: ActivityKind) =>
  (CardioKind.literals as ReadonlyArray<string>).includes(kind);

const HEALTH_KIND: Readonly<Record<string, ActivityKind>> = {
  HKWorkoutActivityTypeRunning: "run",
  HKWorkoutActivityTypeCycling: "ride",
  HKWorkoutActivityTypeHandCycling: "ride",
  HKWorkoutActivityTypeWalking: "walk",
  HKWorkoutActivityTypeHiking: "hike",
  HKWorkoutActivityTypeTraditionalStrengthTraining: "strength",
  HKWorkoutActivityTypeFunctionalStrengthTraining: "strength",
};

/** HKWorkoutActivityTypeHighIntensityIntervalTraining reads "High intensity interval training". */
export const healthActivityName = (activityType: string): string => {
  const words = activityType
    .replace(/^HKWorkoutActivityType/, "")
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** `sourceTitle` is the title the source itself gave, so renaming a GPX track changes it. */
const fingerprintOf = (
  workout: Omit<SourceWorkout, "fingerprint" | "title">,
  sourceTitle: string | null,
) =>
  Fingerprint.make(
    contentFingerprint({
      title: sourceTitle,
      kind: workout.kind,
      startedAt: workout.startedAt,
      endedAt: workout.endedAt,
      durationS: workout.durationS,
      distanceM: workout.distanceM,
      energyKcal: workout.energyKcal,
      route: workout.route,
      heartRate: workout.heartRate,
    }),
  );

/**
 * Track points with a time, each on its segment. A point without a time takes the time
 * of the point before it.
 */
const routeOf = (track: GpxTrack | null, fallback: number): Array<TimedRoutePoint> => {
  let last = fallback;
  return (track?.segments ?? []).flatMap((points, segment) =>
    points.map((point) => {
      last = point.recordedAt ?? last;
      return {
        segment,
        recordedAt: EpochMillis.make(last),
        latitude: point.latitude,
        longitude: point.longitude,
        altitudeM: point.altitudeM,
      };
    }),
  );
};

/** The route's points, one list for each segment, so nothing is drawn or counted across a gap. */
const stretchesOf = (route: ReadonlyArray<TimedRoutePoint>): Array<Array<TimedRoutePoint>> => {
  const stretches: Array<Array<TimedRoutePoint>> = [];
  for (const point of route) {
    const stretch = stretches.at(-1);
    if (stretch !== undefined && stretch[0]!.segment === point.segment) stretch.push(point);
    else stretches.push([point]);
  }
  return stretches;
};

/** The length of each segment added up, or null when no segment has two points. */
const routeDistance = (route: ReadonlyArray<TimedRoutePoint>) => {
  const stretches = stretchesOf(route).filter((stretch) => stretch.length > 1);
  return stretches.length === 0
    ? null
    : stretches.reduce((total, stretch) => total + pathLengthM(stretch), 0);
};

/** A Health workout, with its route when the export holds one. */
export const fromHealthWorkout = (
  workout: HealthWorkout,
  route: GpxTrack | null,
): SourceWorkout => {
  const kind = HEALTH_KIND[workout.activityType] ?? "other";
  const points = routeOf(route, workout.startedAt);
  const content = {
    source: "apple_health" as const,
    identity: SourceIdentity.make(
      `${new Date(workout.startedAt).toISOString()} ${workout.activityType} ${workout.sourceName}`,
    ),
    kind,
    startedAt: EpochMillis.make(workout.startedAt),
    endedAt: EpochMillis.make(workout.endedAt),
    durationS: DurationSeconds.make(workout.durationS),
    distanceM: workout.distanceM ?? routeDistance(points),
    energyKcal: workout.energyKcal,
    route: points,
    heartRate: workout.heartRate.map((reading) => ({
      recordedAt: EpochMillis.make(reading.recordedAt),
      bpm: reading.bpm,
    })),
  };
  return {
    ...content,
    // Health gives a workout no title of its own. svett names it from its type and hour.
    fingerprint: fingerprintOf(content, null),
    title:
      isCardio(kind) || kind === "strength"
        ? activityTitle(kind, workout.localHour)
        : healthActivityName(workout.activityType),
  };
};

const GPX_KIND: ReadonlyArray<readonly [RegExp, ActivityKind]> = [
  [/run/i, "run"],
  [/ride|cycl|bik/i, "ride"],
  [/hik/i, "hike"],
  [/walk/i, "walk"],
];

/**
 * A GPX file as one workout. Its identity is its first point's time, so the same file
 * imports once. Its duration is the time spent in its segments, as a recording's is,
 * because a gap between two segments is a pause. `hourOf` gives the phone's local hour
 * of a time, for its title.
 */
export const fromGpx = (
  track: GpxTrack,
  hourOf: (at: number) => number,
): Result.Result<SourceWorkout, GpxError> => {
  let first: number | undefined;
  let last = Number.NEGATIVE_INFINITY;
  const heartRate: Array<HeartRateReading> = [];
  for (const points of track.segments) {
    for (const point of points) {
      if (point.recordedAt === null) continue;
      first ??= point.recordedAt;
      // A loop, not Math.max(...times), which runs out of stack on a long track.
      if (point.recordedAt > last) last = point.recordedAt;
      const bpm = point.heartRate === null ? Number.NaN : Math.round(point.heartRate);
      if (bpm >= 20 && bpm <= 260) {
        heartRate.push({ recordedAt: EpochMillis.make(point.recordedAt), bpm });
      }
    }
  }
  if (first === undefined) {
    return Result.fail(
      new GpxError({
        message: "This GPX file has no times, so svett cannot tell when it happened.",
      }),
    );
  }
  const kind = GPX_KIND.find(([pattern]) => pattern.test(track.type ?? ""))?.[1] ?? "other";
  const route = routeOf(track, first);
  const movingMs = stretchesOf(route).reduce(
    (total, stretch) => total + stretch.at(-1)!.recordedAt - stretch[0]!.recordedAt,
    0,
  );
  const content = {
    source: "gpx" as const,
    identity: SourceIdentity.make(new Date(first).toISOString()),
    kind,
    startedAt: EpochMillis.make(first),
    endedAt: EpochMillis.make(last),
    durationS: DurationSeconds.make(movingMs / 1000),
    distanceM: routeDistance(route),
    energyKcal: null,
    route,
    heartRate,
  };
  return Result.succeed({
    ...content,
    fingerprint: fingerprintOf(content, track.name),
    title: track.name ?? activityTitle(kind, hourOf(first)),
  });
};

/** An activity here, as the duplicate check sees it. */
export type LocalActivity = Pick<
  Activity,
  "id" | "kind" | "title" | "startedAt" | "durationS" | "source" | "sourceId" | "fingerprint"
>;

export type LocalLink = Pick<ActivitySource, "activityId" | "source" | "sourceId" | "fingerprint">;

export type SourcePlanItem =
  | { readonly status: "new"; readonly key: string; readonly workout: SourceWorkout }
  | { readonly status: "unchanged"; readonly key: string; readonly workout: SourceWorkout }
  | {
      readonly status: "changed";
      readonly key: string;
      readonly workout: SourceWorkout;
      readonly local: ActivityId;
      /** True when the workout is linked to an activity from another source, not its own. */
      readonly linked: boolean;
    }
  | {
      readonly status: "duplicate";
      readonly key: string;
      readonly workout: SourceWorkout;
      /** The activity from another source whose time it overlaps most. */
      readonly match: LocalActivity;
    };

export interface SourcePlan {
  readonly items: ReadonlyArray<SourcePlanItem>;
  readonly added: number;
  readonly duplicates: ReadonlyArray<Extract<SourcePlanItem, { status: "duplicate" }>>;
  readonly changed: ReadonlyArray<Extract<SourcePlanItem, { status: "changed" }>>;
  readonly unchanged: number;
  /** Workouts that share a source, start and type with another in the file, with other content. */
  readonly collisions: ReadonlyArray<SourcePlanItem>;
}

/** What the person chose in the preview. Duplicates link unless kept apart, and changed ones keep yours unless taken. */
export interface SourceChoices {
  readonly take: ReadonlyArray<string>;
  readonly keepBoth: ReadonlyArray<string>;
}

export const NO_CHOICES: SourceChoices = { take: [], keepBoth: [] };

export const sourceKey = (workout: Pick<SourceWorkout, "source" | "identity">): string =>
  `${workout.source}:${workout.identity}`;

export const sourceActivityId = (workout: Pick<SourceWorkout, "source" | "identity">) =>
  ActivityId.make(importedId(TABLES.activity.name, workout.source, workout.identity));

/** An identity already saved here, as an activity of its own or as a link. */
export type SavedIdentity = Pick<LocalLink, "source" | "fingerprint"> & {
  readonly sourceId: SourceIdentity | null;
};

/** " #2", " #3" and so on, as `distinctIdentities` adds them. */
const SUFFIX = / #([2-9]|[1-9]\d+)$/;

/**
 * Gives workouts in the file that share an identity, but not their content, identities
 * of their own. Number 1 is the identity itself and number n adds " #n". A workout whose
 * content matches one saved under the identity or a numbered one keeps that number, so
 * adding or removing another workout with the same start changes no one's ID. The rest
 * take, in fingerprint order, the saved numbers no workout in the file matched, so a
 * changed workout shows as changed, and then numbers after every saved one. Copies with
 * the same content are one workout.
 */
export const distinctIdentities = (
  incoming: ReadonlyArray<SourceWorkout>,
  saved: ReadonlyArray<SavedIdentity> = [],
): { readonly workouts: ReadonlyArray<SourceWorkout>; readonly collided: ReadonlySet<string> } => {
  const groups = new Map<string, Map<Fingerprint, SourceWorkout>>();
  for (const workout of incoming) {
    const key = sourceKey(workout);
    const group = groups.get(key) ?? new Map<Fingerprint, SourceWorkout>();
    if (!group.has(workout.fingerprint)) group.set(workout.fingerprint, workout);
    groups.set(key, group);
  }
  // The fingerprint saved under each number of each identity.
  const numbered = new Map<string, Map<number, Fingerprint | null>>();
  const remember = (key: string, number: number, fingerprint: Fingerprint | null) => {
    const slots = numbered.get(key) ?? new Map<number, Fingerprint | null>();
    slots.set(number, fingerprint);
    numbered.set(key, slots);
  };
  for (const { source, sourceId, fingerprint } of saved) {
    if (sourceId === null) continue;
    remember(`${source}:${sourceId}`, 1, fingerprint);
    const suffix = SUFFIX.exec(sourceId);
    if (suffix !== null) {
      remember(`${source}:${sourceId.slice(0, suffix.index)}`, Number(suffix[1]), fingerprint);
    }
  }
  const byFingerprint = (a: SourceWorkout, b: SourceWorkout) =>
    a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
  const workouts: Array<SourceWorkout> = [];
  const collided = new Set<string>();
  for (const [key, group] of groups) {
    const ordered = [...group.values()].sort(byFingerprint);
    const slots = numbered.get(key) ?? new Map<number, Fingerprint | null>();
    const assigned = new Map<number, SourceWorkout>();
    const unmatched: Array<SourceWorkout> = [];
    for (const workout of ordered) {
      const slot = [...slots].find(
        ([number, fingerprint]) => fingerprint === workout.fingerprint && !assigned.has(number),
      );
      if (slot === undefined) unmatched.push(workout);
      else assigned.set(slot[0], workout);
    }
    const free = [...slots.keys()].filter((number) => !assigned.has(number)).sort((a, b) => a - b);
    let next = [...slots.keys()].reduce((highest, number) => Math.max(highest, number), 0) + 1;
    for (const workout of unmatched) assigned.set(free.shift() ?? next++, workout);
    for (const [number, workout] of [...assigned].sort(([a], [b]) => a - b)) {
      const distinct =
        number === 1
          ? workout
          : { ...workout, identity: SourceIdentity.make(`${workout.identity} #${number}`) };
      workouts.push(distinct);
      if (ordered.length > 1) collided.add(sourceKey(distinct));
    }
  }
  return { workouts, collided };
};

const overlapMs = (local: LocalActivity, workout: SourceWorkout) =>
  Math.min(local.startedAt + local.durationS * 1000, workout.endedAt) -
  Math.max(local.startedAt, workout.startedAt);

const newestFirst = (a: SourcePlanItem, b: SourcePlanItem) =>
  b.workout.startedAt - a.workout.startedAt || a.key.localeCompare(b.key);

/**
 * Compares workouts from a source with the activities here. One already here, or
 * linked to an activity from another source, is unchanged when its content is the same
 * as when it was saved or linked, and changed when not. One that overlaps the time of
 * an activity from another source is a possible duplicate. The rest are new. Workouts
 * in the file that share an identity get their own first, matched against the
 * identities saved here, as `distinctIdentities` says.
 */
export const planSourceImport = (
  local: {
    readonly activities: ReadonlyArray<LocalActivity>;
    readonly links: ReadonlyArray<LocalLink>;
  },
  incoming: ReadonlyArray<SourceWorkout>,
): SourcePlan => {
  const byId = new Map(local.activities.map((activity) => [activity.id, activity]));
  const linked = new Map(local.links.map((link) => [`${link.source}:${link.sourceId}`, link]));
  const { workouts, collided } = distinctIdentities(incoming, [
    ...local.activities,
    ...local.links,
  ]);
  const items: Array<SourcePlanItem> = [];
  for (const workout of workouts) {
    const key = sourceKey(workout);
    const here = byId.get(sourceActivityId(workout));
    if (here !== undefined) {
      items.push(
        here.fingerprint === workout.fingerprint
          ? { status: "unchanged", key, workout }
          : { status: "changed", key, workout, local: here.id, linked: false },
      );
      continue;
    }
    const link = linked.get(key);
    if (link !== undefined) {
      items.push(
        link.fingerprint === workout.fingerprint
          ? { status: "unchanged", key, workout }
          : { status: "changed", key, workout, local: link.activityId, linked: true },
      );
      continue;
    }
    let match: LocalActivity | undefined;
    let best = 0;
    for (const activity of local.activities) {
      if (activity.source === workout.source) continue;
      const overlap = overlapMs(activity, workout);
      if (overlap > best) {
        best = overlap;
        match = activity;
      }
    }
    items.push(
      match === undefined
        ? { status: "new", key, workout }
        : { status: "duplicate", key, workout, match },
    );
  }
  items.sort(newestFirst);
  return {
    items,
    added: items.filter((item) => item.status === "new").length,
    duplicates: items.filter((item) => item.status === "duplicate"),
    changed: items.filter((item) => item.status === "changed"),
    unchanged: items.filter((item) => item.status === "unchanged").length,
    collisions: items.filter((item) => collided.has(item.key)),
  };
};

export const isNothingFromSource = (plan: SourcePlan): boolean =>
  plan.added === 0 && plan.duplicates.length === 0 && plan.changed.length === 0;

const idIn = (table: TableKey, workout: Pick<SourceWorkout, "source" | "identity">, path = "") =>
  importedId(TABLES[table].name, workout.source, `${workout.identity}${path}`);

const heartSamples = (
  workout: SourceWorkout,
  trackId: ActivityTrackId,
  at: EpochMillis,
  path: (index: number) => string,
): Array<ActivitySample> =>
  workout.heartRate.map((reading, index) => ({
    id: ActivitySampleId.make(idIn("activitySample", workout, path(index))),
    updatedAt: at,
    deletedAt: null,
    activityTrackId: trackId,
    recordedAt: reading.recordedAt,
    kind: "heart_rate",
    bpm: reading.bpm,
  }));

/**
 * The rows of a workout saved as its own activity. Each ID is computed from the source
 * and identity, as ActivityRepository.create does for an import, so two phones that
 * import the same file make the same rows.
 */
export const sourceActivityRows = (
  workout: SourceWorkout,
  importBatchId: ImportBatchId,
  at: EpochMillis,
): TableRows => {
  const activityId = sourceActivityId(workout);
  const activity: Activity = {
    id: activityId,
    updatedAt: at,
    deletedAt: null,
    kind: workout.kind,
    startedAt: workout.startedAt,
    durationS: workout.durationS,
    title: workout.title,
    notes: "",
    energyKcal: workout.energyKcal,
    audience: "only_you",
    hiddenFields: [],
    source: workout.source,
    sourceId: workout.identity,
    fingerprint: workout.fingerprint,
    importBatchId,
  };
  const { route } = workout;
  const stretches = stretchesOf(route);
  if (route.length === 0 && workout.heartRate.length === 0 && workout.distanceM === null) {
    return { activity: [activity] };
  }
  const trackId = ActivityTrackId.make(idIn("activityTrack", workout, "/track"));
  const track: ActivityTrack = {
    id: trackId,
    updatedAt: at,
    deletedAt: null,
    activityId,
    distanceM: workout.distanceM,
    elevationGainM: elevationGainM(
      stretches.map((stretch) =>
        stretch.map((point) => ({
          at: point.recordedAt,
          altitudeM: point.altitudeM,
          altitudeAccuracyM: null,
        })),
      ),
    ),
    hideStartM: route.length > 0 ? DEFAULT_HIDE_M : 0,
    hideEndM: route.length > 0 ? DEFAULT_HIDE_M : 0,
  };
  const first = route[0];
  const last = route.at(-1);
  // Each segment is a stretch of K1's recording, so a gap between two is a pause.
  const splits =
    first !== undefined && last !== undefined && route.length > 1 && isCardio(workout.kind)
      ? splitsOf(
          {
            activityId,
            kind: workout.kind as CardioKind,
            startedAt: first.recordedAt,
            segments: stretches.map((stretch) => ({
              from: stretch[0]!.recordedAt,
              to: stretch.at(-1)!.recordedAt,
              fixes: stretch.map((point) => ({
                at: point.recordedAt,
                latitude: point.latitude,
                longitude: point.longitude,
                altitudeM: point.altitudeM,
                altitudeAccuracyM: null,
                accuracyM: null,
              })),
              distanceM: pathLengthM(stretch),
              pending: null,
            })),
          },
          last.recordedAt,
        )
      : [];
  const sample = (index: number) =>
    ActivitySampleId.make(idIn("activitySample", workout, `/track/sample/${index}`));
  const locations: Array<ActivitySample> = route.map((point, index) => ({
    id: sample(index),
    updatedAt: at,
    deletedAt: null,
    activityTrackId: trackId,
    kind: "location",
    ...point,
  }));
  const splitRows: Array<ActivitySample> = splits.map((split, index) => ({
    id: sample(route.length + index),
    updatedAt: at,
    deletedAt: null,
    activityTrackId: trackId,
    recordedAt: EpochMillis.make(Math.round(split.endedAt)),
    kind: "split",
    distanceM: split.distanceM,
    durationS: DurationSeconds.make(split.durationS),
  }));
  const offset = route.length + splits.length;
  return {
    activity: [activity],
    activityTrack: [track],
    activitySample: [
      ...locations,
      ...splitRows,
      ...heartSamples(workout, trackId, at, (index) => `/track/sample/${offset + index}`),
    ],
  };
};

/**
 * The rows that link a workout to an activity from another source: the workout's
 * identity, and its heart rate when the activity has none. A strength workout with no
 * route gets a track to hold the heart rate.
 */
export const linkRows = (
  workout: SourceWorkout,
  activity: { readonly id: ActivityId; readonly rows: TableRows },
  importBatchId: ImportBatchId,
  at: EpochMillis,
): TableRows => {
  const link: ActivitySource = {
    id: ActivitySourceId.make(idIn("activitySource", workout)),
    updatedAt: at,
    deletedAt: null,
    activityId: activity.id,
    source: workout.source,
    sourceId: workout.identity,
    fingerprint: workout.fingerprint,
    importBatchId,
  };
  const hasHeart = (activity.rows.activitySample ?? []).some(
    (row) => row.deletedAt === null && row["kind"] === "heart_rate",
  );
  if (workout.heartRate.length === 0 || hasHeart) return { activitySource: [link] };
  const existing = activity.rows.activityTrack?.find((row) => row.deletedAt === null) as
    | ActivityTrack
    | undefined;
  const track: ActivityTrack = existing ?? {
    id: ActivityTrackId.make(idIn("activityTrack", workout, "/track")),
    updatedAt: at,
    deletedAt: null,
    activityId: activity.id,
    distanceM: null,
    elevationGainM: null,
    hideStartM: 0,
    hideEndM: 0,
  };
  return {
    activitySource: [link],
    ...(existing === undefined ? { activityTrack: [track] } : {}),
    activitySample: heartSamples(workout, track.id, at, (index) => `/track/heart_rate/${index}`),
  };
};

/**
 * The rows that `linkRows` added to an activity for one source's workout, found among
 * the activity's rows by the IDs it gives them: the link, and the track and heart rate
 * it brought.
 */
export const linkContribution = (
  rows: TableRows,
  link: Pick<SourceWorkout, "source" | "identity">,
): TableRows => {
  const linkId = idIn("activitySource", link);
  const trackId = idIn("activityTrack", link, "/track");
  const samples = rows.activitySample ?? [];
  const heartIds = new Set<string>(
    Array.from({ length: samples.filter((row) => row["kind"] === "heart_rate").length }, (_, i) =>
      idIn("activitySample", link, `/track/heart_rate/${i}`),
    ),
  );
  const contribution: TableRows = {
    activitySource: (rows.activitySource ?? []).filter((row) => row.id === linkId),
    activityTrack: (rows.activityTrack ?? []).filter((row) => row.id === trackId),
    activitySample: samples.filter((row) => heartIds.has(row.id)),
  };
  return Object.fromEntries(
    Object.entries(contribution).filter(([, list]) => list.length > 0),
  ) as TableRows;
};

const SOURCE_NAME: Readonly<Record<Source, string>> = {
  svett: "svett",
  library: "the exercise library",
  hevy: "Hevy",
  apple_health: "Apple Health",
  gpx: "a GPX file",
};

/** Where an activity came from, as a sentence names it. */
export const sourceName = (source: Source): string => SOURCE_NAME[source];

export interface HeartRateSummary {
  readonly averageBpm: number;
  readonly maxBpm: number;
}

/** The mean and highest of the readings, or null when there are none. */
export const heartRateSummary = (
  samples: ReadonlyArray<{ readonly kind: string; readonly bpm?: number }>,
): HeartRateSummary | null => {
  const beats = samples.flatMap((sample) =>
    sample.kind === "heart_rate" && sample.bpm !== undefined ? [sample.bpm] : [],
  );
  if (beats.length === 0) return null;
  return {
    averageBpm: Math.round(beats.reduce((total, bpm) => total + bpm, 0) / beats.length),
    maxBpm: beats.reduce((highest, bpm) => (bpm > highest ? bpm : highest), 0),
  };
};

export const workoutsLabel = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "workout" : "workouts"}`;

export interface SourceImportResult {
  readonly importBatchId: ImportBatchId;
  readonly added: number;
  readonly linked: number;
  readonly replaced: number;
}

/** What a Health or GPX import did, in one sentence. */
export const sourceImportOutcome = ({
  added,
  linked,
  replaced,
}: Pick<SourceImportResult, "added" | "linked" | "replaced">): string => {
  const parts = [
    added > 0 ? `added ${workoutsLabel(added)}` : null,
    linked > 0
      ? `linked ${workoutsLabel(linked)} to ${linked === 1 ? "one" : "ones"} already here`
      : null,
    replaced > 0 ? `took the new version of ${workoutsLabel(replaced)}` : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return "Nothing changed.";
  const sentence =
    parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
};
