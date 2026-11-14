import { decodeMoveJournal, encodeMoveJournal, type MoveJournal } from "@svett/core";
import Storage from "expo-sqlite/kv-store";

// Kept outside every owner's database, so it survives the anonymous database being deleted.
const JOURNAL_KEY = "svett.moveJournal";

/** What the phone did with its own data on the first sign-in, if it answered yet. */
export const storedMoveJournal = () => decodeMoveJournal(Storage.getItemSync(JOURNAL_KEY));

export const storeMoveJournal = (journal: MoveJournal) =>
  Storage.setItemSync(JOURNAL_KEY, encodeMoveJournal(journal));
