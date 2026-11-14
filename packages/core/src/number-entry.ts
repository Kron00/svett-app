export const KEYPAD_KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  ".",
  "0",
  "delete",
] as const;
export type KeypadKey = (typeof KEYPAD_KEYS)[number];

/** How a number is typed on the keypad and how far a stepper press moves it. */
export type NumberEntryLimits = {
  /** Digits allowed after the decimal point. 0 turns the decimal key off. */
  readonly decimals: number;
  readonly maxIntegerDigits: number;
  readonly step: number;
};

export const WEIGHT_KG_ENTRY: NumberEntryLimits = { decimals: 2, maxIntegerDigits: 4, step: 2.5 };
export const REPS_ENTRY: NumberEntryLimits = { decimals: 0, maxIntegerDigits: 3, step: 1 };

/** The text a number field holds after one keypad press. Presses that would break the limits change nothing. */
export const editNumberEntry = (
  value: string,
  key: KeypadKey,
  limits: NumberEntryLimits,
): string => {
  if (key === "delete") return value.slice(0, -1);
  const [integer = "", fraction] = value.split(".");
  if (key === ".") {
    if (limits.decimals === 0 || fraction !== undefined) return value;
    return `${integer === "" ? "0" : integer}.`;
  }
  if (fraction !== undefined) {
    return fraction.length < limits.decimals ? value + key : value;
  }
  if (integer === "0") return key;
  return integer.length < limits.maxIntegerDigits ? value + key : value;
};

/** The largest value the keypad can type within the limits, such as 9999.99. */
export const maxEntryValue = (limits: NumberEntryLimits): number =>
  10 ** limits.maxIntegerDigits - 10 ** -limits.decimals;

/**
 * Moves a value one step up or down, between zero and what the keypad could
 * type, without the float drift of 0.1 + 0.2.
 */
export const stepValue = (value: number, direction: 1 | -1, limits: NumberEntryLimits): number =>
  Math.min(
    maxEntryValue(limits),
    Math.max(0, Math.round((value + direction * limits.step) * 100) / 100),
  );
