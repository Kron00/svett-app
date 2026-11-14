import { Data } from "effect";

export class XmlError extends Data.TaggedError("XmlError")<{ readonly message: string }> {}

/** What the scanner reports. `attributes` is the tag's raw attribute text, read on demand. */
export interface XmlHandler {
  readonly open: (name: string, attributes: string, selfClosing: boolean) => void;
  readonly close: (name: string) => void;
  readonly text?: (raw: string) => void;
}

const ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** Replaces XML's character references, such as `&amp;` and `&#8217;`. */
export const decodeEntities = (text: string): string =>
  text.includes("&")
    ? text.replaceAll(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
        if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
        if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
        return ENTITIES[name] ?? whole;
      })
    : text;

const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A tag's attributes by name, with character references replaced. */
export const xmlAttributes = (raw: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    attributes[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
};

/**
 * Finds the next of one character in a piece of text, remembering where it is. A search
 * that finds nothing is never repeated, so a file with no single quotes, such as Apple
 * Health's export, is not scanned to its end once for every attribute.
 */
const finder = (data: string, char: string) => {
  let next = -2;
  return (from: number) => {
    if (next !== -1 && next < from) next = data.indexOf(char, from);
    return next;
  };
};

/** The index just past the `>` that ends the tag starting at `from`, or -1 if it has not arrived. */
const tagEnd = (
  data: string,
  from: number,
  double: (from: number) => number,
  single: (from: number) => number,
): number => {
  let at = from;
  for (;;) {
    const end = data.indexOf(">", at);
    if (end === -1) return -1;
    const nextDouble = double(at);
    const nextSingle = single(at);
    const quote =
      nextDouble === -1
        ? nextSingle
        : nextSingle === -1
          ? nextDouble
          : Math.min(nextDouble, nextSingle);
    if (quote === -1 || quote > end) return end + 1;
    const closing = data.indexOf(data[quote]!, quote + 1);
    if (closing === -1) return -1;
    at = closing + 1;
  }
};

/** The index just past a `<!DOCTYPE ...>` with its internal subset, or -1 if it has not arrived. */
const declarationEnd = (data: string, from: number): number => {
  let depth = 0;
  let quote = "";
  for (let at = from; at < data.length; at++) {
    const char = data[at]!;
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth++;
    else if (char === "]") depth--;
    else if (char === ">" && depth <= 0) return at + 1;
  }
  return -1;
};

const nameEnd = (tag: string): number => {
  const match = /[\s/>]/.exec(tag);
  return match === null ? tag.length : match.index;
};

/**
 * Reads XML as it arrives, in pieces of any size, and reports each tag. It keeps only the
 * piece of a tag that has not finished arriving, so a file of any size streams through.
 * It skips the prolog, comments and the document type, and reports CDATA as text.
 */
export class XmlScanner {
  private pending = "";
  private readonly handler: XmlHandler;

  constructor(handler: XmlHandler) {
    this.handler = handler;
  }

  push(chunk: string): void {
    const data = this.pending === "" ? chunk : this.pending + chunk;
    const { handler } = this;
    const double = finder(data, '"');
    const single = finder(data, "'");
    let at = 0;
    for (;;) {
      const lt = data.indexOf("<", at);
      if (lt === -1) {
        if (handler.text !== undefined && at < data.length) {
          this.pending = data.slice(at);
          return;
        }
        this.pending = "";
        return;
      }
      if (lt > at && handler.text !== undefined) handler.text(data.slice(at, lt));
      let end: number;
      const next = data[lt + 1];
      if (next === undefined) end = -1;
      else if (next === "?") {
        const close = data.indexOf("?>", lt + 2);
        end = close === -1 ? -1 : close + 2;
      } else if (next === "!") {
        if (data.startsWith("<!--", lt)) {
          const close = data.indexOf("-->", lt + 4);
          end = close === -1 ? -1 : close + 3;
        } else if (data.startsWith("<![CDATA[", lt)) {
          const close = data.indexOf("]]>", lt + 9);
          end = close === -1 ? -1 : close + 3;
          if (end !== -1 && handler.text !== undefined) {
            handler.text(
              data
                .slice(lt + 9, close)
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;"),
            );
          }
        } else if (data.length - lt < 9) end = -1;
        else end = declarationEnd(data, lt + 2);
      } else if (next === "/") {
        end = data.indexOf(">", lt + 2);
        if (end !== -1) {
          handler.close(data.slice(lt + 2, end).trim());
          end++;
        }
      } else {
        end = tagEnd(data, lt + 1, double, single);
        if (end !== -1) {
          const selfClosing = data[end - 2] === "/";
          const tag = data.slice(lt + 1, selfClosing ? end - 2 : end - 1);
          const split = nameEnd(tag);
          handler.open(tag.slice(0, split), tag.slice(split), selfClosing);
        }
      }
      if (end === -1) {
        this.pending = data.slice(lt);
        return;
      }
      at = end;
    }
  }

  /** Fails when the input stopped partway through a tag. */
  end(): void {
    const left = this.pending.trim();
    this.pending = "";
    if (left.startsWith("<")) {
      throw new XmlError({ message: "The file ends partway through, so it may be cut short." });
    }
  }
}
