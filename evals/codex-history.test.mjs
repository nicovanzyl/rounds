import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("indexes local Codex work alongside Claude and portable posts, including archived rollouts", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rounds-history-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("..", import.meta.url));
  const data = path.join(temp, "rounds");
  const codex = path.join(temp, "codex");
  const claude = path.join(temp, "claude");
  const env = { ROUNDS_HOME: data, ROUNDS_CODEX_HOME: codex, ROUNDS_CLAUDE_HOME: claude, ROUNDS_DESKTOP_SESSIONS: path.join(temp, "desktop") };
  const previousEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(previousEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const { buildIndex } = await import("../server/indexer.mjs");
  const original = await buildIndex();
  assert.deepEqual(original.threads, []); // both optional client homes are missing
  const uuid = "11111111-2222-3333-4444-555555555555", id = `codex-${uuid}`;
  const at = "2026-01-12T12:00:00.000Z";
  const entry = (type, payload) => JSON.stringify({ timestamp: at, type, payload });
  const meta = (id) => entry("session_meta", { id, cwd: root });
  const done = (item, thread_id = uuid) => entry("event_msg", { type: "item_completed", thread_id, item });
  const change = (id, status, changes) => done({ type: "FileChange", id, status, changes });
  const mcpPostId = "1234567890abcdef", privatePostId = "eeeeeeeeeeeeeeee";
  const source = path.join(codex, "sessions", "2026", "01", "12");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(codex, "archived_sessions"));
  await fs.mkdir(path.join(data, "posts"), { recursive: true });
  await fs.writeFile(path.join(codex, "session_index.jsonl"), JSON.stringify({ id: uuid, thread_name: "User's thread name" }));
  const transcript = path.join(source, `rollout-2026-01-12T12-00-00-${uuid}.jsonl`);
  await fs.writeFile(transcript, [
    meta(uuid),
    entry("turn_context", { turn_id: "turn-1", cwd: root }),
    entry("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Build the page" }] }),
    done({ type: "UserMessage", content: [{ type: "text", text: "Build the page" }] }),
    change("add", "completed", { "README.md": { type: "add", content: "first line\nsecond line\n" } }),
    change("update", "completed", { "README.md": { type: "update", unified_diff: "@@ -2 +2 @@\n-second line\n+new line\n" } }),
    entry("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "legacy", input: "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch" }),
    entry("response_item", { type: "custom_tool_call_output", call_id: "legacy", output: JSON.stringify({ output: "Success. Updated the following files:\nM README.md", metadata: { exit_code: 0 } }) }),
    entry("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "failed-legacy", input: "*** Begin Patch\n*** Add File: LICENSE\n+ignored\n*** End Patch" }),
    entry("response_item", { type: "custom_tool_call_output", call_id: "failed-legacy", output: "Failed to apply patch" }),
    change("failed", "failed", { "src/Ground.tsx": { type: "delete", content: "do not record" } }),
    done({ type: "FileChange", id: "copied", status: "completed", changes: { "LICENSE": { type: "add", content: "from a different thread" } } }, "other"),
    entry("response_item", { type: "function_call", name: "mcp__rounds__rounds_change", call_id: "post" }),
    entry("response_item", { type: "function_call_output", call_id: "post", output: `Recorded the change to Rounds as post ${mcpPostId}` }),
    "{unfinished",
  ].join("\n"));
  const writePost = (p) => fs.writeFile(path.join(data, "posts", p.id + ".json"), JSON.stringify({ at: Date.parse(at), cwd: root, topic: "Design", kind: "change", shots: [], caption: "A change", ...p }));
  await writePost({ id: mcpPostId });
  const privateId = "22222222-2222-3333-4444-555555555555";
  const archived = path.join(codex, "archived_sessions", `rollout-${privateId}.jsonl`);
  await fs.writeFile(archived, [
    meta(privateId),
    entry("event_msg", { type: "user_message", message: "Project concealed" }),
    entry("event_msg", { type: "patch_apply_end", call_id: "old-edit", success: true, changes: { "README.md": { type: "delete", content: "prior content\n" } } }),
    done({ type: "McpToolCall", status: "completed", tool: "rounds_change", result: { content: [{ type: "text", text: "as post " + privatePostId }] } }, privateId),
  ].join("\n"));
  await writePost({ id: privatePostId });
  await writePost({ id: "portable", session: "mcp-portable", sessionTitle: "Other client", client: "mcp" });
  await writePost({ id: "claude", session: uuid, sessionTitle: "Claude session" });
  const postPage = async (id, text, at, session, sessionTitle) => {
    const hash = createHash("sha1").update(text).digest("hex").slice(0, 16);
    await fs.writeFile(path.join(data, "store", hash + ".html"), text);
    await writePost({ id, kind: "page", session, sessionTitle, at, page: { title: "Page", key: "shared", path: "", hash } });
  };
  await postPage("page-a", "<p>First</p>", 1, id, "Codex session");
  await postPage("page-b", "<p>Second</p>", 2, "mcp-portable", "Other client");
  await postPage("page-c", "<p>Second</p>", 3, uuid, "Claude session");
  await writePost({ id: "private-topic", topic: "concealed", shots: [{ hash: "abc", ext: "png" }] });
  await writePost({ id: "replacement", replaces: "private-topic" });

  const index = await buildIndex();
  const thread = index.threads.find((t) => t.id === id);
  assert.equal(thread.client, "codex");
  assert.equal(thread.title, "User's thread name");
  assert.deepEqual(Object.values(thread.days), [1]);
  assert.equal(index.sets.find((s) => s.id === mcpPostId).thread, id);
  assert.equal(index.threads.find((t) => t.id === `codex-${privateId}`).archived, true);
  assert.equal(index.sets.find((s) => s.id === privatePostId).thread, `codex-${privateId}`);
  assert.equal(index.threads.find((t) => t.id === "mcp-portable").client, "mcp");
  assert.equal(index.sets.find((s) => s.id === "claude").thread, uuid);
  assert.equal(index.pages[0].dir, "");
  assert.deepEqual(index.pages[0].versions.map((v) => [v.at, v.thread]), [[1, id], [3, uuid]]);
  if (!/^\/(private\/)?(tmp|var\/folders)\//.test(root)) {
    // The normal index excludes scratch repositories; use an existing project file under a checkout.
    const changes = index.changed.filter((c) => c.thread === id);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].file, "README.md");
    assert.deepEqual(changes[0].edits.map((e) => e.slice(1)), [[2, 0], [1, 1], [1, 1]]);
    const edits = JSON.parse(await fs.readFile(path.join(data, "store", "edits", id + ".json")));
    assert.deepEqual(Object.values(edits)[0][1].hunks, [{ o: 2, n: 2, lines: ["-second line", "+new line"] }]);
  }

  await fs.writeFile(path.join(data, "config.json"), JSON.stringify({ private: ["concealed"] }));
  await fs.appendFile(transcript, "\n" + done({ type: "UserMessage", content: [{ type: "text", text: "A new turn" }] }));
  const updated = await buildIndex();
  assert.deepEqual(Object.values(updated.threads.find((t) => t.id === id).days), [2]);
  assert.ok(!updated.threads.some((t) => t.id === `codex-${privateId}`));
  assert.ok(!updated.sets.some((s) => s.id === privatePostId));
  assert.ok(!updated.sets.some((s) => s.id === "private-topic"));
  assert.equal(updated.sets.find((s) => s.id === "replacement").before, undefined);
  assert.ok(JSON.parse(await fs.readFile(path.join(data, "private-history.json"))).sessions.includes(`codex-${privateId}`));
  await fs.unlink(transcript);
  await fs.unlink(archived);
  const retained = await buildIndex();
  assert.ok(!retained.sets.some((s) => s.id === privatePostId));
  assert.ok(JSON.parse(await fs.readFile(path.join(data, "private-history.json"))).sessions.includes(`codex-${privateId}`));
  assert.equal(retained.sets.find((s) => s.id === mcpPostId).thread, id);
  assert.equal(retained.threads.find((t) => t.id === id).gone, true);
  assert.equal(retained.threads.find((t) => t.id === id).title, "User's thread name");
});
