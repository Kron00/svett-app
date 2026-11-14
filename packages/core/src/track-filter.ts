import type { LatLng } from "./geo.ts";

/** A GPS reading as the filter needs it. */
export interface Reading extends LatLng {
  readonly at: number;
  /** The radius in metres the phone is confident of. Null when it did not say. */
  readonly accuracyM: number | null;
  /**
   * The speed the phone measured from the Doppler shift, in metres a second. Null,
   * missing or negative when it did not say.
   */
  readonly speedMps?: number | null;
}

/** How a sport moves. */
export interface Motion {
  /** Process noise, the spectral density of white acceleration on each axis, in m²/s³. */
  readonly accelerationNoise: number;
  /** About the fastest anyone moves in the sport, which bounds an unknown velocity. */
  readonly topSpeedMps: number;
}

/**
 * The Kalman filter's estimate at a reading: position, velocity in metres a second east
 * and north, and their covariance, which is the same on both axes because every reading
 * is equally sure in every direction.
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

/**
 * An append-only list as its latest node, which shares every node before it. Adding to
 * any version leaves that version and every other one as they were.
 */
export interface Chain<T> {
  readonly value: T;
  readonly before: Chain<T> | null;
  readonly length: number;
}

const append = <T>(chain: Chain<T> | null, value: T): Chain<T> => ({
  value,
  before: chain,
  length: (chain?.length ?? 0) + 1,
});

/** The latest `count` values of a chain, oldest first. */
const latest = <T>(chain: Chain<T> | null, count: number): T[] => {
  const values = new Array<T>(Math.min(count, chain?.length ?? 0));
  let node = chain;
  for (let index = values.length - 1; index >= 0; index--, node = node!.before) {
    values[index] = node!.value;
  }
  return values;
};

/** Every value of a chain, oldest first. */
export const chainItems = <T>(chain: Chain<T> | null): T[] => latest(chain, chain?.length ?? 0);

/** A confirmed reading, the filter's estimate there, and whether the recording was moving. */
export interface Point<R extends Reading> {
  readonly fix: R;
  readonly estimate: Estimate;
  readonly moving: boolean;
  /** How many readings in a row up to this one said the other state. */
  readonly against: number;
  /** The filter's estimate where the path ends: at the latest moving point, or the first. */
  readonly end: Estimate;
  /**
   * How far the reported speeds say the recording moved up to here, and over how long,
   * leaving out steps without both speeds.
   */
  readonly movedM: number;
  readonly movedMs: number;
}

/** A confirmed reading at its smoothed position, and the distance up to it. */
export interface SmoothedPoint<R extends Reading> {
  readonly fix: R;
  readonly position: LatLng;
  readonly alongM: number;
}

/**
 * One stretch of readings. Each confirmed reading is moving or paused, decided when it
 * arrives and never again. Distance is the path through the smoothed positions of the
 * first reading and every moving one, so a pause adds nothing and the way from where it
 * began to where movement resumed counts in a straight line. Reported speeds bound it.
 *
 * A reading's smoothed position settles once `LAG` readings follow it. Settled readings
 * keep their distance, and only the rest is worked out again, so what the recording
 * shows is what it saves.
 */
export interface Track<R extends Reading> {
  readonly motion: Motion;
  readonly points: Chain<Point<R>> | null;
  readonly settled: Chain<SmoothedPoint<R>> | null;
  /** Where the distance stands at the latest settled point. */
  readonly walked: Walked<R> | null;
  /** The index of the latest corner the filter turned at, where looking for the next one starts. */
  readonly turn: number;
  /** The latest reading the filter accepted, which counts once a later one confirms it. */
  readonly pending: R | null;
  /** The distance through every confirmed reading, which is what the recording shows. */
  readonly distanceM: number;
}

export const emptyTrack = <R extends Reading>(motion: Motion): Track<R> => ({
  motion,
  points: null,
  settled: null,
  walked: null,
  turn: 0,
  pending: null,
  distanceM: 0,
});

/** No reading is trusted to closer than this. */
export const MIN_ACCURACY_M = 3;
/** A reading that does not say how sure it is counts as a typical phone reading. */
export const UNSTATED_ACCURACY_M = 5;
/**
 * A reading whose squared Mahalanobis distance from the filter's prediction is beyond
 * this does not fit it. It is the chi-square value for two degrees of freedom at 99.9%.
 */
export const GATE = 13.82;
/** A smoothed position settles once this many readings follow it. */
export const LAG = 30;
/**
 * How far a reported speed may be off, in metres a second. iOS measures how far, but
 * expo-location does not pass it on, so this is a fixed error.
 */
