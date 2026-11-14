import { ExerciseAliasRepository, ExerciseRepository, TransferRepository } from "@svett/core";
import { Effect } from "effect";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { currentDatabase, type OpenDatabase, stillOpen } from "../data/current";
import { write } from "../data/store";
import { transferInTurn } from "../data/turns";

/** Runs `body` with the transfer repository of `database`, by default the open one. */
export const withTransfers = <A, E>(
  body: (transfers: typeof TransferRepository.Service) => Effect.Effect<A, E>,
  database: OpenDatabase = currentDatabase(),
) => database.handle.runtime.runPromise(Effect.flatMap(Effect.service(TransferRepository), body));

export const DATABASE_SWITCHED =
  "Someone signed in or out before it ran, so svett saved nothing to either account. Open it again to see what it does to the data open now.";

/**
 * Applies an import or an undo to `database`, the one its preview was made for, so history and
 * every other screen read again. It takes its turn with a move into an account, so a move never
 * copies the phone's data while an import is being applied to it. When its turn comes after
 * someone signed in or out, it refuses, because its choices were made for the other data.
 */
export const changeTransfers = <A, E>(
  database: OpenDatabase,
  body: (transfers: typeof TransferRepository.Service) => Effect.Effect<A, E>,
) =>
  transferInTurn(() =>
    stillOpen(database)
      ? write(Effect.flatMap(Effect.service(TransferRepository), body))
      : Promise.reject(new Error(DATABASE_SWITCHED)),
  );

/** Runs `body` with the exercise name matches of `database`, by default the open one. */
export const withAliases = <A, E>(
  body: (aliases: typeof ExerciseAliasRepository.Service) => Effect.Effect<A, E>,
  database: OpenDatabase = currentDatabase(),
) =>
  database.handle.runtime.runPromise(Effect.flatMap(Effect.service(ExerciseAliasRepository), body));

/**
 * Saves exercise name matches to `database`, the one the match screen read its names from. It
 * takes its turn like an import and refuses after someone signed in or out, because the
 * exercises it names belong to the other data.
 */
export const changeAliases = <A, E>(
  database: OpenDatabase,
  body: (aliases: typeof ExerciseAliasRepository.Service) => Effect.Effect<A, E>,
) =>
  transferInTurn(() =>
    stillOpen(database)
      ? write(Effect.flatMap(Effect.service(ExerciseAliasRepository), body))
      : Promise.reject(new Error(DATABASE_SWITCHED)),
  );

/** Runs `body` with the exercises of `database`, by default the open one. */
export const withExercises = <A, E>(
  body: (exercises: typeof ExerciseRepository.Service) => Effect.Effect<A, E>,
  database: OpenDatabase = currentDatabase(),
) => database.handle.runtime.runPromise(Effect.flatMap(Effect.service(ExerciseRepository), body));

/**
 * Writes the export to the cache folder and opens the share sheet on it. The copy stays in
 * the cache, where iOS may clear it, so the file the user saves is the one that counts.
 */
export const exportAndShare = async () => {
  const { name, text, rows } = await withTransfers((transfers) => transfers.exportFile);
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  await Sharing.shareAsync(file.uri, {
    mimeType: "application/json",
    UTI: "public.json",
    dialogTitle: "Export svett data",
  });
  return { name, rows };
};

/** Where an import's file comes from: the document picker, or a file in svett's documents. */
export type ImportFileSource = { readonly uri: string } | { readonly file: string };

/** What a file to import holds: a svett export, or Hevy's workout CSV. */
export type ImportKind = "svett" | "hevy";

const PICKER_TYPES: Readonly<Record<ImportKind, ReadonlyArray<string>>> = {
  svett: ["application/json"],
  hevy: ["text/csv", "text/comma-separated-values"],
};

/** Opens the document picker and returns the picked file, or nothing when cancelled. */
export const pickImportFile = async (kind: ImportKind): Promise<ImportFileSource | null> => {
  const picked = await DocumentPicker.getDocumentAsync({
    type: [...PICKER_TYPES[kind]],
    copyToCacheDirectory: true,
  });
  const asset = picked.canceled ? undefined : picked.assets[0];
  return asset === undefined ? null : { uri: asset.uri };
};

/**
 * Reads the file to import. A link can name either kind of source, so a picked file is read
 * only from the cache folder the picker copies into, and a plain name, as
 * svett://import?file=<name> gives, only from svett's own documents folder.
 */
export const readImportFile = (source: ImportFileSource): Promise<string> => {
  const file =
    "uri" in source
      ? source.uri.startsWith(Paths.cache.uri) && !source.uri.includes("..")
        ? new File(source.uri)
        : undefined
      : /^\w[\w.-]*$/.test(source.file)
        ? new File(Paths.document, source.file)
        : undefined;
  return file === undefined
    ? Promise.reject(new Error("svett can only open a file you picked."))
    : file.text();
};
