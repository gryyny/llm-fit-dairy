import { SaxesParser } from "saxes";

/**
 * Streams flat XML records such as Ciqual's `<ALIM><alim_code> 1000 </alim_code>…</ALIM>`.
 * Each record maps child element names to trimmed text; elements marked `missing` or empty are
 * omitted, so a missing value never becomes an empty string or zero.
 */
export async function* xmlRecords(
  chunks: AsyncIterable<Buffer | string>,
  recordTag: string,
): AsyncGenerator<Record<string, string>> {
  const parser = new SaxesParser();
  const ready: Record<string, string>[] = [];
  let record: Record<string, string> | null = null;
  let field: string | null = null;
  let text = "";
  parser.on("opentag", (tag) => {
    if (tag.name === recordTag) record = {};
    else if (record) {
      field = tag.name;
      text = "";
    }
  });
  parser.on("text", (t) => {
    if (field) text += t;
  });
  parser.on("closetag", (tag) => {
    if (tag.name === recordTag && record) {
      ready.push(record);
      record = null;
    } else if (record && tag.name === field) {
      const value = text.trim();
      if (value !== "") record[field] = value;
      field = null;
    }
  });
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of chunks) {
    parser.write(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    yield* ready.splice(0);
  }
  parser.close();
  yield* ready.splice(0);
}
