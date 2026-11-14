import { type ByteSource, readSourceFile } from "@svett/core";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";

import type { ImportFileSource } from "../transfer/files";

/**
 * Opens the document picker for Apple Health's export.zip or a GPX file. iOS has no
 * type for GPX that every app uses, so any file can be picked and the reader says
 * when it is neither.
 */
export const pickSourceFile = async (): Promise<ImportFileSource | null> => {
  const picked = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
  const asset = picked.canceled ? undefined : picked.assets[0];
  return asset === undefined ? null : { uri: asset.uri };
};

/** The same rule as D1's import: a picked file from the cache, or a plain name in Documents. */
const fileOf = (source: ImportFileSource): File | undefined =>
  "uri" in source
    ? source.uri.startsWith(Paths.cache.uri) && !source.uri.includes("..")
      ? new File(source.uri)
      : undefined
    : /^\w[\w.-]*$/.test(source.file)
      ? new File(Paths.document, source.file)
      : undefined;

/**
 * Reads the file's workouts a megabyte at a time through one file handle. Reads queue
 * behind each other, because the handle has one position.
 */
export const readWorkoutFile = async (
  source: ImportFileSource,
  onProgress: (fraction: number) => void,
) => {
  const file = fileOf(source);
  if (file === undefined) throw new Error("svett can only open a file you picked.");
  const handle = file.open();
  let queue: Promise<unknown> = Promise.resolve();
  const bytes: ByteSource = {
    size: handle.size ?? file.size,
    read: (offset, length) => {
      const next = queue.then(() => {
        handle.offset = offset;
        return handle.readBytes(length);
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
  try {
    return await readSourceFile(bytes, {
      hourOf: (at) => new Date(at).getHours(),
      onProgress,
    });
  } finally {
    handle.close();
  }
};
