import { distanceM, type LatLng } from "./geo.ts";

/** A GPS reading as the filter needs it. */
export interface Reading extends LatLng {
  readonly at: number;
  /** The radius in metres the phone is confident of. Null when it did not say. */
  readonly accuracyM: number | null;
}

/** How a sport moves. */
export interface Motion {
  /** Process noise, the spectral density of white acceleration on each axis, in m²/s³. */
  readonly accelerationNoise: number;
  /** About the fastest anyone moves in the sport, which bounds an unknown velocity. */
  readonly topSpeedMps: number;
}

/**
 * The filter's estimate at a confirmed reading: position, velocity in metres a second
 * east and north, and their covariance, which is the same on both axes because every
 * reading is equally sure in every direction.
 */
export interface Estimate extends LatLng {
  readonly at: number;
  readonly eastMps: number;
  readonly northMps: number;
  readonly positionVar: number;
  readonly crossVar: number;
  readonly velocityVar: number;
  /** The recording turned here, so the filter forgot its velocity after this reading. */
  readonly turn: boolean;
}

/** The still model: the weighted mean of the readings since it started, and their weight. */
export interface Still extends LatLng {
  readonly weight: number;
}

/** Readings `from` to `to`, by index, that the still model held for. `stop` is set for a stop. */
export interface Stretch {
  readonly from: number;
  readonly to: number;
  /** The distance before it. */
  readonly startM: number;
  readonly stop: Still | null;
}

/**
 * One stretch of readings run through a constant-velocity Kalman filter. `fixes` are
 * the confirmed readings and `estimates` the filter's state at each. `pending` is the
 * latest reading the filter accepted, which counts once a later reading confirms it.
 *
 * Beside the filter runs a still model, which assumes no movement since the reading at
 * `anchor`. While it holds, nothing shows the recording went anywhere, so only the
 * filter's furthest reach from the anchor counts. When a reading refutes it, the
 * readings it held for close as one of `stretches`: a stop when it held for STOP_MS,
 * which counts only the way in and out through its mean, or else movement, which
 * counts the filter's path.
 */
export interface Track<R extends Reading> {
  readonly motion: Motion;
  readonly fixes: ReadonlyArray<R>;
  readonly estimates: ReadonlyArray<Estimate>;
  readonly pending: R | null;
  readonly stretches: ReadonlyArray<Stretch>;
  readonly anchor: number;
  readonly still: Still | null;
  /** The distance up to the anchor. */
  readonly anchoredM: number;
  /** The furthest the filter has been from the anchor. */
  readonly reachM: number;
  /** The confirmed distance, which is what the recording shows. */
  readonly distanceM: number;
}

export const emptyTrack = <R extends Reading>(motion: Motion): Track<R> => ({
  motion,
  fixes: [],
  estimates: [],
  pending: null,
  stretches: [],
  anchor: 0,
  still: null,
  anchoredM: 0,
  reachM: 0,
  distanceM: 0,
});

/** No reading is trusted to closer than this. */
export const MIN_ACCURACY_M = 3;
/** A reading that does not say how sure it is counts as a typical phone reading. */
export const UNSTATED_ACCURACY_M = 5;
/**
 * A reading whose squared Mahalanobis distance from a model's prediction is beyond this
 * does not fit it. It is the chi-square value for two degrees of freedom at 99.9%.
 */
export const GATE = 13.82;
/** The still model holding this long means the recording stopped. */
export const STOP_MS = 60_000;

const EARTH_M_PER_DEGREE = (Math.PI * 6_371_008.8) / 180;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
const wrapLongitude = (longitude: number) => ((longitude + 540) % 360) - 180;

interface Offset {
  readonly east: number;
  readonly north: number;
}

/** Metres east and north of `origin`, flat, which is exact enough over one step. */
const offsetM = (origin: LatLng, point: LatLng): Offset => ({
  east:
    wrapLongitude(point.longitude - origin.longitude) *
    EARTH_M_PER_DEGREE *
    Math.cos(radians(origin.latitude)),
  north: (point.latitude - origin.latitude) * EARTH_M_PER_DEGREE,
});

const moved = (origin: LatLng, { east, north }: Offset): LatLng => ({
  latitude: origin.latitude + north / EARTH_M_PER_DEGREE,
  longitude: wrapLongitude(
    origin.longitude + east / (EARTH_M_PER_DEGREE * Math.cos(radians(origin.latitude))),
  ),
});

