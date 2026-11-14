// Prints the entitlements to sign one bundle of the built app with, as XML, with
// build variables such as $(PRODUCT_BUNDLE_IDENTIFIER) expanded the way Xcode
// would. Prints nothing for a bundle whose target has no entitlements file. Run by
// scripts/build-ipa.sh, which signs ad hoc and so gets no help from Xcode.
//
// Usage: node scripts/signing-entitlements.ts --build-settings <settings.json>
//   --product <svett.app or Name.appex>
// where settings.json is `xcodebuild -showBuildSettings -json` for every target.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

const plist: { parse: (xml: string) => unknown; build: (value: unknown) => string } = createRequire(
  import.meta.url,
)("@expo/plist").default;

const TargetSettings = Schema.Struct({
  target: Schema.String,
  buildSettings: Schema.Record(Schema.String, Schema.String),
});
const decodeSettings = Schema.decodeUnknownSync(Schema.Array(TargetSettings));

// A free Apple account cannot sign push, and svett only schedules local notifications.
const UNSIGNABLE = ["aps-environment"];

// Xcode fills these in from the signing team, which an ad hoc signature does not have.
const TEAM_PREFIXES = new Set(["AppIdentifierPrefix", "TeamIdentifierPrefix"]);

const VARIABLE = /\$\(([^)]*)\)|\$\{([^}]*)\}/g;

export function expandVariables(text: string, settings: Readonly<Record<string, string>>): string {
  return text.replace(VARIABLE, (whole, paren: string | undefined, brace: string | undefined) => {
    const name = paren ?? brace ?? "";
    if (TEAM_PREFIXES.has(name)) {
      const team = settings.DEVELOPMENT_TEAM ?? "";
      if (team === "") throw new Error(`${whole} needs a development team, and the build has none`);
      return `${team}.`;
    }
    const value = settings[name];
    if (value === undefined) throw new Error(`${whole} is not a build setting of this target`);
    return value;
  });
}

const expandValue = (value: unknown, settings: Readonly<Record<string, string>>): unknown => {
  if (typeof value === "string") return expandVariables(value, settings);
  if (Array.isArray(value)) return value.map((item) => expandValue(item, settings));
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandValue(item, settings)]),
    );
  }
  return value;
};

export function expandEntitlements(
  xml: string,
  settings: Readonly<Record<string, string>>,
): string {
  const entitlements = expandValue(plist.parse(xml), settings);
  const unsignable = UNSIGNABLE.filter((key) =>
    Object.hasOwn(entitlements as Record<string, unknown>, key),
  );
  if (unsignable.length > 0) {
    throw new Error(`${unsignable.join(", ")} cannot be signed by a free Apple account`);
  }
  return plist.build(entitlements);
}

const entitlementsOf = (settings: Readonly<Record<string, string>>): string => {
  const file = settings.CODE_SIGN_ENTITLEMENTS ?? "";
  if (file === "") return "";
  const path = resolve(settings.SRCROOT ?? ".", file);
  return expandEntitlements(readFileSync(path, "utf8"), settings);
};

/**
 * The entitlements to sign `product`, such as svett.app, with, or "" when its
 * target has none. Xcode 27 can list a target more than once in
 * `-showBuildSettings -alltargets`, so entries that would sign alike count as one.
 */
export function entitlementsFor(settingsJson: string, product: string): string {
  const signings = decodeSettings(JSON.parse(settingsJson))
    .filter((target) => target.buildSettings.FULL_PRODUCT_NAME === product)
    .map((target) => ({
      target: target.target,
      entitlements: entitlementsOf(target.buildSettings),
    }));
  const [first, ...others] = signings;
  if (first === undefined) throw new Error(`No target builds ${product}`);
  const otherTarget = others.find((signing) => signing.target !== first.target);
  if (otherTarget !== undefined) {
    throw new Error(`${product} is built by ${first.target} and ${otherTarget.target}`);
  }
  if (others.some((signing) => signing.entitlements !== first.entitlements)) {
    throw new Error(
      `The build settings list ${first.target} more than once with different entitlements for ${product}`,
    );
  }
  return first.entitlements;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { "build-settings": { type: "string" }, product: { type: "string" } },
  });
  const { "build-settings": buildSettings, product } = values;
  if (!buildSettings || !product) throw new Error("--build-settings and --product are required");
  process.stdout.write(entitlementsFor(readFileSync(buildSettings, "utf8"), product));
}
