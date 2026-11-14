import { type CalendarMonth, nextLocalMidnight, type UtcOffset } from "@svett/core";
import { Clock } from "effect";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";

import { appDatabase } from "../data/database";

/** The phone's own time zone, with daylight saving time. */
export const PHONE_OFFSET: UtcOffset = (millis) => -new Date(millis).getTimezoneOffset();

/** "Sat, 1 Nov 2026" in the phone's language. */
export const formatDay = (millis: number): string =>
  new Date(millis).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** "Sat, 1 Nov 2026, 18:05" in the phone's language. */
export const formatDayAndTime = (millis: number): string =>
  `${formatDay(millis)}, ${new Date(millis).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })}`;

/** "November 2026" in the phone's language. */
export const formatMonth = ({ year, month }: CalendarMonth): string =>
  new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** "Tuesday 4 November" for a local day number, as VoiceOver reads a calendar day. */
export const formatDayNumber = (dayNumber: number): string =>
  new Date(dayNumber * 86_400_000).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

/**
 * The time now from Effect's Clock, or null until it is read. It is read again
 * when svett comes back to the foreground and at the next local midnight, so
 * today, this week's streak and this month move on while a screen stays open.
 */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  const read = useCallback(() => {
    void appDatabase().runPromise(Clock.currentTimeMillis).then(setNow);
  }, []);
  useEffect(() => {
    read();
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => foreground.remove();
  }, [read]);
  useEffect(() => {
    if (now === null) return;
    const midnight = setTimeout(read, nextLocalMidnight(now, PHONE_OFFSET) - now);
    return () => clearTimeout(midnight);
  }, [now, read]);
  return now;
}