export const SPEED_ERROR_MPS = 0.3;
/** Below this speed a reading says still. A still iPhone reports mostly 0, with lone readings up to about 0.5 m/s. */
export const STILL_SPEED_MPS = 0.3;
/** At or above this speed a reading says moving. */
export const MOVING_SPEED_MPS = 0.4;
/** This many readings in a row saying still pause the recording. */
export const PAUSE_READINGS = 4;
/** This many readings in a row saying moving resume it. */
export const MOVE_READINGS = 3;
/** A moving reading with no speed is still when the filter went slowly over this long. */
export const SPEED_WINDOW_MS = 20_000;
/** The filter's uncertainty, this many standard deviations of it, is taken off how far it went. */
export const SIGMAS = 1;
/**
 * Reported speeds show a turn when they went further than the filter by this many
 * standard deviations, and the filter goes no further than they say by more than this.
 */
export const SPEED_SIGMAS = 2;

const EARTH_M_PER_DEGREE = (Math.PI * 6_371_008.8) / 180;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
/** A longitude, or a difference of two, within -180 to 180. */
const wrapLongitude = (longitude: number) =>
  longitude > 180 ? longitude - 360 : longitude < -180 ? longitude + 360 : longitude;

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

/** The distance between two points, flat, which is exact enough over one stretch. */
const flatM = (a: LatLng, b: LatLng) =>
  EARTH_M_PER_DEGREE *
  Math.sqrt(
    (wrapLongitude(b.longitude - a.longitude) * Math.cos(radians(a.latitude))) ** 2 +
      (b.latitude - a.latitude) ** 2,
  );

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

/** The estimate with its velocity forgotten: only that its speed is within `reachMps`. */
const forgotten = (estimate: Estimate, reachMps: number): Estimate => ({
  ...estimate,
  eastMps: 0,
  northMps: 0,
  crossVar: 0,
  velocityVar: reachMps ** 2,
});

const initial = (reading: Reading, motion: Motion): Estimate =>
  forgotten(
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
    motion.topSpeedMps,
  );

/** The speed a reading reports, or null when it did not. iOS reports an unknown one as negative. */
const reportedMps = (reading: Reading): number | null => {
  const speed = reading.speedMps;
  return speed === undefined || speed === null || speed < 0 ? null : speed;
};

/**
 * Whether a reading says the other state from the latest point's. A reported speed says
 * it by the thresholds. Without one, a paused recording moves once the reading lies
 * outside the gate around where the path ends, and a moving one stops when the filter
 * got no further from where it was `SPEED_WINDOW_MS` before than `STILL_SPEED_MPS`
 * would take it, beyond what its uncertainty could explain.
 */
const saysOther = <R extends Reading>(
  points: Chain<Point<R>>,
  reading: R,
  estimate: Estimate,
): boolean => {
  const { moving, end } = points.value;
  const speed = reportedMps(reading);
  if (speed !== null) return moving ? speed < STILL_SPEED_MPS : speed >= MOVING_SPEED_MPS;
  if (!moving) {
    const { east, north } = offsetM(end, reading);
    return (east ** 2 + north ** 2) / (end.positionVar + varianceOf(reading)) > GATE;
  }
  // The furthest the filter got from where it was `SPEED_WINDOW_MS` before, so a turn
  // in that time does not look like a stop.
  const window: Estimate[] = [estimate];
  for (let node = points; window[0]!.at - estimate.at > -SPEED_WINDOW_MS;) {
    window.unshift(node.value.estimate);
    if (node.before === null) break;
    node = node.before;
  }
  const from = window[0]!;
  const furthestM = Math.max(
    ...window.map(
      (other) => flatM(from, other) - SIGMAS * Math.sqrt(from.positionVar + other.positionVar),
    ),
  );
  return furthestM < STILL_SPEED_MPS * ((estimate.at - from.at) / 1000);
};

/** The point for a confirmed reading, moving or paused by the readings up to it. */
const pointOf = <R extends Reading>(
  points: Chain<Point<R>> | null,
  fix: R,
  estimate: Estimate,
): Point<R> => {
  if (points === null) {
    return { fix, estimate, moving: false, against: 0, end: estimate, movedM: 0, movedMs: 0 };
  }
  const previous = points.value;
  const { moving, against, end } = previous;
  const run = saysOther(points, fix, estimate) ? against + 1 : 0;
  const flips = run >= (moving ? PAUSE_READINGS : MOVE_READINGS);
  const now = flips ? !moving : moving;
  const stepM = movedM(previous.fix, fix);
  return {
    fix,
    estimate,
    moving: now,
    against: flips ? 0 : run,
    end: now ? estimate : end,
    movedM: previous.movedM + (stepM ?? 0),
    movedMs: previous.movedMs + (stepM === null ? 0 : fix.at - previous.fix.at),
  };
};

