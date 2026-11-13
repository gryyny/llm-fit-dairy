import type { Readable } from "node:stream";
import yauzl from "yauzl";

export interface ZipArchive {
  names: string[];
  open(name: string): Promise<Readable>;
  close(): void;
}

function readEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>();
    zip.on("entry", (entry: yauzl.Entry) => {
      entries.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.on("end", () => {
      resolve(entries);
    });
    zip.on("error", reject);
    zip.readEntry();
  });
}

async function wrap(zip: yauzl.ZipFile): Promise<ZipArchive> {
  const entries = await readEntries(zip);
  return {
    names: [...entries.keys()],
    open: (name) =>
      new Promise((resolve, reject) => {
        const entry = entries.get(name);
        if (!entry) {
          reject(new Error(`Archive has no entry ${name}`));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) reject(error);
          else resolve(stream);
        });
      }),
    close: () => {
      zip.close();
    },
  };
}

/** Random-access ZIP reader (central directory, ZIP64), streaming each entry's contents. */
export function openZip(path: string): Promise<ZipArchive> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error) reject(error);
      else wrap(zip).then(resolve, reject);
    });
  });
}

export function openZipBuffer(buffer: Buffer): Promise<ZipArchive> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) reject(error);
      else wrap(zip).then(resolve, reject);
    });
  });
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}
