import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

test("the live canvas routes pins to the selected revision and set", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rounds-canvas-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.ROUNDS_HOME = dir;
  process.env.ROUNDS_BROWSER = "none";
  process.env.ROUNDS_CODEX_HOME = path.join(dir, "codex");
  process.env.ROUNDS_CLAUDE_HOME = path.join(dir, "claude");
  process.env.ROUNDS_DESKTOP_SESSIONS = path.join(dir, "desktop");
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  write("config.json", { updates: false });
  const { handle } = await import("../server/api.mjs");
  async function api(url, input, status = 200) {
    const req = Object.assign(Readable.from(input ? [JSON.stringify(input)] : []), {
      url, method: input ? "POST" : "GET", headers: { host: "localhost" },
    });
    const res = { setHeader() {}, end(body) { this.body = body; } };
    await handle(req, res, assert.fail);
    assert.equal(res.statusCode, status, res.body);
    return JSON.parse(res.body);
  }

  fs.mkdirSync(path.join(dir, "posts"));
  const now = Date.now();
  const cwd = path.join(dir, "constructor");
  const shot = { hash: "abcdef", w: 10, h: 10 };
  const page = { hash: "ab1234", key: "shared", title: "Example" };
  const first = { id: "first", session: "mcp-first", cwd, topic: "Home", sessionTitle: "First", shots: [shot], at: now - 2, page };
  const second = { ...first, id: "second", session: "mcp-second", sessionTitle: "Second", at: now };
  const pageId = "post-shared";
  // The first post has already been indexed, but its tool hook only just attributed it.
  write("index.json", {
    builtAt: now - 1, projects: { constructor: "constructor" }, changed: [],
    threads: [], sets: [{ ...first, thread: null, project: "constructor" }],
    pages: [{ id: pageId, thread: null, at: first.at, versions: [{ at: first.at, hash: page.hash, thread: null }] }],
  });
  write("posts/first.json", first);
  write("posts/second.json", second);
  const index = await api("/api/index");
  assert.equal(index.topics.constructor[0].title, "Home");
  assert.deepEqual(index.pages[0].versions.map(v => v.thread), [first.session, second.session]);
  const pin = { page: pageId, hash: page.hash, x: 1, y: 1, text: "Heading" };
  await api("/api/comments", pin, 400);
  for (const owner of [first.session, second.session]) {
    assert.equal((await api("/api/comments", { ...pin, versionThread: owner })).thread, owner);
  }
  const screenPin = { ...pin, page: "shot-" + shot.hash, hash: shot.hash };
  await api("/api/comments", { ...screenPin, set: "unavailable" }, 400);
  assert.equal((await api("/api/comments", { ...screenPin, set: first.id })).thread, first.session);
  assert.equal((await api("/api/comments")).length, 3);

  // A removed artifact can have old notes and file details even after leaving the index.
  const comments = JSON.parse(fs.readFileSync(path.join(dir, "comments.json")));
  write("comments.json", [...comments, { ...screenPin, id: "old", page: "shot-removed", hash: "removed" }]);
  assert.equal((await api("/api/comments")).length, 3);
  fs.mkdirSync(path.join(dir, "store/edits"), { recursive: true });
  write("store/edits/mcp-first.json", { "sample\npage.ts": [{ at: now }] });
  assert.deepEqual(await api("/api/edits/mcp-first?repo=sample&file=page.ts"), []);

  // A cached, anonymous post must disappear when its late attribution makes it private.
  write("config.json", { updates: false, private: ["First"] });
  const filtered = await api("/api/index");
  assert.ok(!filtered.sets.some(s => s.id === first.id));
  assert.ok(!filtered.comments.some(c => c.thread === first.session));
});
