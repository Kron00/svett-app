import type { ExpoConfig } from "expo/config";

// Expo otherwise installs `typescript` on start. The workspace type checks with effect-tsgo.
process.env.EXPO_NO_TYPESCRIPT_SETUP = "1";

// The release job sets SVETT_BUILD_NUMBER to the commit count on main, so every
// merge is a newer version than the last one AltStore installed.
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
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "com.kron00.svett",
    buildNumber,
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  plugins: [["expo-build-properties", { ios: { deploymentTarget: "27.0" } }]],
};

export default config;
