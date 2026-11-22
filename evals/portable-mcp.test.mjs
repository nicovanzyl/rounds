import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../bin/rounds.mjs", import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rounds-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, "sample-project");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "index.html"), "<title>Example</title><p>Page for review</p>");
  const env = { ...process.env, ROUNDS_HOME: home, CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "" };

  // Each request starts a fresh process, as when a client resumes a chat after a restart.
  function rpc(client, method, params, flags = []) {
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: client, version: "1" } } },
      { jsonrpc: "2.0", id: 2, method, params },
    ].map(x => JSON.stringify(x)).join("\n") + "\n";
    const result = spawnSync(process.execPath, [server, "mcp", ...flags], { env, cwd: home, input: lines, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const reply = result.stdout.trim().split("\n").map(line => JSON.parse(line)).find(x => x.id === 2);
    assert.ok(reply?.result, JSON.stringify(reply));
    return reply.result;
  }
  const call = (client, name, args, meta, flags) => rpc(client, "tools/call", { name, arguments: args, _meta: meta }, flags);
  const posts = () => fs.readdirSync(path.join(home, "posts")).map(f => JSON.parse(fs.readFileSync(path.join(home, "posts", f))));
  const pin = (post, id) => ({ id, page: `post-${post.page.key}`, hash: post.page.hash, x: 10, y: 10, thread: post.session, text: `Note ${id}`, at: 1 });
  return { home, cwd, env, rpc, call, posts, pin };
}

test("generic clients keep conversation ownership across restarts, even for identical artifacts", t => {
  const { home, cwd, env, rpc, call, posts, pin } = fixture(t);
  env.ROUNDS_PORT = "5001";
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projects: [{ key: "first", name: "Client work", match: ["first"] }] }));
  const client = "Example client";
  for (const tool of rpc(client, "tools/list", {}).tools) {
    assert.ok(tool.inputSchema.properties.session_id);
    assert.ok(tool.inputSchema.properties.cwd);
  }
  const post = { cwd, caption: "Preview", topic: "Example", page: "index.html" };
  assert.ok(call(client, "rounds_post", post).isError);
  for (const id of ["first", "second"]) {
    const result = call(client, "rounds_post", { ...post, session_title: id, session_id: id });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /localhost:5001/);
    if (id === "first") assert.match(result.content[0].text, /under Client work/);
  }
  const [first, second] = posts().sort((a,b) => a.sessionTitle.localeCompare(b.sessionTitle));
  assert.match(first.session, /^mcp-[0-9a-f]{16}$/);
  assert.notEqual(first.session, second.session);
  assert.equal(first.page.hash, second.page.hash);
  assert.equal(first.cwd, cwd);
  const collisionA = pin(first, "old-short-id"), collisionB = pin(second, "old-short-id");
  fs.writeFileSync(path.join(home, "comments.json"), JSON.stringify([
    pin(first, "note-1"), pin(second, "note-2"), collisionB, collisionA, { ...pin(first, "ambiguous"), thread: null },
  ]));
  assert.match(call("claude-code", "rounds_notes", { cwd }).content[0].text, /No notes/);
  assert.equal(call("claude-ai", "rounds_notes", { cwd }, {}, ["--client", "generic"]).isError, true);
  const mismatch = call(client, "rounds_post", { ...post, session_id: "first", before: ["missing.png"] });
  assert.match(mismatch.content[0].text, /one before image/);
  assert.equal(posts().length, 2);
  const mine = { session_id: "first", cwd };
  const notes = call(client, "rounds_notes", mine).content[0].text;
  assert.match(notes, /Note note-1/);
  assert.doesNotMatch(notes, /Note note-2|ambiguous/);
  assert.equal(call(client, "rounds_reply", { ...mine, id: "old-short-id", reply: "Only my pin" }).isError, undefined);
  const updated = JSON.parse(fs.readFileSync(path.join(home, "comments.json")));
  assert.equal(updated.find(c => c.id === "old-short-id" && c.thread === first.session).reply.text, "Only my pin");
  assert.equal(updated.find(c => c.id === "old-short-id" && c.thread === second.session).reply, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "sent", "note-1.json"))).session, first.session);
  assert.equal(call(client, "rounds_reply", { ...mine, id: "note-2", reply: "Wrong chat" }).isError, true);
  assert.equal(call(client, "rounds_reply", { ...mine, id: "note-1", reply: "Fixed" }).isError, undefined);
  assert.match(call(client, "rounds_notes", mine).content[0].text, /No notes/);
  assert.match(call(client, "rounds_notes", { ...mine, all: true }).content[0].text, /You replied: Fixed/);
});

