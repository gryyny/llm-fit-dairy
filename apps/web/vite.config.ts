import react from "@vitejs/plugin-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "public-pages",
      enforce: "post",
      async generateBundle(_, bundle) {
        const { Landing, Privacy, Support, Terms } = await import("./src/Pages.js");
        const { LocaleProvider } = await import("./src/i18n.js");
        const entry = bundle["index.html"];
        if (entry?.type !== "asset") throw new Error("Missing built index.html");
        const html =
          typeof entry.source === "string" ? entry.source : new TextDecoder().decode(entry.source);
        // Reuse the same copy and CSS, but do not require sign-in or JavaScript to read policies.
        for (const locale of ["en", "uk"] as const)
          for (const [path, title, component] of [
            ["privacy", locale === "uk" ? "Політика конфіденційності" : "Privacy policy", Privacy],
            ["terms", locale === "uk" ? "Умови" : "Terms", Terms],
            ["support", locale === "uk" ? "Підтримка" : "Support", Support],
          ] as const) {
            this.emitFile({
              type: "asset",
              fileName: `${locale === "uk" ? "uk/" : ""}${path}.html`,
              source: html
                .replace('<html lang="en">', `<html lang="${locale}">`)
                .replace(
                  'content="Your food diary, kept by ChatGPT."',
                  locale === "uk"
                    ? 'content="Ваш щоденник харчування з ChatGPT."'
                    : 'content="Your food diary, kept by ChatGPT."',
                )
                .replace(
                  '<div id="root"></div>',
                  `<div id="root">${renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale, children: createElement(component) }))}</div>`,
                )
                .replace("<title>Food diary</title>", `<title>${title} · Food diary</title>`)
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
                .replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, ""),
            });
          }
        entry.source = html.replace(
          '<div id="root"></div>',
          `<div id="root">${renderToStaticMarkup(createElement(Landing))}</div>`,
        );
      },
    },
  ],
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