/** Two estimates of one position, combined by how sure each is. */
const combined = (a: LatLng, aVar: number, b: LatLng, bVar: number) => {
  const { east, north } = offsetM(a, b);
  const share = aVar / (aVar + bVar);
  return {
    position: moved(a, { east: east * share, north: north * share }),
    variance: (aVar * bVar) / (aVar + bVar),
  };
};

/** The reading with time running backwards, to filter from the end. */
const backwards = (reading: Reading): Reading => ({ ...reading, at: -reading.at });

/**
 * The reading at a turn counts toward where the turn was only within this of where the
 * readings either side put it. It is the chi-square value for two degrees of freedom at
 * 99%, tighter than the gate, which passes a reading off beyond a turn because the filter
 * coming in expects the recording to carry on.
 */
export const TURN_GATE = 9.21;

/**
 * The estimate at the turn at `turn`: the turn's own reading when it fits where the
 * readings before it and the readings after it up to `to` each put the recording then,
 * or else where they put it, combined.
 */
const turnEstimate = (
  estimates: ReadonlyArray<Estimate>,
  readings: ReadonlyArray<Reading>,
  turn: number,
  to: number,
  motion: Motion,
): Estimate => {
  const reading = readings[turn]!;
  const before = estimates[turn - 1]!;
  const coming = predict(before, reading.at, motion);
  let after = initial(backwards(readings[to]!), motion);
  for (let index = to - 1; index > turn; index--) {
    after = update(after, backwards(readings[index]!), motion, false)!;
  }
  const leaving = predict(after, -reading.at, motion);
  const sides = combined(
    moved(before, coming),
    coming.positionVar,
    moved(after, leaving),
    leaving.positionVar,
  );
  const { east, north } = offsetM(sides.position, reading);
  const fits = (east ** 2 + north ** 2) / (sides.variance + varianceOf(reading)) <= TURN_GATE;
  // The readings either side cut the corner, so the turn's own reading wins when it fits.
  const { position, variance } = fits
    ? { position: reading, variance: Math.min(sides.variance, varianceOf(reading)) }
    : sides;
  return {
    ...position,
    at: reading.at,
    eastMps: before.eastMps,
    northMps: before.northMps,
    positionVar: variance,
    crossVar: coming.crossVar,
    velocityVar: coming.velocityVar,
    turn: true,
  };
};

/**
 * The point between the first and the last furthest from the first, when going there
 * and on to the last is longer than going straight by more than the readings'
 * uncertainty, or when the reported speeds went further than the filter's ends are
 * apart by more than theirs. That is a turn, such as the end of an out-and-back.
 */
const turnIn = <R extends Reading>(points: ReadonlyArray<Point<R>>): number | null => {
  const last = points.length - 1;
  const first = points[0]!;
  const scale = Math.cos(radians(first.fix.latitude));
  let furthest = 0;
  let furthestSquared = 0;
  for (let index = 1; index < last; index++) {
    const { latitude, longitude } = points[index]!.fix;
    const squared =
      (wrapLongitude(longitude - first.fix.longitude) * scale) ** 2 +
      (latitude - first.fix.latitude) ** 2;
    if (squared > furthestSquared) {
      furthest = index;
      furthestSquared = squared;
    }
  }
  const furthestM = Math.sqrt(furthestSquared) * EARTH_M_PER_DEGREE;
  // The recording turned at a corner and went on, so as many readings after it as resume
  // a pause must not say otherwise. Drift where it stopped can look like a corner.
  let goingOn = 0;
  for (let index = furthest + 1; index <= last; index++) {
    if ((reportedMps(points[index]!.fix) ?? MOVING_SPEED_MPS) >= MOVING_SPEED_MPS) goingOn++;
  }
  if (furthest === 0 || goingOn < MOVE_READINGS) return null;
  const detour =
    furthestM +
    flatM(points[furthest]!.fix, points[last]!.fix) -
    flatM(first.fix, points[last]!.fix);
  if (detour ** 2 > GATE * 2 * varianceOf(points[furthest]!.fix)) return furthest;
  // Steps that report no speed count at the mean speed of those that do.
  const knownM = points[last]!.movedM - first.movedM;
  const knownMs = points[last]!.movedMs - first.movedMs;
  if (knownMs === 0) return null;
  const ends = { from: first.estimate, to: points[last]!.estimate };
  const speedM = knownM * ((ends.to.at - ends.from.at) / knownMs);
  const seconds = (ends.to.at - ends.from.at) / 1000;
  const spread = SPEED_ERROR_MPS ** 2 * seconds + ends.from.positionVar + ends.to.positionVar;
  const apartM = flatM(ends.from, ends.to);
  return speedM > apartM && (speedM - apartM) ** 2 > SPEED_SIGMAS ** 2 * spread ? furthest : null;
};

