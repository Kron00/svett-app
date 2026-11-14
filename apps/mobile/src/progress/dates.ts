import type { CalendarMonth, UtcOffset } from "@svett/core";
import { useState } from "react";

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

/** The time the screen opened, so a render never reads the clock. */
export const useNow = (): number => useState(() => Date.now())[0];
