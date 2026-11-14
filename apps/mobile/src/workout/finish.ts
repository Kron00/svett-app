import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { unfinishedSets } from "@svett/core";
import { Alert } from "react-native";

import { discard, finish } from "./actions";
import { currentWorkout } from "./store";

const confirmFinish = (onFinished: () => void) => {
  const log = currentWorkout();
  if (log === null) return;
  const left = unfinishedSets(log.exercises);
  const finishNow = () =>
    void finish().then((result) => {
      if (result.finished) onFinished();
      else Alert.alert("The workout is not finished", result.problem);
    });
  Alert.alert(
    `Finish ${log.activity.title}?`,
    left === 0
      ? "It is saved to your history."
      : `${left === 1 ? "1 set" : `${left} sets`} not marked done ${left === 1 ? "is" : "are"} left out.`,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Finish workout", isPreferred: true, onPress: finishNow },
    ],
  );
};

/** Asks before it discards the workout in progress, and leaves only once the delete is saved. */
export const confirmDiscard = (onDiscarded: () => void) =>
  Alert.alert("Discard this workout?", "Nothing from it is saved to your history.", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Discard",
      style: "destructive",
      onPress: () =>
        void discard().then((discarded) => {
          if (discarded) onDiscarded();
        }),
    },
  ]);

/**
 * The workout header's items: Finish while a workout is ready, else none. A native bar
 * item keeps the bar's size at every text size and shows the Large Content Viewer on a
 * long press, where a React view in the bar would grow with Dynamic Type and clip.
 */
export const finishItems = (
  ready: boolean,
  onFinished: () => void,
): Array<NativeStackHeaderItem> =>
  ready
    ? [
        {
          type: "button",
          label: "Finish",
          variant: "plain",
          accessibilityLabel: "Finish",
          accessibilityHint: "Asks before it saves the workout to your history",
          onPress: () => confirmFinish(onFinished),
        },
      ]
    : [];
