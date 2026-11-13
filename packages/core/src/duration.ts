import { Schema } from "effect";

export const DurationSeconds = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("DurationSeconds"));

export type DurationSeconds = typeof DurationSeconds.Type;

const twoDigits = (value: number): string => String(value).padStart(2, "0");

export const formatDuration = (duration: DurationSeconds): string => {
  const total = Math.floor(duration);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${minutes}:${twoDigits(seconds)}`;
};
