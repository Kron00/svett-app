import { Data, Result } from "effect";
import { DecodeUTF8 } from "fflate";

import { GpxError, parseGpx } from "./gpx.ts";
import { HealthExportReader } from "./health-export.ts";
import type { ImportedSource } from "./schema.ts";
import { fromGpx, fromHealthWorkout, type SourceWorkout } from "./source-import.ts";
import { XmlError } from "./xml.ts";
import {
  type ByteSource,
  inSequence,
  isZip,
  listZipEntries,
  readRange,
  readZipText,
  type ZipEntry,
  ZipError,
  zipText,
} from "./zip.ts";

export class SourceFileError extends Data.TaggedError("SourceFileError")<{
  readonly message: string;
}> {}

/** The workouts in an Apple Health export or a GPX file. */
export interface SourceFile {
  readonly source: Extract<ImportedSource, "apple_health" | "gpx">;
  readonly workouts: ReadonlyArray<SourceWorkout>;
  /** Workouts or routes the file holds that svett could not read. */
  readonly skipped: number;
}

export interface ReadOptions {
  /** The phone's local hour of a time, for the title of a GPX workout. */
  readonly hourOf: (at: number) => number;
  /** The share of the file read so far. */
  readonly onProgress?: (fraction: number) => void;
}

/** A GPX file is read whole. Real ones are well under this. */
const MAX_GPX_BYTES = 64 << 20;

const notSupported = new SourceFileError({
  message:
    "svett imports Apple Health's export.zip, its export.xml, or a GPX file. This is none of them.",
});

/** export.xml, or its name in another language, beside export_cda.xml. */
const exportXml = (entries: ReadonlyArray<ZipEntry>) => {
  const xml = entries.filter(
    (entry) =>
      entry.name.toLowerCase().endsWith(".xml") &&
      !entry.name.toLowerCase().includes("cda") &&
      entry.name.split("/").length <= 2,
  );
  return xml.find((entry) => entry.name.endsWith("/export.xml")) ?? xml[0];
};

const readHealthZip = async (source: ByteSource, options: ReadOptions): Promise<SourceFile> => {
  const entries = await listZipEntries(source);
  const xml = exportXml(entries);
  if (xml === undefined) {
    throw new SourceFileError({
      message: "This zip has no export.xml, so it is not an Apple Health export.",
    });
  }
  const reader = new HealthExportReader();
  await readZipText(source, xml, (text) => reader.push(text), options.onProgress);
  const exported = reader.finish();
  if (!exported.isHealthExport) {
    throw new SourceFileError({ message: "This zip is not an Apple Health export." });
  }
  let skipped = exported.skipped;
  const workouts = await inSequence(exported.workouts, async (workout) => {
    const routeEntry =
      workout.routeFile === null
        ? undefined
        : entries.find((entry) => entry.name.endsWith(workout.routeFile!));
    if (routeEntry === undefined) return fromHealthWorkout(workout, null);
    const parsed = parseGpx(await zipText(source, routeEntry));
    if (Result.isFailure(parsed)) skipped++;
    return fromHealthWorkout(workout, Result.isSuccess(parsed) ? parsed.success : null);
  });
  return { source: "apple_health", workouts, skipped };
};

/** Streams a file that is not a zip: export.xml on its own, or a GPX file read whole. */
const readText = async (source: ByteSource, options: ReadOptions): Promise<SourceFile> => {
  let kind: "health" | "gpx" | undefined;
  let head = "";
  const gpxParts: Array<string> = [];
  const reader = new HealthExportReader();
  const take = (text: string) => {
    if (kind === undefined) {
      head += text;
      if (head.includes("<HealthData")) kind = "health";
      else if (/<gpx[\s>]/.test(head)) kind = "gpx";
      else if (head.length < 64 << 10) return;
      else throw notSupported;
      text = head;
    }
    if (kind === "health") reader.push(text);
    else gpxParts.push(text);
  };
  const decoder = new DecodeUTF8(take);
  await readRange(source, 0, source.size, (bytes, read) => {
    if (kind === "gpx" && read > MAX_GPX_BYTES) {
      throw new SourceFileError({ message: "This GPX file is too large for svett to read." });
    }
    decoder.push(bytes);
    options.onProgress?.(read / source.size);
  });
  decoder.push(new Uint8Array(0), true);
  if (kind === undefined) throw notSupported;
  if (kind === "health") {
    const exported = reader.finish();
    return {
      source: "apple_health",
      workouts: exported.workouts.map((workout) => fromHealthWorkout(workout, null)),
      skipped: exported.skipped,
    };
  }
  const parsed = parseGpx(gpxParts.join(""));
  if (Result.isFailure(parsed)) throw parsed.failure;
  const workout = fromGpx(parsed.success, options.hourOf);
  if (Result.isFailure(workout)) throw workout.failure;
  return { source: "gpx", workouts: [workout.success], skipped: 0 };
};

/**
 * Reads an Apple Health export.zip, a bare export.xml or a GPX file, a megabyte at a
 * time, into the workouts it holds. A damaged file is refused with a message to show.
 */
export const readSourceFile = async (
  source: ByteSource,
  options: ReadOptions,
): Promise<Result.Result<SourceFile, SourceFileError>> => {
  try {
    const start = await source.read(0, 4);
    return Result.succeed(
      isZip(start) ? await readHealthZip(source, options) : await readText(source, options),
    );
  } catch (error) {
    if (error instanceof SourceFileError) return Result.fail(error);
    if (error instanceof ZipError || error instanceof XmlError || error instanceof GpxError) {
      return Result.fail(new SourceFileError({ message: error.message }));
    }
    throw error;
  }
};
