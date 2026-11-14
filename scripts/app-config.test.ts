import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const mobile = fileURLToPath(new URL("../apps/mobile/", import.meta.url));

// The Info.plist and entitlements that `expo prebuild` would write, after every
// config plugin has run, without generating the iOS project.
const introspect = (): { infoPlist: Record<string, unknown>; entitlements: object } => {
  const json = execFileSync(
    "node_modules/.bin/expo",
    ["config", "--type", "introspect", "--json"],
    {
      cwd: mobile,
      encoding: "utf8",
      env: { ...process.env, EXPO_NO_GIT_STATUS: "1" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(json)["_internal"].modResults.ios;
};

describe("the iOS app config", { timeout: 60_000 }, () => {
  const ios = introspect();

  it("has no push entitlement, which a free Apple account cannot sign", () => {
    expect(ios.entitlements).not.toHaveProperty("aps-environment");
  });

  it("has the HealthKit entitlement", () => {
    expect(ios.entitlements).toMatchObject({
      "com.apple.developer.healthkit": true,
      "com.apple.developer.healthkit.access": [],
    });
  });

  it("explains location and Health access, and records location in the background", () => {
    expect(ios.infoPlist).toMatchObject({
      NSLocationWhenInUseUsageDescription: expect.stringMatching(/^svett /),
      NSLocationAlwaysAndWhenInUseUsageDescription: expect.stringMatching(/^svett /),
      NSHealthShareUsageDescription: expect.stringMatching(/^svett /),
      UIBackgroundModes: expect.arrayContaining(["location"]),
    });
    expect(ios.infoPlist).not.toHaveProperty("NSMotionUsageDescription");
    expect(ios.infoPlist.UIBackgroundModes).not.toContain("remote-notification");
  });
});
