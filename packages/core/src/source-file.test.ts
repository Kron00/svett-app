import { Result } from "effect";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vite-plus/test";

import {
  SAMPLE_GPX_START,
  SAMPLE_RUN_START,
  sampleExportXml,
  sampleGpx,
  sampleHealthZip,
} from "./health-sample.ts";
import { readSourceFile } from "./source-file.ts";
import { bytesSource } from "./zip.ts";

const options = { hourOf: (at: number) => new Date(at).getUTCHours() };

const readBytes = async (bytes: Uint8Array) =>
  Result.getOrThrow(await readSourceFile(bytesSource(bytes), options));

const refusal = async (bytes: Uint8Array) => {
  const read = await readSourceFile(bytesSource(bytes), options);
  return Result.isFailure(read) ? read.failure.message : "read";
};

describe("readSourceFile", () => {
  it("reads every workout in Apple Health's export.zip, with routes and heart rate", async () => {
    const file = await readBytes(sampleHealthZip());
    expect(file.source).toBe("apple_health");
    expect(file.skipped).toBe(1);
    expect(
      file.workouts.map(({ kind, title, route, heartRate }) => ({
        kind,
        title,
        route: route.length,
        heartRate: heartRate.length,
      })),
    ).toEqual([
      { kind: "run", title: "Morning run", route: 61, heartRate: 60 },
      { kind: "strength", title: "Evening workout", route: 0, heartRate: 110 },
      { kind: "ride", title: "Afternoon ride", route: 0, heartRate: 0 },
      { kind: "other", title: "Yoga", route: 0, heartRate: 0 },
    ]);
    expect(file.workouts[0]!.identity).toBe(
      `${new Date(SAMPLE_RUN_START).toISOString()} HKWorkoutActivityTypeRunning Sample Watch`,
    );
  });

  it("reads export.xml on its own, without routes", async () => {
    const file = await readBytes(strToU8(sampleExportXml()));
    expect(file.source).toBe("apple_health");
    expect(file.workouts.map((workout) => workout.route.length)).toEqual([0, 0, 0, 0]);
  });

  it("reads a GPX file as one workout named by its track, known by its first point's time", async () => {
    const progress: Array<number> = [];
    const read = await readSourceFile(bytesSource(strToU8(sampleGpx())), {
      ...options,
      onProgress: (fraction) => progress.push(fraction),
    });
    const file = Result.getOrThrow(read);
    expect(file.source).toBe("gpx");
    expect(progress.at(-1)).toBe(1);
    const [ride] = file.workouts;
    expect(ride).toMatchObject({
      source: "gpx",
      identity: new Date(SAMPLE_GPX_START).toISOString(),
      kind: "ride",
      title: "Saturday ride & coffee",
      startedAt: SAMPLE_GPX_START,
      durationS: 2400,
    });
    expect(ride!.distanceM).toBeCloseTo(20_000, -2);
    expect(ride!.heartRate).toHaveLength(41);
  });

  it("refuses other files with a message to show", async () => {
    expect(await refusal(strToU8("{}"))).toBe(
      "svett imports Apple Health's export.zip, its export.xml, or a GPX file. This is none of them.",
    );
    expect(
      await refusal(strToU8('<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>')),
    ).toBe("This GPX file has no times, so svett cannot tell when it happened.");
    expect(await refusal(strToU8('<HealthData><Workout workoutActivityType="'))).toBe(
      "The file ends partway through, so it may be cut short.",
    );
  });
});
