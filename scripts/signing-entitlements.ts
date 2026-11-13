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

/** The build settings of the target that builds `product`, such as svett.app. */
export function settingsFor(settingsJson: string, product: string): Record<string, string> {
  const targets = decodeSettings(JSON.parse(settingsJson)).filter(
    (target) => target.buildSettings.FULL_PRODUCT_NAME === product,
  );
  const [target, ...others] = targets;
  if (target === undefined) throw new Error(`No target builds ${product}`);
  if (others.length > 0) {
    throw new Error(`${product} is built by ${targets.map((t) => t.target).join(" and ")}`);
  }
  return { ...target.buildSettings };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { "build-settings": { type: "string" }, product: { type: "string" } },
  });
  const { "build-settings": buildSettings, product } = values;
  if (!buildSettings || !product) throw new Error("--build-settings and --product are required");
  const settings = settingsFor(readFileSync(buildSettings, "utf8"), product);
  const file = settings.CODE_SIGN_ENTITLEMENTS ?? "";
  if (file !== "") {
    const path = resolve(settings.SRCROOT ?? ".", file);
    process.stdout.write(expandEntitlements(readFileSync(path, "utf8"), settings));
  }
}
