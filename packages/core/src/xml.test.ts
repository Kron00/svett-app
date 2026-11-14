import { describe, expect, it } from "vite-plus/test";

import { decodeEntities, XmlError, XmlScanner, xmlAttributes } from "./xml.ts";

const scan = (pieces: ReadonlyArray<string>, withText = true) => {
  const events: Array<string> = [];
  const scanner = new XmlScanner({
    open: (name, attributes, selfClosing) =>
      events.push(
        `open ${name} ${JSON.stringify(xmlAttributes(attributes))}${selfClosing ? " /" : ""}`,
      ),
    close: (name) => events.push(`close ${name}`),
    ...(withText
      ? {
          text: (raw: string) => {
            if (raw.trim() !== "") events.push(`text ${decodeEntities(raw).trim()}`);
          },
        }
      : {}),
  });
  for (const piece of pieces) scanner.push(piece);
  scanner.end();
  return events;
};

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!-- a comment with > inside -->
<!ELEMENT HealthData (Record*)>
<!ATTLIST Record type CDATA #REQUIRED>
]>
<HealthData locale="en_GB">
 <!-- skipped -->
 <Record type="A" device="&lt;&lt;HKDevice&gt;, name:Watch&gt;" note='says "hi" > there'/>
 <name>Run &amp; coffee</name>
 <![CDATA[raw <text> & more]]>
</HealthData>
`;

describe("XmlScanner", () => {
  it("reports tags and text, and skips the prolog, comments and document type", () => {
    expect(scan([DOCUMENT])).toEqual([
      'open HealthData {"locale":"en_GB"}',
      'open Record {"type":"A","device":"<<HKDevice>, name:Watch>","note":"says \\"hi\\" > there"} /',
      "open name {}",
      "text Run & coffee",
      "close name",
      "text raw <text> & more",
      "close HealthData",
    ]);
  });

  it("reports the same whatever size the pieces arrive in", () => {
    const whole = scan([DOCUMENT]);
    for (const size of [1, 2, 3, 7, 64]) {
      const pieces = Array.from({ length: Math.ceil(DOCUMENT.length / size) }, (_, index) =>
        DOCUMENT.slice(index * size, (index + 1) * size),
      );
      expect(scan(pieces), `pieces of ${size}`).toEqual(whole);
    }
  });

  it("works without a text handler", () => {
    expect(scan([DOCUMENT], false).filter((event) => event.startsWith("text"))).toEqual([]);
  });

  it("refuses a file that stops partway through a tag", () => {
    expect(() => scan(['<HealthData><Record type="A'])).toThrow(XmlError);
  });

  it("refuses a file cut short between two complete tags", () => {
    const cut = DOCUMENT.slice(0, DOCUMENT.indexOf("</HealthData>"));
    expect(() => scan([cut])).toThrow("The file ends partway through, so it may be cut short.");
    expect(() => scan(["<a><b></b>"])).toThrow(XmlError);
  });

  it("refuses a tag that closes an element that is not open", () => {
    expect(() => scan(["<a><b></a></b>"])).toThrow(
      "The file closes <a> where it should not, so it may be damaged.",
    );
    expect(() => scan(["<a></a></a>"])).toThrow(XmlError);
  });
});

describe("decodeEntities", () => {
  it("replaces named and numeric references", () => {
    expect(decodeEntities("Sam&#8217;s &#x2764; &quot;watch&quot; &unknown;")).toBe(
      'Sam\u2019s \u2764 "watch" &unknown;',
    );
  });
});