/**
 * The points with the latest one added and a turn among the open ones. When the latest
 * point resumes, the turn is where the readings that resumed it began. Otherwise it is
 * one that `turnIn` finds since the latest turn. The readings after the turn run
 * through the filter again from it, with its velocity forgotten, so the filter does not
 * carry on past it.
 */
const turned = <R extends Reading>(
  track: Track<R>,
  point: Point<R>,
): Pick<Track<R>, "points" | "turn"> => {
  const points = append(track.points, point);
  const count = points.length;
  // Positions alone resume a recording that may have moved all along, so only reported
  // speeds say where it set off.
  const resumed =
    track.points !== null &&
    !track.points.value.moving &&
    point.moving &&
    reportedMps(point.fix) !== null;
  const from = resumed ? count - 1 - MOVE_READINGS : Math.max(track.turn, count - 1 - 2 * LAG);
  const window = latest(points, count - from);
  const at = resumed ? 1 : turnIn(window);
  // The first readings have no velocity to forget.
  if (at === null || from + at <= Math.max(track.settled?.length ?? 0, track.turn, 1)) {
    return { points, turn: track.turn };
  }
  const fixes = window.map(({ fix }) => fix);
  const last = fixes.length - 1;
  const estimates = window.map(({ estimate }) => estimate);
  estimates[at] = turnEstimate(estimates, fixes, at, last, track.motion);
  // After the turn the recording goes about as fast as the next reading says.
  const nextMps = reportedMps(fixes[at + 1]!);
  let previous = forgotten(
    estimates[at]!,
    nextMps === null ? track.motion.topSpeedMps : nextMps + SPEED_ERROR_MPS,
  );
  for (let index = at + 1; index <= last; index++) {
    previous = update(previous, fixes[index]!, track.motion, false)!;
    estimates[index] = previous;
  }
  let rebuilt = points;
  for (let index = at; index <= last; index++) rebuilt = rebuilt.before!;
  for (let index = at; index <= last; index++) {
    rebuilt = append(rebuilt, { ...window[index]!, estimate: estimates[index]! });
  }
  // Where the recording resumed is no corner, so corners are still looked for from the one before.
  return { points: rebuilt, turn: resumed ? track.turn : from + at };
};

/**
 * The positions of a run of estimates after a Rauch-Tung-Striebel pass, which uses
 * every estimate after each one. The latest stays as the filter has it. A turn's
 * estimate already uses the readings either side of it, so it ends one pass and starts
 * the next.
 */
