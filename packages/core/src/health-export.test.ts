import { Result } from "effect";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";

import { parseGpx } from "./gpx.ts";
import { HealthExportReader, parseHealthDate } from "./health-export.ts";
import {
  SAMPLE_GPX_START,
  SAMPLE_RIDE_START,
  SAMPLE_ROUTE_FILE,
  SAMPLE_RUN_START,
  SAMPLE_STRENGTH_START,
  SAMPLE_YOGA_START,
  sampleExportXml,
  sampleGpx,
  sampleHealthZip,
  sampleRouteGpx,
} from "./health-sample.ts";
import { bytesSource, listZipEntries, readZipEntry, zipText } from "./zip.ts";

const MINUTE = 60_000;

const read = (text: string, size = text.length) => {
  const reader = new HealthExportReader();
  for (let at = 0; at < text.length; at += size) reader.push(text.slice(at, at + size));
  return reader.finish();
};

describe("parseHealthDate", () => {
  it("reads the time zone each date carries", () => {
    expect(parseHealthDate("2026-11-01 07:30:00 +0100")).toEqual({
      at: Date.UTC(2026, 10, 1, 6, 30),
      localHour: 7,
    });
    expect(parseHealthDate("2026-11-01 07:30:00 -0530")).toEqual({
      at: Date.UTC(2026, 10, 1, 13, 0),
      localHour: 7,
    });
    expect(parseHealthDate("2026-11-01T07:30:00Z")).toBeNull();
  });
});

describe("HealthExportReader", () => {
  it("reads each workout with its distance, energy, route file and heart rate", () => {
    const { workouts, skipped, isHealthExport } = read(sampleExportXml());
    expect(isHealthExport).toBe(true);
    expect(skipped).toBe(1);
    expect(workouts.map((workout) => workout.activityType)).toEqual([
      "HKWorkoutActivityTypeRunning",
      "HKWorkoutActivityTypeTraditionalStrengthTraining",
      "HKWorkoutActivityTypeCycling",
      "HKWorkoutActivityTypeYoga",
    ]);
    const [run, strength, ride, yoga] = workouts;
    expect(run).toMatchObject({
      sourceName: "Sample Watch",
      startedAt: SAMPLE_RUN_START,
      endedAt: SAMPLE_RUN_START + 30 * MINUTE,
      localHour: 7,
      durationS: 1800,
      energyKcal: 320,
      routeFile: SAMPLE_ROUTE_FILE,
    });
    // The iOS 16 activity repeats the distance. Only the workout's own counts.
    expect(run!.distanceM).toBeCloseTo(5020, 6);
    // Readings every 30 seconds inside the window, and none from the 10 minutes before it.
    expect(run!.heartRate).toHaveLength(60);
    expect(run!.heartRate[0]).toEqual({ recordedAt: SAMPLE_RUN_START, bpm: 140 });
    expect(Math.max(...run!.heartRate.map((reading) => reading.bpm))).toBe(164);
    expect(strength).toMatchObject({
      startedAt: SAMPLE_STRENGTH_START,
      energyKcal: 250,
      routeFile: null,
    });
    expect(strength!.heartRate).toHaveLength(110);
    expect(ride).toMatchObject({ startedAt: SAMPLE_RIDE_START, durationS: 2700, heartRate: [] });
    expect(ride!.distanceM).toBeCloseTo(20_000, 0);
    expect(ride!.energyKcal).toBeCloseTo(400, 6);
    expect(yoga).toMatchObject({
      startedAt: SAMPLE_YOGA_START,
      distanceM: null,
      energyKcal: null,
      heartRate: [],
    });
  });

  it("reads the same in pieces of any size", () => {
    const whole = read(sampleExportXml());
    for (const size of [1, 5, 333, 4096]) {
      expect(read(sampleExportXml(), size), `pieces of ${size}`).toEqual(whole);
    }
  });

  it("gives a reading to every workout whose window holds it", () => {
    const xml = `<HealthData>
 <Record type="HKQuantityTypeIdentifierHeartRate" startDate="2026-11-01 10:10:00 +0000" value="120.4"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" startDate="2026-11-01 10:40:00 +0000" value="300"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" startDate="2026-11-01 11:30:00 +0000" value="90"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" startDate="2026-11-01 10:00:00 +0000" endDate="2026-11-01 11:00:00 +0000"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeWalking" startDate="2026-11-01 10:05:00 +0000" endDate="2026-11-01 10:20:00 +0000"/>
</HealthData>`;
    const [long, short] = read(xml).workouts;
    expect(long!.durationS).toBe(3600);
    expect(long!.heartRate).toEqual([{ recordedAt: Date.UTC(2026, 10, 1, 10, 10), bpm: 120 }]);
    expect(short!.heartRate).toEqual(long!.heartRate);
  });

  it("says when the file is not a Health export", () => {
    expect(read("<gpx></gpx>").isHealthExport).toBe(false);
  });
});