const varianceOf = (reading: Reading) =>
  Math.max(MIN_ACCURACY_M, reading.accuracyM ?? UNSTATED_ACCURACY_M) ** 2;

interface Prediction {
  readonly seconds: number;
  /** Where the estimate expects to be, from where it was. */
  readonly east: number;
  readonly north: number;
  readonly positionVar: number;
  readonly crossVar: number;
  readonly velocityVar: number;
}

const predict = (estimate: Estimate, at: number, motion: Motion): Prediction => {
  const seconds = (at - estimate.at) / 1000;
  const q = motion.accelerationNoise;
  return {
    seconds,
    east: estimate.eastMps * seconds,
    north: estimate.northMps * seconds,
    positionVar:
      estimate.positionVar +
      2 * estimate.crossVar * seconds +
      estimate.velocityVar * seconds ** 2 +
      (q * seconds ** 3) / 3,
    crossVar: estimate.crossVar + estimate.velocityVar * seconds + (q * seconds ** 2) / 2,
    velocityVar: estimate.velocityVar + q * seconds,
  };
};

/**
 * The estimate after `reading`, or null when the reading lies outside the gate.
 * `gated` is false when re-running readings that were confirmed already.
 */
const update = (
  estimate: Estimate,
  reading: Reading,
  motion: Motion,
  gated = true,
): Estimate | null => {
  const prior = predict(estimate, reading.at, motion);
  const variance = varianceOf(reading);
  const spread = prior.positionVar + variance;
  const seen = offsetM(estimate, reading);
  const east = seen.east - prior.east;
  const north = seen.north - prior.north;
  if (gated && (east ** 2 + north ** 2) / spread > GATE) return null;
  const positionGain = prior.positionVar / spread;
  const velocityGain = prior.crossVar / spread;
  return {
    ...moved(estimate, {
      east: prior.east + positionGain * east,
      north: prior.north + positionGain * north,
    }),
    at: reading.at,
    eastMps: estimate.eastMps + velocityGain * east,
    northMps: estimate.northMps + velocityGain * north,
    positionVar: (prior.positionVar * variance) / spread,
    crossVar: (prior.crossVar * variance) / spread,
    velocityVar: prior.velocityVar - prior.crossVar ** 2 / spread,
    turn: false,
  };
};

/** The estimate with its velocity forgotten: only that it is within reach of the sport. */
const unknownVelocity = (estimate: Estimate, motion: Motion): Estimate => ({
  ...estimate,
  eastMps: 0,
  northMps: 0,
  crossVar: 0,
  velocityVar: motion.topSpeedMps ** 2,
});

const initial = (reading: Reading, motion: Motion): Estimate =>
  unknownVelocity(
    {
      latitude: reading.latitude,
      longitude: reading.longitude,
      at: reading.at,
      eastMps: 0,
      northMps: 0,
      positionVar: varianceOf(reading),
      crossVar: 0,
      velocityVar: 0,
      turn: false,
    },
    motion,
  );

const stillOf = (reading: Reading): Still => ({
  latitude: reading.latitude,
  longitude: reading.longitude,
  weight: 1 / varianceOf(reading),
});

/** The still model with `reading` added, or null when the reading refutes it. */
const stay = (still: Still, reading: Reading): Still | null => {
  const variance = varianceOf(reading);
  const { east, north } = offsetM(still, reading);
  if ((east ** 2 + north ** 2) / (1 / still.weight + variance) > GATE) return null;
  const weight = still.weight + 1 / variance;
  const share = 1 / variance / weight;
  return { ...moved(still, { east: east * share, north: north * share }), weight };
};

/**
 * The reading between `from` and `to` furthest from the one at `from`, when going there
 * and on to `to` is longer than going straight by more than the readings' uncertainty.
 * That is a turn, such as the end of an out-and-back.
 */
const turnBetween = (fixes: ReadonlyArray<Reading>, from: number, to: number): number | null => {
  let furthest = from;
  for (let index = from + 1; index < to; index++) {
    if (distanceM(fixes[from]!, fixes[index]!) > distanceM(fixes[from]!, fixes[furthest]!)) {
      furthest = index;
    }
  }
  if (furthest === from) return null;
  const detour =
    distanceM(fixes[from]!, fixes[furthest]!) +
    distanceM(fixes[furthest]!, fixes[to]!) -
    distanceM(fixes[from]!, fixes[to]!);
  return detour ** 2 > GATE * 2 * varianceOf(fixes[furthest]!) ? furthest : null;
};

