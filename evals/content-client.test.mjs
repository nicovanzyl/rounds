// The same newline-delimited MCP exchange used by a private stdio tunnel.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/rounds.mjs", import.meta.url));
test("a content-only chat posts, versions, reads its pins and replies after reconnecting", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rounds-content-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  Object.assign(process.env, {
    ROUNDS_HOME: dir, ROUNDS_CODEX_HOME: path.join(dir, "codex"), ROUNDS_CLAUDE_HOME: path.join(dir, "claude"),
    ROUNDS_DESKTOP_SESSIONS: path.join(dir, "desktop"), ROUNDS_BROWSER: "none",
  });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ updates: false }));
  const { handle } = await import("../server/api.mjs");
  async function api(url, data) {
    const req = Object.assign(Readable.from(data ? [JSON.stringify(data)] : []), { url, headers: { host: "localhost" }, method: data ? "POST" : "GET" });
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
    await handle(req, res, assert.fail);
    assert.ok(!res.statusCode || res.statusCode === 200, res.body);
    return res;
  }
  function rpc(method, params = {}) {
    const messages = [{ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test-tunnel", version: "1" }, capabilities: {} } }, { id: 2, method, params }];
    const input = messages.map(m => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n";
    const child = spawnSync(process.execPath, [cli, "mcp", "--content-only"], { input, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const reply = child.stdout.trim().split("\n").map(l => JSON.parse(l)).find(m => m.id === 2);
    assert.ok(reply?.result, JSON.stringify(reply));
    return reply.result;
  }
  const call = (name, args) => rpc("tools/call", { name, arguments: args });
  const output = r => r.content.map(c => c.text).join("\n");
  const privateKey = r => output(r).match(/session_key.*?([a-f0-9]{64})/)?.[1];
  const post = (html, extra) => call("rounds_post", { topic: "Landing page", caption: "New landing page", project: "Example", page_html: html, page_name: "Home", ...extra });

  const { tools } = rpc("tools/list");
  assert.equal(tools.length, 4);
  assert.ok(tools[0].inputSchema.properties.page_html);
  assert.ok(!tools[0].inputSchema.properties.page);

  // Identical content in separate chats still creates separate pages and note ownership.
  const html = "<!doctype html><title>Home</title><h1>Hello</h1>";
  // Failure to create a retrievable chat identity leaves the canvas untouched.
  const identities = path.join(dir, "content-sessions");
  fs.writeFileSync(identities, "occupied");
  assert.ok(post(html, { session_title: "Registration failed" }).isError);
  fs.unlinkSync(identities);
  assert.equal(fs.existsSync(path.join(dir, "posts")) && fs.readdirSync(path.join(dir, "posts")).length > 0, false);
  const first = post(html, { session_title: "First chat" });
  const key = privateKey(first);
  assert.ok(key, output(first));
  // Once the post is durable, failure of the canvas wake-up stamp must not lose its key.
  const stamp = path.join(dir, "posted");
  fs.unlinkSync(stamp);
  fs.mkdirSync(stamp);
  const other = privateKey(post(html, { session_title: "Another chat" }));
  fs.rmdirSync(stamp);
  assert.ok(other && key !== other);
  let index = JSON.parse((await api("/api/index")).body);
  assert.equal(index.pages.length, 2);
  const owner = index.threads.find(row => row.title === "First chat");
  const page = index.pages.find(row => row.thread === owner.id);
  assert.equal(owner.project, "example");
  assert.ok(!page.dir);
  const hash = page.versions[0].hash;
  const snapshot = await api("/api/page/" + hash);
  assert.match(snapshot.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.match(snapshot.body, /<h1>Hello<\/h1>/);

  const note = JSON.parse((await api("/api/comments", { page: page.id, hash, x: 10, y: 10, text: "Please revise the heading" })).body);
  assert.match(output(call("rounds_notes", { session_key: key })), /Please revise the heading/);
  assert.doesNotMatch(output(call("rounds_notes", { session_key: key })), new RegExp(dir));
  assert.equal(output(call("rounds_notes", { session_key: other })), "No notes waiting.");
  assert.ok(call("rounds_reply", { session_key: other, id: note.id, reply: "No" }).isError);
  assert.ok(!call("rounds_reply", { session_key: key, id: note.id, reply: "Updated the heading." }).isError);
  assert.match(output(call("rounds_notes", { session_key: key, all: true })), /Updated the heading/);

  assert.ok(!post("<h1>Updated</h1>", { session_key: key }).isError);
  assert.ok(!call("rounds_change", { session_key: key, project: "Example", summary: "Updated heading" }).isError);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTc8AAAAASUVORK5CYII=";
  assert.ok(!call("rounds_post", { session_key: key, caption: "Heading", topic: "Landing page", images: [png], before: [png] }).isError);
  index = JSON.parse((await api("/api/index")).body);
  assert.equal(index.pages.find(p => p.id === page.id).versions.length, 2);
  assert.ok(index.sets.some(s => s.kind === "change" && s.thread === owner.id));
  const screen = index.sets.find(s => s.shots.length && s.before.length && s.thread === owner.id);
  assert.equal(screen.project, "example");
  const pin = JSON.parse((await api("/api/comments", { page: "shot-" + screen.shots[0].hash, hash: screen.shots[0].hash, set: screen.id, x: 0.5, y: 0.5, text: "Check this image" })).body);
  assert.equal(pin.set, screen.id);
  assert.equal(pin.thread, owner.id);
  assert.match(output(call("rounds_notes", { session_key: key })), /image 1 of 1/);
  assert.ok(call("rounds_post", { topic: "x", caption: "x", page: "/tmp/page.html" }).isError);
  assert.ok(call("rounds_change", { summary: "x", cwd: dir }).isError);
  assert.ok(call("rounds_notes", {}).isError);

  // A new post matching a private conversation must stay hidden between full indexes.
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ private: ["First chat"], updates: false }));
  const rebuilt = JSON.parse((await api("/api/index?fresh")).body);
  assert.ok(!rebuilt.threads.some(t => t.id === owner.id));
  assert.ok(!rebuilt.sets.some(s => s.thread === owner.id));
  assert.ok(!rebuilt.pages.some(p => p.id === page.id));
  assert.ok(!rebuilt.comments.some(c => c.thread === owner.id));
  assert.equal(output(call("rounds_notes", { session_key: key, all: true })), "No notes waiting.");
  assert.ok(call("rounds_reply", { session_key: key, id: pin.id, reply: "Hidden" }).isError);
  assert.ok(!post("<h1>Private revision</h1>", { session_key: key }).isError);
  assert.ok(!JSON.parse((await api("/api/index")).body).pages.some(p => p.id === page.id));
});
