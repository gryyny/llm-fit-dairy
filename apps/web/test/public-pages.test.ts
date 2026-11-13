import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("public submission pages", () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "diary-public-pages-"));
    await build({
      root: fileURLToPath(new URL("../", import.meta.url)),
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      build: { outDir, emptyOutDir: true },
      logLevel: "silent",
    });
  });
  afterAll(async () => rm(outDir, { recursive: true, force: true }));

  it("delivers full policy and support text without executing scripts or contacting Firebase", async () => {
    for (const [path, heading] of [
      ["privacy", "Privacy policy"],
      ["terms", "Terms"],
      ["support", "Support"],
    ]) {
      const html = await readFile(join(outDir, `${path}.html`), "utf8");
      expect(html).toContain(`>${heading}</h1>`);
      expect(html).toContain("<h2>");
      if (path === "terms") {
        expect(html).toContain('href="/support"');
      } else {
        expect(html).toContain('href="mailto:gryyny@proton.me"');
      }
      expect(html).not.toContain("Andrii Hrynchuk");
      expect(html).not.toContain("Draft");
      expect(html).not.toContain("not yet in effect");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("language-picker");
      expect(html).not.toContain("policy-languages");
      const css = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/.exec(html)?.[1];
      expect(css).toMatch(/^\/assets\/.+\.css$/);
      expect(await readFile(join(outDir, css ?? ""), "utf8")).toContain(".prose");
    }
  });

  it("serves the product description in initial HTML while keeping the diary app interactive", async () => {
    const html = await readFile(join(outDir, "index.html"), "utf8");
    expect(html).toContain("Your food diary");
    expect(html).toContain("Log meals in ChatGPT. View your diary here.");
    expect(html).not.toContain("Free for adults");
    expect(html).not.toContain("not yet published");
    expect(html).not.toContain("Andrii Hrynchuk");
    expect(html).toContain('<script type="module"');
    for (const path of ["/privacy", "/terms", "/support"]) {
      expect(html).toContain(`href="${path}"`);
    }
  });

  it("serves equivalent Ukrainian public pages without JavaScript or repeated language controls", async () => {
    for (const [page, title] of [
      ["privacy", "Політика конфіденційності"],
      ["terms", "Умови"],
      ["support", "Підтримка"],
    ]) {
      const html = await readFile(join(outDir, `uk/${page}.html`), "utf8");
      expect(html).toContain('<html lang="uk">');
      expect(html).toContain(`<title>${title} · Food diary</title>`);
      expect(html).toContain(`>${title}</h1>`);
      expect(html).not.toContain(`href="/${page}"`);
      expect(html).toContain(`href="/uk/${page}"`);
      expect(html).toContain('href="/?lang=uk"');
      expect(html).not.toContain("<script");
      expect(html).not.toContain("language-picker");
      expect(html).not.toContain("policy-languages");
      expect(html).not.toContain("Andrii Hrynchuk");
      expect(html).not.toContain("Draft");
      if (page === "privacy") {
        expect(html).toContain("Версія 4");
        expect(html).toContain("зріст");
        expect(html).toContain("180");
        expect(html).toContain("CNPD");
        expect(html).toContain("Резервних копій щоденника немає");
      }
    }
  });
});
