import { firstRunAtLaunch } from "@svett/core";
import { Settings } from "react-native";

// Kept in the phone's user defaults, like the workout settings: it belongs to this install,
// and deleting svett forgets it.
const SEEN = "svettFirstRunSeen";

/** Read once at launch, so the first run neither shows nor hides itself mid-session. */
const atLaunch = firstRunAtLaunch(Settings.get(SEEN), Settings.get("svettFirstRun"));
if (atLaunch.remember) Settings.set({ [SEEN]: 1 });

/** Whether svett opened on its first-run screens. */
export const firstRunShown = (): boolean => atLaunch.show;

/** Remembers the first run was seen, whether it was finished or skipped. */
export const rememberFirstRunSeen = () => Settings.set({ [SEEN]: 1 });
