import { Clock, Duration, Effect, Layer } from "effect";

/** A clock that only moves when told to, for tests and the deterministic fixture. */
export const manualClock = (startMillis: number) => {
  let millis = startMillis;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.sync(() => millis),
    currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(millis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(millis) * 1_000_000n),
    sleep: (duration) =>
      Effect.sync(() => {
        millis += Duration.toMillis(duration);
      }),
  };
  return {
    layer: Layer.succeed(Clock.Clock, clock),
    set: (next: number) =>
      Effect.sync(() => {
        millis = next;
      }),
    advance: (byMillis: number) =>
      Effect.sync(() => {
        millis += byMillis;
      }),
  };
};
