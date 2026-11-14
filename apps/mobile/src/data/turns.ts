// Imports, undos, syncs and the steps of a move into an account take turns. A move never
// copies or deletes the phone's data while an import is being applied to it, and a sync never
// reads or writes it during any of them.
let turn: Promise<unknown> = Promise.resolve();
const applying = new Set<Promise<unknown>>();

/** Runs `task` once every earlier import, undo and move step has finished, failed or not. */
export const inTurn = <A>(task: () => Promise<A>): Promise<A> => {
  const run = turn.then(task, task);
  turn = run.catch(() => undefined);
  return run;
};

/**
 * Like `inTurn`, for an import, an undo, a coach answer or a sync, which `transfersSettled`
 * then waits for.
 */
export const transferInTurn = <A>(task: () => Promise<A>): Promise<A> =>
  inTurn(() => {
    const run = task();
    applying.add(run);
    const done = () => {
      applying.delete(run);
    };
    run.then(done, done);
    return run;
  });

/**
 * Waits for the import, undo, coach answer or sync running now, so its database is not
 * closed under it.
 */
export const transfersSettled = async () => {
  await Promise.all([...applying].map((run) => run.catch(() => undefined)));
};
