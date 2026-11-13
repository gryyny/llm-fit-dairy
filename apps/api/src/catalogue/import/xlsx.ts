import { SaxesParser } from "saxes";
import { openZipBuffer, readAll } from "./zip.js";

/** Column letters of a cell reference such as "AB12" → "AB". */
const columnOf = (ref: string) => /^[A-Z]+/.exec(ref)?.[0] ?? "";

function sharedStrings(xml: Buffer | null): string[] {
  const strings: string[] = [];
  if (!xml) return strings;
  const parser = new SaxesParser();
  let current: string | null = null;
  let inText = false;
  let inPhonetic = false;
  parser.on("opentag", (tag) => {
    if (tag.name === "si") current = "";
    // Phonetic runs are reading aids, not part of the cell text.
    else if (tag.name === "rPh") inPhonetic = true;
    else if (tag.name === "t" && !inPhonetic) inText = true;
  });
  parser.on("text", (t) => {
    if (inText && current !== null) current += t;
  });
  parser.on("closetag", (tag) => {
    if (tag.name === "t") inText = false;
    else if (tag.name === "rPh") inPhonetic = false;
    else if (tag.name === "si" && current !== null) {
      strings.push(current);
      current = null;
    }
  });
  parser.write(xml.toString("utf8")).close();
  return strings;
}

/**
 * Streams the rows of the first worksheet of an XLSX workbook as column-letter → text maps.
 * Shared and inline strings keep their text. Numeric cells are stored by Excel as IEEE doubles
 * serialised with up to 17 digits (e.g. "9.3000000000000007"); they are rendered with the shortest
 * text that denotes the same double ("9.3"), which is the value the publisher entered.
 */
export async function* xlsxRows(workbook: Buffer): AsyncGenerator<Record<string, string>> {
  const zip = await openZipBuffer(workbook);
  try {
    const strings = sharedStrings(
      zip.names.includes("xl/sharedStrings.xml")
        ? await readAll(await zip.open("xl/sharedStrings.xml"))
        : null,
    );
    const parser = new SaxesParser();
    const ready: Record<string, string>[] = [];
    let row: Record<string, string> | null = null;
    let cell: { column: string; type: string | undefined } | null = null;
    let text = "";
    let capture = false;
    parser.on("opentag", (tag) => {
      const attr = (name: string) => {
        const value = tag.attributes[name];
        return typeof value === "string" ? value : undefined;
      };
      if (tag.name === "row") row = {};
      else if (tag.name === "c") {
        cell = { column: columnOf(attr("r") ?? ""), type: attr("t") };
        text = "";
      } else if (cell && (tag.name === "v" || tag.name === "t")) capture = true;
    });
    parser.on("text", (t) => {
      if (capture) text += t;
    });
    parser.on("closetag", (tag) => {
      if (tag.name === "v" || tag.name === "t") capture = false;
      else if (tag.name === "c" && cell && row) {
        let value = text;
        if (cell.type === "s") value = strings[Number(text)] ?? "";
        else if (cell.type === undefined || cell.type === "n")
          value = text === "" ? "" : String(Number(text));
        if (value !== "") row[cell.column] = value;
        cell = null;
      } else if (tag.name === "row" && row) {
        ready.push(row);
        row = null;
      }
    });
    const decoder = new TextDecoder("utf-8");
    for await (const chunk of (await zip.open(
      "xl/worksheets/sheet1.xml",
    )) as AsyncIterable<Buffer>) {
      parser.write(decoder.decode(chunk, { stream: true }));
      yield* ready.splice(0);
    }
    parser.close();
    yield* ready.splice(0);
  } finally {
    zip.close();
  }
}
