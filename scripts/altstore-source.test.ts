import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  SOURCE_URL,
  buildSource,
  listVersions,
  parseReleasePages,
  readPermissions,
} from "./altstore-source.ts";

const fixture = (name: string) => fileURLToPath(new URL(`test/fixtures/${name}`, import.meta.url));
const read = (name: string) => readFileSync(fixture(name), "utf8");
const releases = parseReleasePages(read("releases.json"));
const publishedRelease = (tag_name: string) => ({
  tag_name,
  draft: false,
  prerelease: false,
  body: null,
  created_at: "2026-11-14T00:00:00Z",
  published_at: "2026-11-14T00:00:00Z",
  assets: [{ name: "svett.ipa", size: 1 }],
});

describe("listVersions", () => {
  it("lists published releases that carry svett.ipa, newest version first", () => {
    expect(listVersions(releases).map((v) => v.version)).toEqual(["0.1.37", "0.1.9"]);
  });

  it("lists the pending draft as the newest version, dated when it was created", () => {
    const [newest] = listVersions(releases, "v0.1.38");
    expect(newest).toEqual({
      version: "0.1.38",
      buildVersion: "38",
      date: "2026-11-14T09:12:00Z",
      localizedDescription: "Add the release path to AltStore (#5)",
      downloadURL: "https://github.com/Kron00/svett-app/releases/download/v0.1.38/svett.ipa",
      size: 31457280,
      minOSVersion: "27.0",
    });
  });

  it("keeps every earlier release as an older version after a new one", () => {
    expect(listVersions(releases, "v0.1.38").map((v) => [v.version, v.buildVersion])).toEqual([
      ["0.1.38", "38"],
      ["0.1.37", "37"],
      ["0.1.9", "9"],
    ]);
  });

  it("refuses a pending release older than the newest published one", () => {
    const newer = [...releases, publishedRelease("v0.1.40")];
    expect(() => listVersions(newer, "v0.1.38")).toThrow(
      "v0.1.38 is older than the newest release 0.1.40",
    );
  });

  it("refuses a pending tag that is not a release with svett.ipa", () => {
    expect(() => listVersions(releases, "v0.1.20")).toThrow(
      "v0.1.20 is not a release that carries svett.ipa",
    );
    expect(() => listVersions(releases, "v0.1.99")).toThrow("v0.1.99 is not a release");
  });

  it("orders by major and minor before the build number", () => {
    const versions = listVersions([
      publishedRelease("v0.9.80"),
      publishedRelease("v1.0.81"),
      publishedRelease("v0.10.79"),
    ]);
    expect(versions.map((v) => v.version)).toEqual(["1.0.81", "0.10.79", "0.9.80"]);
  });
});

describe("readPermissions", () => {
  it("reads every entitlement and usage description, and nothing else", () => {
    expect(readPermissions(read("Info.plist"), read("entitlements.plist"))).toEqual({
      entitlements: ["com.apple.developer.healthkit", "com.apple.developer.healthkit.access"],
      privacy: {
        NSHealthShareUsageDescription: "svett reads workouts from Apple Health.",
        NSLocationWhenInUseUsageDescription: "svett records the route of your run.",
      },
    });
  });

  it("reads an app signed with an empty entitlements file as having none", () => {
    const empty = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>';
    expect(readPermissions(empty, empty)).toEqual({ entitlements: [], privacy: {} });
  });

  it("reads a signature that codesign prints no entitlements for as having none", () => {
    expect(readPermissions(read("Info.plist"), "").entitlements).toEqual([]);
  });

  it("rejects a usage description that is not text", () => {
    const info =
      '<plist version="1.0"><dict><key>NSCameraUsageDescription</key><true/></dict></plist>';
    expect(() => readPermissions(info, read("entitlements.plist"))).toThrow();
  });
});

describe("buildSource", () => {
  it("refuses to publish a source with no version to install", () => {
    expect(() => buildSource([], { entitlements: [], privacy: {} })).toThrow(
      "No release carries svett.ipa",
    );
  });
});

describe("altstore-source.ts", () => {
  it("prints a source whose app lists the versions and the built app's permissions", () => {
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL("altstore-source.ts", import.meta.url)),
      "--releases",
      fixture("releases.json"),
      "--info-plist",
      fixture("Info.plist"),
      "--entitlements",
      fixture("entitlements.plist"),
      "--pending",
      "v0.1.38",
    ]);
    const source = JSON.parse(output.toString());
    expect(source.sourceURL).toBe(SOURCE_URL);
    expect(source.tintColor).toBe("#E4202E");
    expect(source.apps).toHaveLength(1);
    const [app] = source.apps;
    expect(app.bundleIdentifier).toBe("com.kron00.svett");
    expect(app.tintColor).toBe("#E4202E");
    expect(app.iconURL).toBe(
      "https://raw.githubusercontent.com/Kron00/svett-app/main/apps/mobile/assets/icon.png",
    );
    expect(app.versions.map((v: { version: string }) => v.version)).toEqual([
      "0.1.38",
      "0.1.37",
      "0.1.9",
    ]);
    expect(app.appPermissions).toEqual(
      readPermissions(read("Info.plist"), read("entitlements.plist")),
    );
  });

  it("fails without printing a source when a newer release is already published", () => {
    const dir = mkdtempSync(join(tmpdir(), "altstore-source-"));
    const pages = join(dir, "releases.json");
    writeFileSync(
      pages,
      JSON.stringify([...JSON.parse(read("releases.json")), [publishedRelease("v0.1.40")]]),
    );
    const run = spawnSync(process.execPath, [
      fileURLToPath(new URL("altstore-source.ts", import.meta.url)),
      "--releases",
      pages,
      "--info-plist",
      fixture("Info.plist"),
      "--entitlements",
      fixture("entitlements.plist"),
      "--pending",
      "v0.1.38",
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stdout.toString()).toBe("");
    expect(run.stderr.toString()).toContain("v0.1.38 is older than the newest release 0.1.40");
  });

  it("is the address the README tells people to add in AltStore", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(SOURCE_URL).toBe(
      "https://github.com/Kron00/svett-app/releases/latest/download/altstore.json",
    );
    expect(readme).toContain(SOURCE_URL);
  });
});
