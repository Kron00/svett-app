// index.ts imports this before anything else, so the time is as close to the bundle starting as
// JavaScript can tell. It imports nothing, so nothing runs ahead of it.
export const scriptStartedAt = Date.now();
