import type { RoutineForm, RoutineId } from "@svett/core";
import { useSyncExternalStore } from "react";

/**
 * The routine being edited. It lives outside the editor screen so the exercise picker,
 * a screen of its own, can add to it, and so can a link that opens the picker.
 */
export interface RoutineDraft {
  /** The editor screen that owns the draft, by its route key. */
  readonly owner: string;
  /** The routine being edited, or null for a new one. */
  readonly routineId: RoutineId | null;
  readonly form: RoutineForm;
}

let draft: RoutineDraft | null = null;
const listeners = new Set<() => void>();

const publish = (next: RoutineDraft | null) => {
  draft = next;
  for (const listener of listeners) listener();
};

export const openDraft = (next: RoutineDraft) => publish(next);

export const changeDraft = (change: (form: RoutineForm) => RoutineForm) => {
  if (draft !== null) publish({ ...draft, form: change(draft.form) });
};

/** Drops the draft, unless another editor has opened its own since. */
export const closeDraft = (owner: string) => {
  if (draft?.owner === owner) publish(null);
};

export const currentDraft = () => draft;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useDraft = (): RoutineDraft | null =>
  useSyncExternalStore(subscribe, currentDraft, currentDraft);
