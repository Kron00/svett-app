import { distanceM, type LatLng } from "./geo.ts";

/** A GPS reading as the filter needs it. */
export interface Reading extends LatLng {
  readonly at: number;
  /** The radius in metres the phone is confident of. Null when it did not say. */
  readonly accuracyM: number | null;
  /**
   * The speed the phone measured from the Doppler shift, in metres a second. Null or
   * missing when it did not say. Only this tells a stop from slow movement, because
   * both look alike within the readings' uncertainty.
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

/** Readings `from` to `to`, by index, counted one way. `stop` is set for a stop. */
export interface Stretch {
  readonly from: number;
  readonly to: number;
  /** The distance before it. */
  readonly startM: number;
  readonly stop: Still | null;
}

const ITEMS = Symbol("items");

/**
 * A list that every version of a track shares, so a new reading does not copy the ones
 * before it. A version sees only its first `length` items, and lets out no others.
 * Adding to a version that is not the latest copies its items first, so no version sees
 * another's.
 */
export class SharedList<T> implements Iterable<T> {
  private readonly [ITEMS]: T[];
  readonly length: number;

  constructor(items: T[] = []) {
    this[ITEMS] = items;
    this.length = items.length;
  }

  /** The item at `index`, counting from the end when negative, or undefined outside this version. */
  at(index: number): T | undefined {
    const at = index < 0 ? index + this.length : index;
    return at >= 0 && at < this.length ? this[ITEMS][at] : undefined;
  }

  *[Symbol.iterator](): Iterator<T> {
    const items = this[ITEMS];
    for (let index = 0; index < this.length; index++) yield items[index]!;
  }

  /** The items from `start` up to `end`, within this version. */
  slice(start = 0, end = this.length): T[] {
    return this[ITEMS].slice(Math.max(0, start), Math.min(end, this.length));
  }

  toArray(): T[] {
    return this.slice();
  }

