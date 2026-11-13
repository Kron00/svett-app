import type { ExpoConfig } from "expo/config";

// Expo otherwise installs `typescript` on start. The workspace type checks with effect-tsgo.
process.env.EXPO_NO_TYPESCRIPT_SETUP = "1";

// scripts/build-ipa.sh sets SVETT_BUILD_NUMBER, by default to the commit count on
// main, so every merge is a newer version than the last one AltStore installed.
const marketingVersion = "0.1";
const buildNumber = process.env.SVETT_BUILD_NUMBER ?? "0";
if (!/^\d+$/.test(buildNumber)) {
  throw new Error(`SVETT_BUILD_NUMBER must be a whole number, got "${buildNumber}"`);
}

const config: ExpoConfig = {
  name: "svett",
  slug: "svett",
  scheme: "svett",
  version: `${marketingVersion}.${buildNumber}`,
  platforms: ["ios"],
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  ios: {
    bundleIdentifier: "com.kron00.svett",
    buildNumber,
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSHealthShareUsageDescription: "svett reads your workouts from Apple Health.",
    },
    entitlements: {
      "com.apple.developer.healthkit": true,
      "com.apple.developer.healthkit.access": [],
    },
  },
  plugins: [
    ["expo-build-properties", { ios: { deploymentTarget: "27.0" } }],
    "expo-sqlite",
    [
      "expo-location",
      {
        locationWhenInUsePermission: "svett uses your location to record the route of a run.",
        locationAlwaysAndWhenInUsePermission:
          "svett keeps recording the route of a run while the screen is locked.",
        locationAlwaysPermission:
          "svett keeps recording the route of a run while the screen is locked.",
        locationFullAccuracyPermission: "svett needs your precise location to map a run.",
        motionUsagePermission: false,
        isIosBackgroundLocationEnabled: true,
      },
    ],
    // svett schedules only local notifications. Push needs aps-environment, which a
    // free Apple account cannot sign, so AltStore could not install the app.
    ["expo-notifications", { enableRemoteNotifications: false }],
  ],
};

export default config;
