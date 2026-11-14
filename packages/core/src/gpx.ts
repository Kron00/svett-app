import { Data, Exit, Result, Schema } from "effect";

import { decodeEntities, XmlError, XmlScanner, xmlAttributes } from "./xml.ts";

export class GpxError extends Data.TaggedError("GpxError")<{ readonly message: string }> {}

export const GpxPoint = Schema.Struct({
  recordedAt: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  latitude: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
  longitude: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  altitudeM: Schema.NullOr(Schema.Finite),
  /** Beats per minute, from a Garmin or Strava track point extension. */
  heartRate: Schema.NullOr(Schema.Finite),
});
export type GpxPoint = typeof GpxPoint.Type;

export interface GpxTrack {
  readonly name: string | null;
  /** The activity type the file names, such as "running". */
  readonly type: string | null;
  readonly points: ReadonlyArray<GpxPoint>;
}

const decodePoint = Schema.decodeUnknownExit(GpxPoint);

const localName = (name: string) => name.slice(name.indexOf(":") + 1);

const numberOrNull = (text: string | undefined) => {
  if (text === undefined || text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : Number.NaN;
};

const timeOrNull = (text: string | undefined) => {
  if (text === undefined || text.trim() === "") return null;
  const value = Date.parse(text.trim());
  return Number.isFinite(value) ? value : Number.NaN;
};

/**
 * Reads the track points of a GPX file, in file order, across all its tracks and
 * segments. A point that is not a valid position refuses the whole file.
 */
export const parseGpx = (text: string): Result.Result<GpxTrack, GpxError> => {
  const points: Array<GpxPoint> = [];
  const path: Array<string> = [];
  let name: string | null = null;
  let type: string | null = null;
  let isGpx = false;
  let point:
    | { lat: string | undefined; lon: string | undefined; fields: Record<string, string> }
    | undefined;
  let textOf = "";
  let problem: string | undefined;

  const scanner = new XmlScanner({
    open: (tag, attributes, selfClosing) => {
      const local = localName(tag);
      if (local === "gpx") isGpx = true;
      if (local === "trkpt") {
        const { lat, lon } = xmlAttributes(attributes);
        point = { lat, lon, fields: {} };
      }
      if (!selfClosing) path.push(local);
      textOf = "";
      if (selfClosing && local === "trkpt") finishPoint();
    },
    close: (tag) => {
      const local = localName(tag);
      path.pop();
      const parent = path.at(-1);
      const value = decodeEntities(textOf).trim();
      if (point !== undefined && local !== "trkpt") point.fields[local] ??= value;
      else if (parent === "trk" && local === "name") name = value || null;
      else if (parent === "trk" && local === "type") type = value || null;
      if (local === "trkpt") finishPoint();
      textOf = "";
    },
    text: (raw) => {
      textOf += raw;
    },
  });

  function finishPoint() {
    if (point === undefined) return;
    const candidate = {
      recordedAt: timeOrNull(point.fields["time"]),
      latitude: numberOrNull(point.lat),
      longitude: numberOrNull(point.lon),
      altitudeM: numberOrNull(point.fields["ele"]),
      heartRate: numberOrNull(point.fields["hr"]),
    };
    point = undefined;
    const decoded = decodePoint(candidate);
    if (Exit.isSuccess(decoded)) points.push(decoded.value);
    else problem ??= `Track point ${points.length + 1} is not a valid position and time.`;
  }

  try {
    scanner.push(text);
    scanner.end();
  } catch (error) {
    if (error instanceof XmlError) return Result.fail(new GpxError({ message: error.message }));
    throw error;
  }
  if (!isGpx) return Result.fail(new GpxError({ message: "This is not a GPX file." }));
  if (problem !== undefined) return Result.fail(new GpxError({ message: problem }));
  return Result.succeed({ name, type, points });
};
