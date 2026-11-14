import { TransferRepository } from "@svett/core";
import { Effect } from "effect";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { appDatabase } from "../data/database";

/** Runs `body` with the transfer repository of the database this launch opened. */
export const withTransfers = <A, E>(
  body: (transfers: typeof TransferRepository.Service) => Effect.Effect<A, E>,
) => appDatabase().runPromise(Effect.flatMap(Effect.service(TransferRepository), body));

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

/** Opens the document picker and returns the picked file, or nothing when cancelled. */
export const pickImportFile = async (): Promise<ImportFileSource | null> => {
  const picked = await DocumentPicker.getDocumentAsync({
    type: "application/json",
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