  /** This version with `values` after its items. */
  added(values: ReadonlyArray<T>): SharedList<T> {
    if (values.length === 0) return this;
    const items = this[ITEMS].length === this.length ? this[ITEMS] : this.toArray();
    for (const value of values) items.push(value);
    return new SharedList(items);
  }
}

const sharedList = <T>(items: T[] = []): SharedList<T> => new SharedList(items);

const withAdded = <T>(list: SharedList<T>, values: ReadonlyArray<T>): SharedList<T> =>
  list.added(values);

/** The items a version of a list sees. */
export const listItems = <T>(list: SharedList<T>): T[] => list.toArray();

/**
 * One stretch of readings run through a constant-velocity Kalman filter. `fixes` are
 * the confirmed readings. The filter's state at each is in `settled` and then `open`,
 * which a turn found later can still change. `pending` is the latest reading the filter
 * accepted, which counts once a later reading confirms it.
 *
 * Beside the filter runs a still model, which assumes no movement since the reading at
 * `anchor`. While it holds, nothing shows the recording went anywhere, so only the
 * filter's furthest reach from the anchor counts. A reading refutes it when it lies
 * outside the model, or when the speeds the readings report show movement that the
 * reach hides. Then the readings it held for close as stretches: a stop, which counts
 * only the way in and out through its mean, or else movement, which counts the
 * filter's path. Only reported speeds can call a stretch a stop.
 */
export interface Track<R extends Reading> {
  readonly motion: Motion;
  readonly fixes: SharedList<R>;
  readonly settled: SharedList<Estimate>;
  readonly open: SharedList<Estimate>;
  readonly pending: R | null;
  /** The stretches before `last`, the latest, which a turn found later can still change. */
  readonly stretches: SharedList<Stretch>;
  readonly last: Stretch | null;
  readonly anchor: number;
  readonly still: Still | null;
  /** The distance up to the anchor. */
  readonly anchoredM: number;
  /** The furthest a confirmed reading has been from the anchor. */
  readonly readM: number;
  /**
   * The distance the reported speeds give since the anchor, or null when a reading since
   * then did not report one.
   */
  readonly pathM: number | null;
  /**
   * The furthest the filter has been from the anchor, but never beyond `readM` or what
   * `pathM` allows, and no further once `settledStill` is set.
   */
  readonly reachM: number;
  /**
   * The reported speeds since the anchor say still, or, with no speeds to say it, the
   * still model has held for `STOP_MS`. The reach no longer grows.
   */
  readonly settledStill: boolean;
  /** The confirmed distance, which is what the recording shows. */
  readonly distanceM: number;
}

export const emptyTrack = <R extends Reading>(motion: Motion): Track<R> => ({
  motion,
  fixes: sharedList(),
  settled: sharedList(),
  open: sharedList(),
  pending: null,
  stretches: sharedList(),
  last: null,
  anchor: 0,
  still: null,
  anchoredM: 0,
  readM: 0,
  pathM: 0,
  reachM: 0,
  settledStill: false,
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
/**
 * The reading at a turn counts toward where the turn was only within this of where the
 * readings either side put it. It is the chi-square value for two degrees of freedom at
 * 99%, tighter than the gate, which passes a reading off beyond a turn because the filter
 * coming in expects the recording to carry on.
 */
export const TURN_GATE = 9.21;
/** The still model holding this long, with reported speeds that say still, is a stop. */
export const STOP_MS = 60_000;
/**
 * The still model holding this long is a stop too, when the recording did not turn in it
 * and the way in and out through its mean is shorter than the filter's path through it.
 * Through a short stop that path is mostly noise.
 */
export const SHORT_STOP_MS = 20_000;
/**
 * Readings whose reported speeds have a median under this were still. A still iPhone
 * reports mostly 0, with lone readings up to about 0.5 m/s.
 */
export const STILL_SPEED_MPS = 0.3;
/**
 * This many readings in a row reporting at least `STILL_SPEED_MPS` show movement. It is
 * also the fewest reported speeds that can say a stretch was still.
 */
export const MOVING_READINGS = 5;

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

/** How far off a reported speed may be, in metres a second. */
export const SPEED_ERROR_MPS = 0.3;
/**
 * A difference between what the reported speeds say and what the positions say counts
 * once it is beyond this many standard deviations of both.
 */
export const SIGMAS = 2;

/** The speed a reading reports, or null when it did not. iOS reports an unknown one as negative. */
const speedOf = (reading: Reading): number | null => {
  const speed = reading.speedMps;
  return speed === undefined || speed === null || speed < 0 ? null : speed;
};

/** How far the reported speeds say the recording went between two readings, or null. */
const reportedStepM = (before: Reading, after: Reading): number | null => {
  const a = speedOf(before);
  const b = speedOf(after);
  return a === null || b === null ? null : ((a + b) / 2) * ((after.at - before.at) / 1000);
};

/**
 * Whether the reported speeds of readings `from` to `to` say the recording was still:
 * most of them and at least `MOVING_READINGS` report one, and their median is under
 * `STILL_SPEED_MPS`. Positions alone cannot say it.
 */
const saysStill = (readings: ReadonlyArray<Reading>, from: number, to: number): boolean => {
  const speeds: number[] = [];
  for (let index = from; index <= to; index++) {
    const speed = speedOf(readings[index]!);
    if (speed !== null) speeds.push(speed);
  }
  if (speeds.length < MOVING_READINGS || speeds.length * 2 < to - from + 1) return false;
  speeds.sort((a, b) => a - b);
  const middle = speeds.length >> 1;
  const median =
    speeds.length % 2 === 1 ? speeds[middle]! : (speeds[middle - 1]! + speeds[middle]!) / 2;
  return median < STILL_SPEED_MPS;
};

/**
 * The readings after `from` up to `to` that end them reporting at least
 * `STILL_SPEED_MPS`: how many, and the index of the first. Readings that report no
 * speed neither end the run nor count in it.
 */
const movingRun = (readings: ReadonlyArray<Reading>, from: number, to: number) => {
  let count = 0;
  let start = to + 1;
  for (let index = to; index > from && count < MOVING_READINGS; index--) {
    const speed = speedOf(readings[index]!);
    if (speed === null) continue;
    if (speed < STILL_SPEED_MPS) break;
    count++;
    start = index;
  }
  return { moving: count >= MOVING_READINGS, start };
};

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
 * The estimate at the turn at `turn`: where the readings before it and the readings
 * after it up to `to` each put the recording then, combined, with the turn's own
 * reading only when it fits them.
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
  const { position, variance } = fits
    ? combined(sides.position, sides.variance, reading, varianceOf(reading))
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
 * and on to `to` is longer than going straight by more than the readings' uncertainty,
 * or when the reported speeds went further than the filter's ends are apart by more
 * than theirs. That is a turn, such as the end of an out-and-back.
 */
const turnBetween = (
  fixes: ReadonlyArray<Reading>,
  from: number,
  to: number,
  estimates?: ReadonlyArray<Estimate>,
): number | null => {
  let furthest = from;
  for (let index = from + 1; index < to; index++) {
    if (distanceM(fixes[from]!, fixes[index]!) > distanceM(fixes[from]!, fixes[furthest]!)) {
      furthest = index;
    }
  }
  if (furthest === from) return null;
  const straight = distanceM(fixes[from]!, fixes[to]!);
  const detour =
    distanceM(fixes[from]!, fixes[furthest]!) + distanceM(fixes[furthest]!, fixes[to]!) - straight;
  if (detour ** 2 > GATE * 2 * varianceOf(fixes[furthest]!)) return furthest;
  if (estimates === undefined || to - from < 2 * MOVING_READINGS) return null;
  let speedM = 0;
  for (let index = from + 1; index <= to; index++) {
    const step = reportedStepM(fixes[index - 1]!, fixes[index]!);
    if (step === null) return null;
    speedM += step;
  }
  const seconds = (fixes[to]!.at - fixes[from]!.at) / 1000;
  const spread =
    SPEED_ERROR_MPS ** 2 * seconds +
    estimates[from]!.positionVar +
    estimates[to]!.positionVar;
  const ends = distanceM(estimates[from]!, estimates[to]!);
  return speedM > ends && (speedM - ends) ** 2 > SIGMAS ** 2 * spread ? furthest : null;
};

/** Every turn between `from` and `to`, in order: the one `turnBetween` finds, and those either side of it. */
const turnsBetween = (
  readings: ReadonlyArray<Reading>,
  from: number,
  to: number,
  estimates: ReadonlyArray<Estimate>,
): number[] => {
  const turn = turnBetween(readings, from, to, estimates);
  return turn === null
    ? []
    : [
        ...turnsBetween(readings, from, turn, estimates),
        turn,
        ...turnsBetween(readings, turn, to, estimates),
      ];
};

/** How far the filter went between two estimates, by its mean velocity. */
const filterStepM = (before: Estimate, after: Estimate) =>
  (Math.hypot(before.eastMps + after.eastMps, before.northMps + after.northMps) / 2) *
  ((after.at - before.at) / 1000);

/** How far the filter went from `from` to `to`, by its mean velocity over each step. */
const filterPathM = (estimates: ReadonlyArray<Estimate>, from: number, to: number) => {
  let metres = 0;
  for (let index = from + 1; index <= to; index++) {
    metres += filterStepM(estimates[index - 1]!, estimates[index]!);
  }
  return metres;
};

/**
 * Whether the reported speeds went further since the anchor than the reach shows, by
 * more than their error and the filter's uncertainty at both ends could explain.
 */
const hides = (pathM: number | null, reachM: number, anchor: Estimate, estimate: Estimate) => {
  if (pathM === null) return false;
  const seconds = (estimate.at - anchor.at) / 1000;
  const spread =
    SPEED_ERROR_MPS ** 2 * seconds + anchor.positionVar + estimate.positionVar;
  return pathM > reachM && (pathM - reachM) ** 2 > SIGMAS ** 2 * spread;
};

/** The furthest the reported speeds allow since the anchor, within their error. */
const pathCap = (pathM: number | null, from: number, to: number) =>
  pathM === null
    ? Number.POSITIVE_INFINITY
    : pathM + SIGMAS * SPEED_ERROR_MPS * Math.sqrt((to - from) / 1000);

const estimateAt = <R extends Reading>(track: Track<R>, index: number): Estimate =>
  index < track.settled.length
    ? track.settled.at(index)!
    : track.open.at(index - track.settled.length)!;

/**
 * The track once the still model is refuted. `estimates` are the open ones, which
 * `closed` counts from. `closed` are the stretches up to the refuting reading, and
 * the first of them takes the place of `last` when `replacesLast` is set.
 */
const refuted = <R extends Reading>(
  track: Track<R>,
  fixes: SharedList<R>,
  estimates: ReadonlyArray<Estimate>,
  closed: ReadonlyArray<Stretch>,
  replacesLast: boolean,
  anchoredM: number,
): Track<R> => {
  const base = track.settled.length;
  const placed = closed.map((stretch) => ({
    ...stretch,
    from: base + stretch.from,
    to: base + stretch.to,
  }));
  const last = placed.at(-1)!;
  const done = [
    ...(track.last !== null && !replacesLast ? [track.last] : []),
    ...placed.slice(0, -1),
  ];
  // A turn found later can reach back to the start of a movement stretch, but not into a stop.
  const keep = (last.stop === null ? last.from : last.to) - base;
  return {
    ...track,
    fixes,
    settled: withAdded(track.settled, estimates.slice(0, keep)),
    open: sharedList(estimates.slice(keep)),
    stretches: withAdded(track.stretches, done),
    last,
    anchor: last.to,
    still: stillOf(fixes.at(last.to)!),
    anchoredM,
    readM: 0,
    pathM: 0,
    reachM: 0,
    settledStill: false,
    distanceM: anchoredM,
  };
};

const confirm = <R extends Reading>(
  track: Track<R>,
  fix: R,
  estimate: Estimate,
  ending = false,
): Track<R> => {
  const motion = track.motion;
  const fixes = withAdded(track.fixes, [fix]);
  const open = withAdded(track.open, [estimate]);
  if (track.still === null) return { ...track, fixes, open, still: stillOf(fix) };
  const anchor = estimateAt(track, track.anchor);
  const base = track.settled.length;
  const readings = fixes.slice(base);
  const from = track.anchor - base;
  const to = readings.length - 1;
  const still = stay(track.still, fix);
  const run = movingRun(readings, from, to);
  // The filter carries on past a sudden stop, so it reaches no further than a reading,
  // nor than the reported speeds say. Once the still model has held long enough to
  // call it a stop, or the reported speeds say still, nothing grows.
  const readM = Math.max(track.readM, distanceM(anchor, fix));
  const step = reportedStepM(readings[to - 1]!, fix);
  const pathM = track.pathM === null || step === null ? null : track.pathM + step;
  const settledStill =
    track.settledStill ||
    (pathM === null && estimate.at - anchor.at >= STOP_MS) ||
    saysStill(readings, from + 1, to);
  const reachM = settledStill
    ? track.reachM
    : Math.max(
        track.reachM,
        Math.min(readM, distanceM(anchor, estimate), pathCap(pathM, anchor.at, estimate.at)),
      );
  // As the recording ends, movement the reported speeds show closes as it would later.
  const closing = ending && pathM !== null && !settledStill;
  if (still !== null && !closing && !(run.moving && hides(pathM, reachM, anchor, estimate))) {
    return {
      ...track,
      fixes,
      open,
      still,
      readM,
      pathM,
      reachM,
      settledStill,
      distanceM: track.anchoredM + reachM,
    };
  }
  const estimates = listItems(open);
  const held = estimates[to - 1]!.at - anchor.at;
  const inAndOutM = distanceM(anchor, track.still) + distanceM(track.still, estimate);
  // Only the reported speeds can say the recording stopped. The readings that refuted
  // the still model by showing movement are the way out, so they do not count.
  if (
    saysStill(readings, from + 1, run.start - 1) &&
    (held >= STOP_MS ||
      (held >= SHORT_STOP_MS &&
        turnBetween(readings, from, to) === null &&
        inAndOutM <= filterPathM(estimates, from, to)))
  ) {
    const stop: Stretch = { from, to, startM: track.anchoredM, stop: track.still };
    return refuted(track, fixes, estimates, [stop], false, track.anchoredM + inAndOutM);
  }
  // A turn can fall either side of the anchor, so look back through the movement before it.
  const last = track.last;
  const joined = last !== null && last.stop === null && last.to === track.anchor;
  const lookFrom = joined ? last.from - base : from;
  const turns = turnsBetween(readings, lookFrom, to, estimates);
  for (const [at, turn] of turns.entries()) {
    // Run the readings after the turn again from the turn, knowing nothing of the
    // velocity, so the filter does not carry on past it.
    const next = turns[at + 1] ?? to;
    estimates[turn] = turnEstimate(estimates, readings, turn, next, motion);
    let previous = unknownVelocity(estimates[turn]!, motion);
    for (let index = turn + 1; index <= next; index++) {
      previous = update(previous, readings[index]!, motion, false)!;
      estimates[index] = previous;
    }
  }
  const turn = turns[0] ?? null;
  // A turn before the anchor splits the movement stretch before it.
  const reopened = turn !== null && turn <= from;
  const ends = [reopened ? lookFrom : from, ...turns, to];
  // After the start, a stop or a turn the filter is still learning the velocity, so its
  // path falls short. The straight line is a floor.
  const floor = turn !== null || !joined;
  const closed: Stretch[] = [];
  let startM = reopened ? last!.startM : track.anchoredM;
  for (let index = 1; index < ends.length; index++) {
    const start = ends[index - 1]!;
    const end = ends[index]!;
    closed.push({ from: start, to: end, startM, stop: null });
    startM += Math.max(
      filterPathM(estimates, start, end),
      floor ? distanceM(estimates[start]!, estimates[end]!) : 0,
    );
  }
  return refuted(track, fixes, estimates, closed, reopened, startM);
};

/**
 * Adds a reading. A reading becomes pending when it passes the gate, and the pending
 * one is confirmed when this one passes the gate after it. When this one only passes
 * without it, the pending one was a lone outlier and is dropped.
 */
export const addReading = <R extends Reading>(track: Track<R>, reading: R): Track<R> => {
  const motion = track.motion;
  const pending = track.pending;
  const count = track.fixes.length;
  const latest = pending ?? track.fixes.at(count - 1);
  if (latest !== undefined && reading.at <= latest.at) return track;
  if (pending === null) return { ...track, pending: reading };
  const last = count === 0 ? undefined : estimateAt(track, count - 1);
  const withPending = last === undefined ? initial(pending, motion) : update(last, pending, motion);
  if (withPending !== null && update(withPending, reading, motion) !== null) {
    return { ...confirm(track, pending, withPending), pending: reading };
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
  const count = track.fixes.length;
  const estimate =
    count === 0
      ? initial(pending, track.motion)
      : update(estimateAt(track, count - 1), pending, track.motion);
  if (estimate === null) return track;
  // Copies of the shared lists, which the reading would otherwise grow for every version.
  const own: Track<R> = {
    ...track,
    fixes: sharedList(listItems(track.fixes)),
    settled: sharedList(listItems(track.settled)),
    open: sharedList(listItems(track.open)),
    stretches: sharedList(listItems(track.stretches)),
  };
  return { ...confirm(own, pending, estimate, true), pending: null };
};

/**
 * The estimates' positions after a Rauch-Tung-Striebel pass, which uses every reading
 * before and after each one. A turn's estimate already does, so it ends one pass and
 * starts the next.
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
  const estimates = [...listItems(track.settled), ...listItems(track.open)];
  const count = estimates.length;
  if (count === 0) return [];
  const positions = smoothed(estimates, track.motion);
  const fixes = listItems(track.fixes);
  const alongM = Array.from({ length: count }, () => 0);
  const stretches = [...listItems(track.stretches), ...(track.last === null ? [] : [track.last])];
  for (const { from, to, stop } of stretches) {
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
  const anchor = estimates[track.anchor]!;
  const origin = positions[track.anchor]!;
  let readM = 0;
  let pathM: number | null = 0;
  let reachM = 0;
  let settledStill = false;
  for (let index = track.anchor + 1; index < count; index++) {
    readM = Math.max(readM, distanceM(origin, fixes[index]!));
    const step = reportedStepM(fixes[index - 1]!, fixes[index]!);
    pathM = pathM === null || step === null ? null : pathM + step;
    settledStill ||=
      (pathM === null && estimates[index]!.at - anchor.at >= STOP_MS) ||
      saysStill(fixes, track.anchor + 1, index);
    if (!settledStill) {
      reachM = Math.max(
        reachM,
        Math.min(readM, distanceM(origin, positions[index]!), pathCap(pathM, anchor.at, estimates[index]!.at)),
      );
    }
    alongM[index] = alongM[track.anchor]! + reachM;
  }
  return positions.map((position, index) => ({
    fix: fixes[index]!,
    position,
    alongM: alongM[index]!,
  }));
};
