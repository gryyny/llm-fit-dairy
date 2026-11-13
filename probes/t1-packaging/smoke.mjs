import assert from "node:assert/strict";

const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:8787/mcp");
assert.equal(endpoint.protocol, "http:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname), "Local synthetic identity must never be sent to a hosted endpoint");

let nextId = 0;
async function rpc(method, params = {}, { identity = true, origin, modern = false } = {}) {
  const id = ++nextId;
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": modern ? "2026-07-28" : "2025-11-25",
      ...(modern ? { "Mcp-Method": method, ...(method === "tools/call" ? { "Mcp-Name": params.name } : {}) } : {}),
      ...(identity ? { "oai-authenticated-user-id": "synthetic-local-test" } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {
      ...params,
      ...(modern ? { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "diary-local-probe", version: "0.1.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } : {}),
    } }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const body = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(message => message.id === id)
    : JSON.parse(text);
  return { status: response.status, body };
}

const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "diary-local-probe", version: "0.1.0" }, capabilities: {} });
assert.equal(initialized.status, 200);
assert.equal(initialized.body.result.serverInfo.name, "diary-t1-packaging");
console.log("PASS legacy initialization");

for (const modern of [false, true]) {
  const listed = await rpc("tools/list", {}, { modern, identity: false });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.result.tools.map(tool => tool.name).sort(), ["diary_probe_read", "diary_probe_write"]);
  assert.equal(listed.body.result.tools.find(tool => tool.name === "diary_probe_read").annotations.readOnlyHint, true);
  assert.equal(listed.body.result.tools.find(tool => tool.name === "diary_probe_write").annotations.readOnlyHint, false);
  console.log(`PASS ${modern ? "modern" : "legacy"} discovery and annotations`);
}

const readA = { name: "diary_probe_read", arguments: { account_id: "A" } };
assert.equal((await rpc("tools/call", readA, { identity: false })).status, 401);
assert.equal((await rpc("tools/call", readA, { origin: "https://unrelated.invalid" })).status, 403);
console.log("PASS missing identity and foreign origin rejection");

for (const args of [{ account_id: "C", energy_kcal: 111 }, { account_id: "A", energy_kcal: 333 }]) {
  const invalid = await rpc("tools/call", { name: "diary_probe_write", arguments: args });
  assert.ok(invalid.body.error || invalid.body.result?.isError);
}
console.log("PASS invalid account and non-fixture value rejection");

for (const [account_id, energy_kcal, modern] of [["A", 111, false], ["B", 222, true]]) {
  const written = await rpc("tools/call", { name: "diary_probe_write", arguments: { account_id, energy_kcal } }, { modern });
  assert.equal(written.status, 200);
  assert.notEqual(written.body.result.isError, true);
  assert.deepEqual(written.body.result.structuredContent.entry, { account_id, energy_kcal });
}
for (const [account_id, energy_kcal] of [["A", 111], ["B", 222]]) {
  const read = await rpc("tools/call", { name: "diary_probe_read", arguments: { account_id } });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.result.structuredContent.entry, { account_id, energy_kcal });
}
console.log("PASS distinct A/B writes and subsequent reads across independent requests");
console.log("LOCAL ONLY: does not establish ChatGPT installation, skill loading, iPhone behavior or own-API authentication.");