describe("parseGpx", () => {
  it("reads the track's name, type and points with their heart rate", () => {
    const parsed = parseGpx(sampleGpx());
    expect(Result.isSuccess(parsed)).toBe(true);
    const track = Result.getOrThrow(parsed);
    expect(track.name).toBe("Saturday ride & coffee");
    expect(track.type).toBe("cycling");
    expect(track.segments.map((points) => points.length)).toEqual([41]);
    expect(track.segments[0]![1]).toEqual({
      recordedAt: SAMPLE_GPX_START + MINUTE,
      latitude: 59.3345,
      longitude: 18.07,
      altitudeM: 31,
      heartRate: 121,
    });
  });

  it("reads an Apple Health route, whose points carry no heart rate", () => {
    const track = Result.getOrThrow(parseGpx(sampleRouteGpx()));
    expect(track.segments.map((points) => points.length)).toEqual([61]);
    expect(track.segments[0]![0]).toMatchObject({ recordedAt: SAMPLE_RUN_START, heartRate: null });
  });

  it("keeps each segment of each track apart, and takes the first track's name", () => {
    const point = (lat: number) =>
      `<trkpt lat="${lat}" lon="18"><time>2026-11-07T09:0${lat}:00Z</time></trkpt>`;
    const track = Result.getOrThrow(
      parseGpx(
        `<gpx><trk><name>Out</name><trkseg>${point(1)}${point(2)}</trkseg><trkseg></trkseg><trkseg>${point(3)}</trkseg></trk>` +
          `<trk><name>Back</name><trkseg>${point(4)}${point(5)}</trkseg></trk></gpx>`,
      ),
    );
    expect(track.name).toBe("Out");
    expect(track.segments.map((points) => points.map((p) => p.latitude))).toEqual([
      [1, 2],
      [3],
      [4, 5],
    ]);
  });

  it("refuses a file that is not GPX, or has a point off the map", () => {
    const health = parseGpx("<HealthData/>");
    expect(Result.isFailure(health) && health.failure.message).toBe("This is not a GPX file.");
    const offMap = parseGpx('<gpx><trk><trkseg><trkpt lat="95" lon="0"/></trkseg></trk></gpx>');
    expect(Result.isFailure(offMap) && offMap.failure.message).toBe(
      "Track point 1 is not a valid position and time.",
    );
  });
});

describe("zip", () => {
  it("lists a zip's files and inflates one as text", async () => {
    const source = bytesSource(sampleHealthZip());
    const entries = await listZipEntries(source);
    expect(entries.map((entry) => entry.name).toSorted()).toEqual([
      "apple_health_export/export.xml",
      "apple_health_export/export_cda.xml",
      `apple_health_export${SAMPLE_ROUTE_FILE}`,
    ]);
    const xml = entries.find((entry) => entry.name.endsWith("export.xml"))!;
    expect(await zipText(source, xml)).toBe(sampleExportXml());
  });

  it("reads a stored file and reports progress up to the whole file", async () => {
    const zip = zipSync({ "a.txt": [strToU8("hello"), { level: 0 }] });
    const source = bytesSource(zip);
    const [entry] = await listZipEntries(source);
    expect(entry!.method).toBe(0);
    const progress: Array<number> = [];
    const parts: Array<Uint8Array> = [];
    await readZipEntry(
      source,
      entry!,
      (bytes) => parts.push(bytes),
      (fraction) => progress.push(fraction),
    );
    expect(Buffer.concat(parts).toString()).toBe("hello");
    expect(progress.at(-1)).toBe(1);
  });

  it("refuses a file that is not a zip, or is cut short", async () => {
    await expect(listZipEntries(bytesSource(strToU8("not a zip at all")))).rejects.toMatchObject({
      message: "This is not a zip file.",
    });
    const zip = sampleHealthZip();
    const source = bytesSource(zip);
    const entries = await listZipEntries(source);
    const cut = bytesSource(zip.subarray(0, entries[0]!.localHeaderOffset + 100));
    await expect(zipText({ ...cut, size: zip.length }, entries[0]!)).rejects.toMatchObject({
      message: "The zip file is cut short.",
    });
  });
});
