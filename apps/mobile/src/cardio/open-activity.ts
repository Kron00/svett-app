import { type Activity, CardioKind } from "@svett/core";
import { Schema } from "effect";

import type { RootNavigation } from "../navigation";

const isCardio = Schema.is(CardioKind);

/** Opens a past activity on its detail screen: a recorded sport on its route, anything else as a workout. */
export const openActivity = (
  navigation: RootNavigation,
  activity: Pick<Activity, "id" | "kind">,
) =>
  isCardio(activity.kind)
    ? navigation.navigate("Activity", { id: activity.id })
    : navigation.navigate("Workout", { id: activity.id });
