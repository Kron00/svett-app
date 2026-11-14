// Prints the AltStore source for svett, built from the repo's GitHub releases and
// the permissions inside the built app. Run by scripts/publish-release.sh.
//
// Usage: node scripts/altstore-source.ts --releases <gh api pages.json>
//   --info-plist <Info.plist as XML> --entitlements <entitlements as XML> [--pending <tag>]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

import { Schema } from "effect";

// @expo/plist is CommonJS with an ES default export, which Node and Vitest import
// differently. require() reads it the same way in both.
const parsePlist: (xml: string) => unknown = createRequire(import.meta.url)("@expo/plist").default
  .parse;

const REPO = "Kron00/svett-app";
const IPA = "svett.ipa";
const BUNDLE_ID = "com.kron00.svett";
const MIN_OS_VERSION = "27.0";
const TINT_COLOR = "#E4202E";
const ICON_URL = `https://raw.githubusercontent.com/${REPO}/main/apps/mobile/assets/icon.png`;
export const SOURCE_URL = `https://github.com/${REPO}/releases/latest/download/altstore.json`;
const SUBTITLE = "Lifting and cardio in one history";
const DESCRIPTION =
  "svett logs lifting and cardio in one history. It works offline, exports all your data, and runs its coach on your own ChatGPT plan.";

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  body: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  published_at: Schema.NullOr(Schema.String),
  assets: Schema.Array(Schema.Struct({ name: Schema.String, size: Schema.Number })),
});
export type GitHubRelease = typeof GitHubRelease.Type;

// `gh api --paginate --slurp` prints one array per page.
const decodeReleasePages = Schema.decodeUnknownSync(Schema.Array(Schema.Array(GitHubRelease)));
const decodePlistDict = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeUsageDescription = Schema.decodeUnknownSync(Schema.String);

export interface AltStoreVersion {
  readonly version: string;
  readonly buildVersion: string;
  readonly date: string;
  readonly localizedDescription: string;
  readonly downloadURL: string;
  readonly size: number;
  readonly minOSVersion: string;
}

export interface AppPermissions {
  readonly entitlements: readonly string[];
  readonly privacy: Readonly<Record<string, string>>;
}

// A release tag is v<major>.<minor>.<build>, where build is the commit count on main.
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseReleasePages(json: string): GitHubRelease[] {
  return decodeReleasePages(JSON.parse(json)).flat();
}

/**
 * Lists every published release that carries svett.ipa, newest first. The draft
 * named by `pendingTag` is listed as if published, so the source can be attached
 * to it before it goes live. It must be the newest version: the source lists the
 * pending build's permissions, which would be wrong for a newer release, so a
 * rerun or out-of-order run fails and leaves its draft unpublished.
 */
export function listVersions(
  releases: readonly GitHubRelease[],
  pendingTag?: string,
): AltStoreVersion[] {
  const listed = releases.flatMap((release) => {
    const tag = RELEASE_TAG.exec(release.tag_name);
    const ipa = release.assets.find((asset) => asset.name === IPA);
    const published = !release.draft && !release.prerelease;
    if (!tag || !ipa || !(published || release.tag_name === pendingTag)) return [];
    const [, major, minor, build] = tag.map(Number) as [number, number, number, number];
    return [
      {
        tag: release.tag_name,
        order: [major, minor, build] as const,
        version: {
          version: `${major}.${minor}.${build}`,
          buildVersion: String(build),
          date: release.published_at ?? release.created_at,
          localizedDescription: release.body ?? "",
          downloadURL: `https://github.com/${REPO}/releases/download/${release.tag_name}/${IPA}`,
          size: ipa.size,
          minOSVersion: MIN_OS_VERSION,
        },
      },
    ];
  });
  const sorted = listed.toSorted(
    (a, b) => b.order[0] - a.order[0] || b.order[1] - a.order[1] || b.order[2] - a.order[2],
  );
  if (pendingTag !== undefined) {
    const [newest] = sorted;
    if (!sorted.some(({ tag }) => tag === pendingTag)) {
      throw new Error(`${pendingTag} is not a release that carries ${IPA}`);
    }
    if (newest !== undefined && newest.tag !== pendingTag) {
      throw new Error(`${pendingTag} is older than the newest release ${newest.version.version}`);
    }
  }
  return sorted.map(({ version }) => version);
}

const USAGE_DESCRIPTION = /^NS\w+UsageDescription$/;

/**
 * Reads the permissions AltStore checks from the built app: every entitlement in
 * its signature, and every usage description in its Info.plist. AltStore refuses
 * an app whose permissions differ from the ones its source lists.
 */
export function readPermissions(infoPlistXml: string, entitlementsXml: string): AppPermissions {
  const info = decodePlistDict(parsePlist(infoPlistXml));
  // codesign prints nothing for a signature that carries no entitlements.
  const entitlements =
    entitlementsXml.trim() === "" ? {} : decodePlistDict(parsePlist(entitlementsXml));
  return {
    entitlements: Object.keys(entitlements).toSorted(),
    privacy: Object.fromEntries(
      Object.keys(info)
        .filter((key) => USAGE_DESCRIPTION.test(key))
        .toSorted()
        .map((key) => [key, decodeUsageDescription(info[key])]),
    ),
  };
}

export function buildSource(versions: readonly AltStoreVersion[], permissions: AppPermissions) {
  if (versions.length === 0) throw new Error(`No release carries ${IPA}`);
  return {
    name: "svett",
    identifier: `${BUNDLE_ID}.source`,
    sourceURL: SOURCE_URL,
    subtitle: SUBTITLE,
    description: DESCRIPTION,
    iconURL: ICON_URL,
    website: `https://github.com/${REPO}`,
    tintColor: TINT_COLOR,
    featuredApps: [BUNDLE_ID],
    apps: [
      {
        name: "svett",
        bundleIdentifier: BUNDLE_ID,
        developerName: "Kron00",
        subtitle: SUBTITLE,
        localizedDescription: DESCRIPTION,
        iconURL: ICON_URL,
        tintColor: TINT_COLOR,
        category: "lifestyle",
        versions,
        appPermissions: permissions,
      },
    ],
    news: [],
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      releases: { type: "string" },
      "info-plist": { type: "string" },
      entitlements: { type: "string" },
      pending: { type: "string" },
    },
  });
  const { releases, "info-plist": infoPlist, entitlements, pending } = values;
  if (!releases || !infoPlist || !entitlements) {
    throw new Error("--releases, --info-plist and --entitlements are required");
  }
  const source = buildSource(
    listVersions(parseReleasePages(readFileSync(releases, "utf8")), pending),
    readPermissions(readFileSync(infoPlist, "utf8"), readFileSync(entitlements, "utf8")),
  );
  process.stdout.write(`${JSON.stringify(source, null, 2)}\n`);
}