test("Codex tool metadata, explicit IDs and legacy Claude calls retain their native owners", t => {
  const { cwd, call, posts, env } = fixture(t);
  const id = "01234567-1111-2222-3333-444444444444";
  for (const [index, meta] of [{ threadId: id }, { "x-codex-turn-metadata": JSON.stringify({ thread_id: id }) }, {}].entries()) {
    const args = { cwd, summary: `Change ${index}`, ...(index === 2 && { session_id: id }) };
    const result = call("Other handshake name", "rounds_change", args, meta, ["--client", "codex"]);
    assert.equal(result.isError, undefined, JSON.stringify(result));
  }
  env.CODEX_THREAD_ID = "00000000-0000-0000-0000-000000000001";
  assert.equal(call("codex", "rounds_change", { cwd, session_id: id, summary: "From a child chat" }).isError, undefined);
  assert.ok(posts().every(p => p.session === `codex-${id}` && p.client === "codex"));
  assert.equal(call("claude-code", "rounds_post", { cwd, page: "index.html", caption: "Old call", topic: "Legacy" }).isError, undefined);
  assert.equal(posts().find(p => p.caption === "Old call").session, undefined); // attributed by hook
  assert.equal(call("claude-code", "rounds_change", { cwd, session_id: id, summary: "Explicit UUID" }).isError, undefined);
  assert.equal(posts().find(p => p.caption === "Explicit UUID").session, id);
});

test("concurrent pin and reply writers preserve every change", async t => {
  const { home, env } = fixture(t);
  fs.mkdirSync(path.join(home, "comment-writers"));
  fs.writeFileSync(path.join(home, "comment-writers", ".DS_Store"), "");
  const store = new URL("../server/comments-store.mjs", import.meta.url).href;
  const write = `import { updateComments } from ${JSON.stringify(store)}; for(let i=0;i<6;i++) await updateComments(list => list.push({id:process.pid+'-'+i}));`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", write], { env, stdio: "pipe" });
    let error = "";
    child.stderr.on("data", chunk => error += chunk);
    child.on("error", reject);
    child.on("exit", code => code === 0 ? done() : reject(Error(error)));
  })));
  const list = JSON.parse(fs.readFileSync(path.join(home, "comments.json")));
  assert.equal(new Set(list.map(x => x.id)).size, 24);
});

test("modern clients discover tools and make stateless calls without a handshake", t => {
  const { home, cwd, env, posts } = fixture(t);
  const version = "io.modelcontextprotocol/protocolVersion";
  const meta = { [version]: "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "stateless", version: "1" } };
  const requests = [
    ["server/discover", { _meta: meta }],
    ["tools/list", { _meta: meta }],
    ["tools/call", { _meta: meta, name: "rounds_change", arguments: { session_id: "chat", summary: "Update", cwd } }],
    ["tools/list", { _meta: { ...meta, [version]: "future" } }],
    ["tools/call", { _meta: { ...meta, "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "1" } }, name: "rounds_notes", arguments: { cwd } }],
  ].map(([method, params], id) => JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const proc = spawnSync(process.execPath, [server, "mcp"], { env, cwd: home, input: requests.join("\n") + "\n", encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  const replies = proc.stdout.trim().split("\n").map(line => JSON.parse(line)).sort((a,b) => a.id-b.id);
  assert.equal(replies[0].result.resultType, "complete");
  assert.ok(replies[0].result.supportedVersions.includes("2026-07-28"));
  assert.equal(replies[1].result.tools.length, 4);
  assert.equal(replies[2].result.isError, undefined);
  assert.equal(posts()[0].client, "mcp");
  assert.equal(replies[3].error.code, -32022);
  assert.ok(replies[4].result.isError, "stateless calls require a conversation ID");
});
