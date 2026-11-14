/** A day as the phone's settings write it, such as 13 Nov 2026. */
export const formatDay = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