/** How far the filter went from `from` to `to`, by its mean velocity over each step. */
const filterPathM = (estimates: ReadonlyArray<Estimate>, from: number, to: number) => {
  let total = 0;
  for (let index = from + 1; index <= to; index++) {
    const before = estimates[index - 1]!;
    const after = estimates[index]!;
    total +=
      (Math.hypot(before.eastMps + after.eastMps, before.northMps + after.northMps) / 2) *
      ((after.at - before.at) / 1000);
  }
  return total;
};

const confirm = <R extends Reading>(track: Track<R>, fix: R, estimate: Estimate): Track<R> => {
  const motion = track.motion;
  const fixes = [...track.fixes, fix];
  if (track.still === null) {
    return { ...track, fixes, estimates: [estimate], still: stillOf(fix) };
  }
  let estimates = [...track.estimates, estimate];
  const anchor = estimates[track.anchor]!;
  const still = stay(track.still, fix);
  if (still !== null) {
    // Once the still model has held long enough to call it a stop, nothing grows.
    const reachM =
      estimate.at - anchor.at >= STOP_MS
        ? track.reachM
        : Math.max(track.reachM, distanceM(anchor, estimate));
    return { ...track, fixes, estimates, still, reachM, distanceM: track.anchoredM + reachM };
  }
  const to = estimates.length - 1;
  if (estimates[to - 1]!.at - anchor.at >= STOP_MS) {
    const anchoredM =
      track.anchoredM + distanceM(anchor, track.still) + distanceM(track.still, estimate);
    return {
      ...track,
      fixes,
      estimates,
      stretches: [
        ...track.stretches,
        { from: track.anchor, to, startM: track.anchoredM, stop: track.still },
      ],
      anchor: to,
      still: stillOf(fix),
      anchoredM,
      reachM: 0,
      distanceM: anchoredM,
    };
  }
  // A turn can fall either side of the anchor, so look back through the movement before it.
  const last = track.stretches.at(-1);
  const joined = last !== undefined && last.stop === null && last.to === track.anchor;
  const turn = turnBetween(fixes, joined ? last.from : track.anchor, to);
  if (turn !== null) {
    // Run the readings after the turn again from the turn, knowing nothing of the
    // velocity, so the filter does not carry on past it.
    estimates = estimates.slice(0, turn + 1);
    estimates[turn] = { ...estimates[turn]!, turn: true };
    let previous = unknownVelocity(estimates[turn]!, motion);
    for (let index = turn + 1; index <= to; index++) {
      previous = update(previous, fixes[index]!, motion, false)!;
      estimates.push(previous);
    }
  }
  const stretch: Stretch =
    turn !== null && joined
      ? { ...last, to }
      : { from: track.anchor, to, startM: track.anchoredM, stop: null };
  const pathM = filterPathM(estimates, stretch.from, to);
  // After the start, a stop or a turn the filter is still learning the velocity, so its
  // path falls short. The straight lines through the turn are a floor.
  const via = turn ?? stretch.from;
  const movedM =
    turn !== null || !joined
      ? Math.max(
          pathM,
          distanceM(estimates[stretch.from]!, estimates[via]!) +
            distanceM(estimates[via]!, estimates[to]!),
        )
      : pathM;
  const anchoredM = stretch.startM + movedM;
  return {
    ...track,
    fixes,
    estimates,
    stretches: [
      ...(turn !== null && joined ? track.stretches.slice(0, -1) : track.stretches),
      stretch,
    ],
    anchor: to,
    still: stillOf(fix),
    anchoredM,
    reachM: 0,
    distanceM: anchoredM,
  };
};

/**
 * Adds a reading. A reading becomes pending when it passes the gate, and the pending
 * one is confirmed when this one passes the gate after it. When this one only passes
 * without it, the pending one was a lone outlier and is dropped.
 */