const smoothed = (estimates: ReadonlyArray<Estimate>, motion: Motion): LatLng[] => {
  const count = estimates.length;
  const positions = new Array<LatLng>(count);
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

/** The points not yet settled, at their smoothed positions. */
const unsettled = <R extends Reading>(track: Track<R>) => {
  const open = (track.points?.length ?? 0) - (track.settled?.length ?? 0);
  // The settled point before the open ones anchors the smoothing pass.
  const points = latest(track.points, open + 1);
  const positions = smoothed(
    points.map(({ estimate }) => estimate),
    track.motion,
  );
  const skip = points.length - open;
  return { points: points.slice(skip), positions: positions.slice(skip) };
};

/** How far the speeds two readings report say the recording went between them, or null. */
const speedStepM = (previous: Reading, reading: Reading): number | null => {
  const before = reportedMps(previous);
  const after = reportedMps(reading);
  return before === null || after === null
    ? null
    : ((before + after) / 2) * ((reading.at - previous.at) / 1000);
};

/**
 * How far the speeds two readings report say the recording moved between them, or null.
 * Speeds a still phone reports at both say it did not move.
 */
const movedM = (previous: Reading, reading: Reading): number | null => {
  const stepM = speedStepM(previous, reading);
  return stepM !== null && Math.max(reportedMps(previous)!, reportedMps(reading)!) < STILL_SPEED_MPS
    ? 0
    : stepM;
};

/** Where the distance stands at a point. */
interface Walked<R extends Reading> {
  readonly point: Point<R>;
  /** The latest moving point, or the first, at its position, which the path goes on from. */
  readonly end: { readonly point: Point<R>; readonly position: LatLng };
  readonly alongM: number;
  /**
   * How far the reported speeds say the recording went since `end`, or null when a
   * reading since then reported no speed.
   */
  readonly sinceM: number | null;
}

/**
 * The next point at `position`. A moving point adds the straight way from where the
 * path ends, but no further than the reported speeds say the recording went, give or
 * take their error and, after a pause, how sure the filter is of both ends.
 */
const walk = <R extends Reading>(
  walked: Walked<R>,
  point: Point<R>,
  position: LatLng,
): Walked<R> => {
  const { end } = walked;
  const previous = walked.point;
  const speedM = (point.moving ? speedStepM : movedM)(previous.fix, point.fix);
  const sinceM = walked.sinceM === null || speedM === null ? null : walked.sinceM + speedM;
  if (!point.moving) return { ...walked, point, sinceM };
  const straightM = flatM(end.position, position);
  const slackM =
    SPEED_SIGMAS * SPEED_ERROR_MPS * ((point.fix.at - previous.fix.at) / 1000) +
    (previous.moving ? 0 : Math.sqrt(end.point.estimate.positionVar + point.estimate.positionVar));
  const alongM =
    walked.alongM + (sinceM === null ? straightM : Math.min(straightM, sinceM + slackM));
  return { point, end: { point, position }, alongM, sinceM: 0 };
};

const walkOn = <R extends Reading>(walked: Walked<R> | null, point: Point<R>, position: LatLng) =>
  walked === null
    ? { point, end: { point, position }, alongM: 0, sinceM: 0 }
    : walk(walked, point, position);

/** The points at `positions`, with the distance up to each going on from `walked`. */
const along = <R extends Reading>(
  walked: Walked<R> | null,
  points: ReadonlyArray<Point<R>>,
  positions: ReadonlyArray<LatLng>,
): SmoothedPoint<R>[] =>
  points.map((point, index) => {
    const position = positions[index]!;
    walked = walkOn(walked, point, position);
    return { fix: point.fix, position, alongM: walked.alongM };
  });

const withPoint = <R extends Reading>(track: Track<R>, fix: R, estimate: Estimate): Track<R> => {
  let next: Track<R> = {
    ...track,
    ...turned(track, pointOf(track.points, fix, estimate)),
  };
  const { points, positions } = unsettled(next);
  let skip = 0;
  if (points.length > LAG) {
    const walked = walkOn(next.walked, points[0]!, positions[0]!);
    const settled = { fix: points[0]!.fix, position: positions[0]!, alongM: walked.alongM };
    next = { ...next, settled: append(next.settled, settled), walked };
    skip = 1;
  }
  let walked = next.walked;
  for (let index = skip; index < points.length; index++) {
    walked = walkOn(walked, points[index]!, positions[index]!);
  }
  return { ...next, distanceM: walked!.alongM };
};

/**
 * Adds a reading. A reading becomes pending when it passes the gate, and the pending
 * one is confirmed when this one passes the gate after it. When this one only passes
 * without it, the pending one was a lone outlier and is dropped.
 */
export const addReading = <R extends Reading>(track: Track<R>, reading: R): Track<R> => {
  const motion = track.motion;
  const pending = track.pending;
  const last = track.points?.value.estimate;
  const latestAt = pending?.at ?? track.points?.value.fix.at;
  if (latestAt !== undefined && reading.at <= latestAt) return track;
  if (pending === null) return { ...track, pending: reading };
  const withPending = last === undefined ? initial(pending, motion) : update(last, pending, motion);
  if (withPending !== null && update(withPending, reading, motion) !== null) {
    return { ...withPoint(track, pending, withPending), pending: reading };
  }
  const without = last === undefined ? initial(reading, motion) : update(last, reading, motion);
  return without === null ? track : { ...track, pending: reading };
};

/**
 * The track as it ends. No later reading will confirm the pending one, so it counts
 * unless the filter's gate refuses it.
 */
export const finishTrack = <R extends Reading>(track: Track<R>): Track<R> => {
  const pending = track.pending;
  if (pending === null) return track;
  const last = track.points?.value.estimate;
  const estimate =
    last === undefined ? initial(pending, track.motion) : update(last, pending, track.motion);
  const done = { ...track, pending: null };
  return estimate === null ? done : withPoint(done, pending, estimate);
};

/** The confirmed readings at their smoothed positions, with the distance up to each, as shown live. */
export const smoothTrack = <R extends Reading>(
  track: Track<R>,
): ReadonlyArray<SmoothedPoint<R>> => {
  const { points, positions } = unsettled(track);
  return [...chainItems(track.settled), ...along(track.walked, points, positions)];
};
