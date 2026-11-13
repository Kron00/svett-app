import type { ExpoConfig } from "expo/config";

// Expo otherwise installs `typescript` on start. The workspace type checks with effect-tsgo.
process.env.EXPO_NO_TYPESCRIPT_SETUP = "1";

const config: ExpoConfig = {
  name: "svett",
  slug: "svett",
  scheme: "svett",
  version: "0.0.0",
  platforms: ["ios"],
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "com.kron00.svett",
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  plugins: [["expo-build-properties", { ios: { deploymentTarget: "27.0" } }]],
};

export default config;
