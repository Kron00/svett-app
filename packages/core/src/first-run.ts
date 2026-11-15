/**
 * Whether svett opens on its first-run screens, from what this phone remembers and the
 * `-svettFirstRun` launch argument. `show` makes them open even after they were seen, for the
 * walkthrough proof. `skip` passes them and remembers that, as the proof scripts do, because
 * the screens would cover the tabs they press. Anything else shows them until they were seen.
 */
export const firstRunAtLaunch = (
  seen: unknown,
  argument: unknown,
): { readonly show: boolean; readonly remember: boolean } => {
  if (argument === "show") return { show: true, remember: false };
  if (argument === "skip") return { show: false, remember: !isSeen(seen) };
  return { show: !isSeen(seen), remember: false };
};

// iOS keeps a stored true as 1, and a launch argument arrives as a string.
const isSeen = (seen: unknown) => seen === true || seen === 1 || seen === "1" || seen === "YES";