export const addReading = <R extends Reading>(track: Track<R>, reading: R): Track<R> => {
  const motion = track.motion;
  const pending = track.pending;
  const latest = pending ?? track.fixes.at(-1);
  if (latest !== undefined && reading.at <= latest.at) return track;
  if (pending === null) return { ...track, pending: reading };
  const last = track.estimates.at(-1);
  const withPending = last === undefined ? initial(pending, motion) : update(last, pending, motion);
  if (withPending !== null && update(withPending, reading, motion) !== null) {
    return { ...confirm(track, pending, withPending), pending: reading };
  }
  const without = last === undefined ? initial(reading, motion) : update(last, reading, motion);
  return without === null ? track : { ...track, pending: reading };
};

/**
 * The estimates' positions after a Rauch-Tung-Striebel pass, which uses every reading
 * before and after each one. A turn ends one pass and starts the next.
 */
const smoothed = (estimates: ReadonlyArray<Estimate>, motion: Motion): LatLng[] => {
  const count = estimates.length;
  const positions: LatLng[] = Array.from({ length: count });
  let afterEastMps = 0;
  let afterNorthMps = 0;
  for (let index = count - 1; index >= 0; index--) {
    const estimate = estimates[index]!;
    if (index === count - 1 || estimate.turn) {
      positions[index] = estimate;
      afterEastMps = estimate.eastMps;
      afterNorthMps = estimate.northMps;
      continue;
    }
    const prior = predict(estimate, estimates[index + 1]!.at, motion);
    const seconds = prior.seconds;
    // The smoother gain P Fᵀ (F P Fᵀ + Q)⁻¹, the same on both axes.
    const determinant = prior.positionVar * prior.velocityVar - prior.crossVar ** 2;
    const a = estimate.positionVar + estimate.crossVar * seconds;
    const b = estimate.crossVar;
    const c = estimate.crossVar + estimate.velocityVar * seconds;
    const d = estimate.velocityVar;
    const pp = (a * prior.velocityVar - b * prior.crossVar) / determinant;
    const pv = (b * prior.positionVar - a * prior.crossVar) / determinant;
    const vp = (c * prior.velocityVar - d * prior.crossVar) / determinant;
    const vv = (d * prior.positionVar - c * prior.crossVar) / determinant;
    const seen = offsetM(estimate, positions[index + 1]!);
    const east = seen.east - prior.east;
    const north = seen.north - prior.north;
    const eastMps = afterEastMps - estimate.eastMps;
    const northMps = afterNorthMps - estimate.northMps;
    positions[index] = moved(estimate, {
      east: pp * east + pv * eastMps,
      north: pp * north + pv * northMps,
    });
    afterEastMps = estimate.eastMps + vp * east + vv * eastMps;
    afterNorthMps = estimate.northMps + vp * north + vv * northMps;
  }
  return positions;
};

/** A confirmed reading at its smoothed position, and how far along its stretch it is. */
export interface SmoothedPoint<R extends Reading> {
  readonly fix: R;
  readonly position: LatLng;
  readonly alongM: number;
}

/**
 * The confirmed readings at their smoothed positions. Distance adds up as it does
 * live, through the smoothed positions: along the path while moving, in and out
 * through the mean of a stop, and the furthest reach since the last of those.
 */
export const smoothTrack = <R extends Reading>(
  track: Track<R>,
): ReadonlyArray<SmoothedPoint<R>> => {
  const count = track.estimates.length;
  if (count === 0) return [];
  const positions = smoothed(track.estimates, track.motion);
  const alongM = Array.from({ length: count }, () => 0);
  for (const { from, to, stop } of track.stretches) {
    if (stop === null) {
      for (let index = from + 1; index <= to; index++) {
        alongM[index] = alongM[index - 1]! + distanceM(positions[index - 1]!, positions[index]!);
      }
    } else {
      for (let index = from + 1; index < to; index++) alongM[index] = alongM[from]!;
      alongM[to] =
        alongM[from]! + distanceM(positions[from]!, stop) + distanceM(stop, positions[to]!);
    }
  }
  let reachM = 0;
  const anchor = track.estimates[track.anchor]!;
  for (let index = track.anchor + 1; index < count; index++) {
    if (track.estimates[index]!.at - anchor.at < STOP_MS) {
      reachM = Math.max(reachM, distanceM(positions[track.anchor]!, positions[index]!));
    }
    alongM[index] = alongM[track.anchor]! + reachM;
  }
  return positions.map((position, index) => ({
    fix: track.fixes[index]!,
    position,
    alongM: alongM[index]!,
  }));
};
