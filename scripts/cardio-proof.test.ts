import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pathLengthM, recordedDistanceM, replay } from "@svett/core";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { judge, legOf, legSeconds, readRoute, readSavedRecording } from "./cardio-proof.ts";
import { recordAlong, saveRecording } from "./test/cardio-recording.ts";

const routePath = fileURLToPath(new URL("sim/cardio-route.json", import.meta.url));
const script = fileURLToPath(new URL("cardio-proof.ts", import.meta.url));
const route = readRoute(routePath);
const T = 1_800_000_000_000;

describe("the proof route", () => {
  it("is 2.4 km long, so it makes two full splits and a partial one", () => {
    expect(pathLengthM(route.waypoints)).toBeCloseTo(2400, 0);
  });

  it("splits into two legs that meet at the pause", () => {
    expect(legOf(route, 1).at(-1)).toEqual(route.waypoints[route.pauseAt]);
    expect(legOf(route, 2)[0]).toEqual(route.waypoints[route.pauseAt]);
    expect(pathLengthM(legOf(route, 1)) + pathLengthM(legOf(route, 2))).toBeCloseTo(
      pathLengthM(route.waypoints),
      6,
    );
  });

  it("gives each leg's time at the route's speed", () => {
    expect(legSeconds(route, 1)).toBe(Math.ceil(pathLengthM(legOf(route, 1)) / route.speedMps));
  });

  it("records to within 1% of its length at 6 m/s with 5 m accuracy", () => {
    const length = pathLengthM(route.waypoints);
    const recorded = recordedDistanceM(replay(recordAlong(route, T))!);
    expect(Math.abs(recorded - length) / length).toBeLessThan(0.01);
  });

  it("prints a leg as the waypoints simctl location start takes", () => {
    const output = execFileSync(process.execPath, [script, "leg", routePath, "2"], {
      encoding: "utf8",
    });
    expect(output.trim()).toMatch(
      /^(-?\d+(\.\d+)?,-?\d+(\.\d+)?)( -?\d+(\.\d+)?,-?\d+(\.\d+)?){2}$/,
    );
  });
});

const saved = (distanceM: number) => ({
  title: "Morning run",
  distanceM,
  durationS: 400,
  splits: [
    { distanceM: 1000, durationS: 170 },
    { distanceM: 1000, durationS: 160 },
    { distanceM: distanceM - 2000, durationS: 70 },
  ],
});

describe("judge", () => {
  it("passes a distance within 1% whose splits add up", () => {
    expect(judge(2400, saved(2390)).ok).toBe(true);
  });

  it("fails a distance more than 1% off the route", () => {
    const verdict = judge(2400, saved(2370));
    expect(verdict.ok).toBe(false);
    expect(verdict.lines).toContain(
      "FAILED: Distance 2370.0 m against the route's 2400.0 m, off by 1.25%, within 1%",
    );
  });

  it("fails splits that do not add up to the distance or the time", () => {
    const short = { ...saved(2400), splits: saved(2400).splits.slice(0, 2) };
    expect(judge(2400, short).lines.filter((line) => line.startsWith("FAILED"))).toHaveLength(2);
  });
});

const check = (path: string, after: number) =>
  spawnSync(process.execPath, [script, "check", routePath, path, String(after)], {
    encoding: "utf8",
  });

describe("check", () => {
  const folder = mkdtempSync(join(tmpdir(), "cardio-proof-"));
  afterAll(() => rmSync(folder, { recursive: true }));
  it("passes a run recorded along the route, read back from its database file", async () => {
    const path = join(folder, "full.db");
    await saveRecording(path, recordAlong(route, T));
    const result = check(path, T);
    expect(result.stdout).toMatch(/^PASSED: Distance \d+\.\d m against the route's 2400\.0 m/m);
    expect(result.stdout).not.toContain("FAILED");
    expect(result.status).toBe(0);
  });

  it("fails a run that stopped 100 m short", async () => {
    const path = join(folder, "short.db");
    await saveRecording(path, recordAlong(route, T, 100));
    const result = check(path, T);
    expect(result.stdout).toMatch(/^FAILED: Distance/m);
    expect(result.status).toBe(1);
  });

  it("fails when nothing was recorded after the given time", async () => {
    const path = join(folder, "earlier.db");
    await saveRecording(path, recordAlong(route, T));
    expect(readSavedRecording(path, T + 1)).toBeNull();
    expect(check(path, T + 1).status).toBe(1);
  });
});
