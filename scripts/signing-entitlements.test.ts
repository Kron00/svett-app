import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { expandEntitlements, expandVariables, settingsFor } from "./signing-entitlements.ts";

const plist: { parse: (xml: string) => unknown; build: (value: unknown) => string } = createRequire(
  import.meta.url,
)("@expo/plist").default;

const settings = {
  PRODUCT_BUNDLE_IDENTIFIER: "com.kron00.svett.widgets",
  DEVELOPMENT_TEAM: "",
};

describe("expandVariables", () => {
  it("expands both spellings of a build setting", () => {
    expect(expandVariables("group.$(PRODUCT_BUNDLE_IDENTIFIER)", settings)).toBe(
      "group.com.kron00.svett.widgets",
    );
    expect(expandVariables("${PRODUCT_BUNDLE_IDENTIFIER}.shared", settings)).toBe(
      "com.kron00.svett.widgets.shared",
    );
  });

  it("expands the team prefix from the development team", () => {
    expect(
      expandVariables("$(AppIdentifierPrefix)com.kron00.svett", {
        ...settings,
        DEVELOPMENT_TEAM: "ABCDE12345",
      }),
    ).toBe("ABCDE12345.com.kron00.svett");
  });

  it("refuses a team prefix when the build has no team", () => {
    expect(() => expandVariables("$(AppIdentifierPrefix)com.kron00.svett", settings)).toThrow(
      "$(AppIdentifierPrefix) needs a development team",
    );
  });

  it("refuses a variable the target does not define", () => {
    expect(() => expandVariables("$(NOT_A_SETTING)", settings)).toThrow(
      "$(NOT_A_SETTING) is not a build setting of this target",
    );
  });
});

describe("expandEntitlements", () => {
  it("expands variables in nested values and keeps every key", () => {
    const xml = plist.build({
      "com.apple.developer.healthkit": true,
      "com.apple.developer.healthkit.access": [],
      "com.apple.security.application-groups": ["group.$(PRODUCT_BUNDLE_IDENTIFIER)"],
    });
    expect(plist.parse(expandEntitlements(xml, settings))).toEqual({
      "com.apple.developer.healthkit": true,
      "com.apple.developer.healthkit.access": [],
      "com.apple.security.application-groups": ["group.com.kron00.svett.widgets"],
    });
  });

  it("refuses push entitlements, which a free Apple account cannot sign", () => {
    const xml = plist.build({ "aps-environment": "development" });
    expect(() => expandEntitlements(xml, settings)).toThrow(
      "aps-environment cannot be signed by a free Apple account",
    );
  });
});

const target = (name: string, product: string, extra: Record<string, string> = {}) => ({
  action: "build",
  target: name,
  buildSettings: { FULL_PRODUCT_NAME: product, ...extra },
});

describe("settingsFor", () => {
  const json = JSON.stringify([
    target("svett", "svett.app"),
    target("Widgets", "Widgets.appex", { PRODUCT_BUNDLE_IDENTIFIER: "com.kron00.svett.widgets" }),
  ]);

  it("finds the target that builds the product", () => {
    expect(settingsFor(json, "Widgets.appex").PRODUCT_BUNDLE_IDENTIFIER).toBe(
      "com.kron00.svett.widgets",
    );
  });

  it("refuses a product no target builds, so an extension is never signed blind", () => {
    expect(() => settingsFor(json, "Other.appex")).toThrow("No target builds Other.appex");
  });
});

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "signing-entitlements-"));
  mkdirSync(join(root, "ios", "Widgets"), { recursive: true });
  writeFileSync(
    join(root, "ios", "Widgets", "Widgets.entitlements"),
    plist.build({
      "com.apple.security.application-groups": ["group.$(PRODUCT_BUNDLE_IDENTIFIER)"],
    }),
  );
  const settingsFile = join(root, "settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify([
      target("svett", "svett.app", { SRCROOT: join(root, "ios"), CODE_SIGN_ENTITLEMENTS: "" }),
      target("Widgets", "Widgets.appex", {
        SRCROOT: join(root, "ios"),
        CODE_SIGN_ENTITLEMENTS: "Widgets/Widgets.entitlements",
        PRODUCT_BUNDLE_IDENTIFIER: "com.kron00.svett.widgets",
      }),
    ]),
  );
  return settingsFile;
};

describe("signing-entitlements.ts", () => {
  const script = fileURLToPath(new URL("signing-entitlements.ts", import.meta.url));
  const run = (settingsFile: string, product: string) =>
    spawnSync(process.execPath, [script, "--build-settings", settingsFile, "--product", product], {
      encoding: "utf8",
    });

  it("prints an extension's own entitlements, read relative to its project", () => {
    const result = run(project(), "Widgets.appex");
    expect(result.status).toBe(0);
    expect(plist.parse(result.stdout)).toEqual({
      "com.apple.security.application-groups": ["group.com.kron00.svett.widgets"],
    });
  });

  it("prints nothing for a target without an entitlements file", () => {
    const result = run(project(), "svett.app");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
