import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/tools.js";

/**
 * MC-4 local readiness of the submission package against the documented submission limits. Portal
 * validation, skill scans and review are separate, pending live steps.
 */
const root = fileURLToPath(new URL("../../../chatgpt/plugin/", import.meta.url));
const HOST = "https://gryyny.duckdns.org";

const json = async (path: string) =>
  JSON.parse(await readFile(`${root}${path}`, "utf8")) as unknown;

async function files(dir = ""): Promise<string[]> {
  const entries = await readdir(`${root}${dir}`, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory() ? files(`${dir}${e.name}/`) : Promise.resolve([`${dir}${e.name}`]),
    ),
  );
  return nested.flat().sort();
}

interface Listing {
  displayName: string;
  shortDescription: string;
  longDescription: string;
  developerName: string;
  capabilities: string[];
  defaultPrompt: string[];
  brandColor: string;
  brandColorDark: string;
  logo: string;
  composerIcon: string;
  websiteURL: string;
  supportURL: string;
  privacyPolicyURL: string;
  termsOfServiceURL: string;
}
interface Manifest {
  name: string;
  version: string;
  extensions: {
    "com.openai": {
      interface: Listing;
      review: {
        test_cases: {
          positive: { prompt: string; tools_triggered: string; expected_behavior: string }[];
          negative: { prompt: string }[];
        };
      };
    };
  };
}

describe("submission package (MC-4)", () => {
  it("contains only the manifest, MCP configuration, skill and icon", async () => {
    expect(await files()).toEqual([
      "assets/logo.svg",
      "mcp.json",
      "plugin.json",
      "skills/food-diary/SKILL.md",
    ]);
  });

  it("keeps listing fields within the submission limits", async () => {
    const manifest = (await json("plugin.json")) as Manifest;
    expect(manifest.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    const listing = manifest.extensions["com.openai"].interface;
    expect(listing.displayName.length).toBeLessThanOrEqual(30);
    expect(listing.shortDescription.length).toBeLessThanOrEqual(30);
    expect(listing.longDescription.length).toBeLessThanOrEqual(4000);
    expect(listing.developerName.length).toBeLessThanOrEqual(80);
    expect(listing.capabilities.length).toBeLessThanOrEqual(20);
    for (const c of listing.capabilities) expect(c.length).toBeLessThanOrEqual(120);
    expect(listing.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const p of listing.defaultPrompt) expect(p.length).toBeLessThanOrEqual(128);
    expect(listing.brandColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(listing.brandColorDark).toMatch(/^#[0-9A-F]{6}$/i);
    for (const url of [
      listing.websiteURL,
      listing.supportURL,
      listing.privacyPolicyURL,
      listing.termsOfServiceURL,
    ]) {
      expect(url.startsWith(`${HOST}/`)).toBe(true);
    }
    for (const icon of [listing.logo, listing.composerIcon]) {
      const svg = await readFile(`${root}${icon.replace(/^\.\//, "")}`, "utf8");
      const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg) ?? [];
      expect(Number(w)).toBe(Number(h));
      expect(Number(w)).toBeGreaterThanOrEqual(48);
    }
  });

  it("declares the remote server with the provided OAuth client and no secrets", async () => {
    const mcp = (await json("mcp.json")) as {
      mcpServers: Record<
        string,
        { type: string; url: string; headers?: unknown; extensions: unknown }
      >;
    };
    const servers = Object.values(mcp.mcpServers);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      type: "streamable-http",
      url: `${HOST}/mcp`,
      extensions: {
        "com.openai": {
          auth: { type: "oauth", client: { mode: "provided", clientId: "chatgpt" } },
        },
      },
    });
    expect(servers[0]?.headers).toBeUndefined();
    for (const path of await files()) {
      const text = await readFile(`${root}${path}`, "utf8");
      expect(text).not.toMatch(
        /clientSecret|fd[acr]_[A-Za-z0-9_-]{20,}|test_credentials|reviewer_instructions/,
      );
    }
  });

  it("keeps review cases and every instruction tool reference aligned with the real server", async () => {
    const { positive, negative } = ((await json("plugin.json")) as Manifest).extensions[
      "com.openai"
    ].review.test_cases;
    expect(positive).toHaveLength(5);
    expect(negative).toHaveLength(3);
    const [client, server] = InMemoryTransport.createLinkedPair();
    const mcp = createServer({ request: () => Promise.reject(new Error("unused")) }, "unused");
    await mcp.connect(server);
    const listed = new Client({ name: "package-test", version: "1" });
    await listed.connect(client);
    const tools = new Set((await listed.listTools()).tools.map((t) => t.name));
    await listed.close();
    const skill = await readFile(`${root}skills/food-diary/SKILL.md`, "utf8");
    const references = [
      ...skill.matchAll(
        /`((?:list|read|update|save|search)_[a-z_]+|add_profile|delete_record|select_day_target|set_food_link|link_food)`/g,
      ),
    ].map((match) => match[1]);
    for (const name of references) expect(tools.has(name ?? ""), `skill tool ${name}`).toBe(true);
    for (const name of tools)
      expect(references.includes(name), `undocumented tool ${name}`).toBe(true);
    for (const c of positive) {
      expect(c.expected_behavior.length).toBeGreaterThan(0);
      for (const name of c.tools_triggered.split(",").map((s) => s.trim())) {
        expect(tools.has(name), name).toBe(true);
      }
    }
  });

  it("gives the skill a name matching its folder and a description", async () => {
    const skill = await readFile(`${root}skills/food-diary/SKILL.md`, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    expect(frontmatter).toMatch(/^name: food-diary$/m);
    const encoded = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
    const description: unknown = JSON.parse(encoded);
    expect(typeof description).toBe("string");
    expect(typeof description === "string" && description.length >= 20).toBe(true);
  });
});
