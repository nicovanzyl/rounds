// Local Codex CLI and desktop rollouts. Only completed work and user prompts contribute to the
// index. Tool arguments, assistant messages, and command output are not a record of file edits.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { HOME } from "./config.mjs";

const CODEX_HOME = path.resolve(process.env.ROUNDS_CODEX_HOME || process.env.CODEX_HOME || path.join(HOME, ".codex"));
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const isPost = (name) => /^(?:mcp__(?:rounds|workbench)__)?(?:rounds|workbench)_(?:post|change)$/.test(name || "");
const cache = new Map();
const maxCacheSize = 32 * 1024 * 1024; // parsed summaries; a larger history is still fully indexed

// A Codex-managed worktree is a real checkout. The client's own settings and session files
// can sit in a Git repo too, but they are not project changes.
export const isCodexData = (file) => file.startsWith(CODEX_HOME + path.sep) && !file.startsWith(path.join(CODEX_HOME, "worktrees") + path.sep);

async function* rows(file, skip) {
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (skip?.(line)) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; } // an open rollout can end mid-row
      if (row && typeof row === "object") yield row;
    }
  } finally { lines.close(); input.destroy(); }
}

function postFrom(result) {
  if (!result || result.isError || result.Err) return null;
  const body = typeof result === "string" ? result : JSON.stringify(result.Ok ?? result);
  return (body.match(/\bto (?:Rounds|Workbench) as post ([a-f0-9]{16})\b/i) || body.match(/\bpost ([a-f0-9]{16})\b/))?.[1];
}

function fileEdit(change) {
  if (!change || typeof change !== "object") return null;
  const hunks = [];
  if (["add", "delete"].includes(change.type) && typeof change.content === "string") {
    const lines = change.content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const added = change.type === "add";
    hunks.push({ o: added ? 0 : 1, n: added ? 1 : 0, lines: lines.map((l) => (added ? "+" : "-") + l) });
  } else if (change.type === "update" && typeof change.unified_diff === "string") {
    for (const line of change.unified_diff.split("\n")) {
      const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (header) hunks.push({ o: Number(header[1]), n: Number(header[2]), lines: [] });
      else if (hunks.length && /^[+ -]/.test(line)) hunks.at(-1).lines.push(line);
    }
  }
  let add = 0, del = 0, cut = 0, left = 600;
  for (const h of hunks) {
    for (const l of h.lines) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
    const kept = Math.min(left, h.lines.length);
    cut += h.lines.length - kept;
    left -= kept;
    h.lines.length = kept;
  }
  return add || del ? { add, del, hunks: hunks.filter((h) => h.lines.length), ...(cut ? { cut } : {}), ...(change.type === "add" ? { created: true } : {}) } : null;
}

// Older minimal rollouts sometimes kept only the apply_patch invocation and its result. A
// successful patch supplies the replacement lines, but no original line numbers or deleted
// file contents. Zero line numbers denote an unpositioned hunk, as in the Claude adapter.
function appliedPatch(input) {
  const result = Object.create(null);
  const blocks = input.replaceAll("\r\n", "\n").split(/^\*\*\* (Add|Update|Delete) File: (.+)$/m);
  for (let i = 1; i + 2 < blocks.length; i += 3) {
    const [action, filename, body] = blocks.slice(i, i + 3);
    const lines = body.split("\n").slice(1);
    if (action === "Add") {
      const added = lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
      result[filename] = { type: "add", content: added.join("\n") + "\n" };
    } else if (action === "Update") {
      const diff = ["@@ -0 +0 @@"];
      let move_path;
      for (const l of lines) {
        if (l.startsWith("*** Move to: ")) move_path = l.slice("*** Move to: ".length);
        else if (l.startsWith("@@")) diff.push("@@ -0 +0 @@");
        else if (/^[+ -]/.test(l)) diff.push(l);
      }
      result[filename] = { type: "update", move_path, unified_diff: diff.join("\n") };
    }
  }
  return result;
}

function patchSucceeded(output) {
  if (typeof output !== "string") return false;
  try {
    const result = JSON.parse(output);
    return result.metadata?.exit_code === 0 && /^Success\. Updated the following files:/m.test(result.output);
  } catch { return /^Success\. Updated the following files:/.test(output); }
}

async function readRollout(file) {
  let meta = null, cwd = "", inherited = false, turn = "";
  const posts = new Set(), posting = new Set(), edits = new Map(), prompts = new Map();
  const patches = new Map(), recorded = new Set();
  function prompt(message, at, rank) {
    if (typeof message !== "string" || !message.trim() || !at) return;
    const batch = prompts.get(turn);
    if (batch && batch.rank > rank) return;
    const entries = batch?.rank === rank ? batch.entries : [];
    entries.push({ title: message.trim().replace(/\s+/g, " ").slice(0, 64), at });
    prompts.set(turn, { rank, entries });
  }
  function changes(id, records, at, base = cwd) {
    if (!id || !records || !at) return;
    for (const [key, change] of Object.entries(records)) {
      const filePath = typeof change?.move_path === "string" ? change.move_path : key;
      if (!path.isAbsolute(filePath) && !path.isAbsolute(base)) continue;
      const absolute = path.resolve(base, filePath);
      const edit = fileEdit(change);
      if (edit) edits.set(`${id}/${absolute}`, { id: `codex/${id}/${absolute}`, path: absolute, at, ...edit });
    }
  }
  // Rollouts can be gigabytes, much of it command output, images and model context. Recognize
  // the compact envelope Codex writes before decoding its payload. Unknown layouts still parse.
  function skip(line) {
    const head = line.slice(0, 512);
    const envelope = head.match(/^\{"timestamp":"[^"]*","type":"([^"]+)","payload":\{/);
    if (!envelope) return false;
    const [, type] = envelope;
    if (type === "session_meta" || type === "turn_context") return false;
    if (type !== "event_msg" && type !== "response_item") return true;
    const payload = head.slice(envelope[0].length);
    const kind = payload.match(/^"type":"([^"]+)"/)?.[1];
    if (!kind) return false;
    if (type === "response_item") {
      if (kind === "function_call_output") return !posting.size;
      if (kind === "custom_tool_call_output") return !patches.size;
      if (kind === "custom_tool_call") {
        const name = payload.match(/"name":"([^"]+)"/)?.[1];
        return name && name !== "apply_patch";
      }
      if (kind === "message") return /"role":"(?:assistant|developer|system)"/.test(payload);
      return kind !== "function_call";
    }
    if (kind === "item_completed") {
      const item = payload.match(/"item":\{"type":"([^"]+)"/)?.[1];
      return item && !["UserMessage", "McpToolCall", "FileChange"].includes(item);
    }
    return !["user_message", "patch_apply_end", "mcp_tool_call_end", "task_complete"].includes(kind);
  }
  for await (const row of rows(file, skip)) {
    const b = row.payload;
    if (!b || typeof b !== "object") continue;
    if (row.type === "session_meta") {
      if (!meta) {
        if (!uuid.test(b.id || "")) return null; // the ID also becomes part of the edit store filename
        const parent = b.source?.subagent?.thread_spawn?.parent_thread_id;
        if (b.source?.subagent && !uuid.test(parent || "")) return null; // e.g. internal review helpers
        cwd = typeof b.cwd === "string" ? b.cwd : "";
        meta = { id: `codex-${b.id}`, parent: parent ? `codex-${parent}` : null, cwd, at: 0 };
      } else if (`codex-${b.id}` !== meta.id) inherited = true;
      continue;
    }
    if (!meta) continue;
    const at = Date.parse(row.timestamp) || 0;
    meta.at = Math.max(meta.at, at);
    if (row.type === "turn_context") {
      cwd = typeof b.cwd === "string" ? b.cwd : cwd;
      turn = b.turn_id || row.timestamp;
    }
    if (row.type === "event_msg" && b.type === "item_completed") {
      if (b.thread_id && `codex-${b.thread_id}` !== meta.id) continue;
      const i = b.item;
      if (i?.type === "UserMessage") prompt(i.content?.find?.((c) => typeof c.text === "string")?.text, at, 3);
      if (i?.type === "FileChange" && i.status === "completed") {
        recorded.add(i.id);
        changes(i.id, i.changes, at);
      }
      if (i?.type === "McpToolCall" && i.status === "completed" && isPost(i.tool)) {
        const post = postFrom(i.result);
        if (post) posts.add(post);
      }
      continue;
    }
    // Forked rollouts can contain copied response items with no owner. Only the typed completion
    // above carries a thread ID that lets us distinguish the child's work from its parent's.
    if (inherited) continue;
    if (row.type === "event_msg") {
      if (b.type === "user_message") prompt(b.message, at, 2);
      if (b.type === "patch_apply_end" && b.success === true) {
        recorded.add(b.call_id);
        changes(b.call_id, b.changes, at);
      }
      if (b.type === "mcp_tool_call_end" && isPost(b.invocation?.tool)) {
        const post = postFrom(b.result);
        if (post) posts.add(post);
      }
    }
    if (row.type === "response_item") {
      if (b.type === "custom_tool_call" && b.name === "apply_patch" && typeof b.input === "string") {
        patches.set(b.call_id, { input: b.input, cwd });
      }
      if (b.type === "custom_tool_call_output" && patches.has(b.call_id)) {
        const patch = patches.get(b.call_id);
        patches.delete(b.call_id);
        if (!recorded.has(b.call_id) && patchSucceeded(b.output)) changes(b.call_id, appliedPatch(patch.input), at, patch.cwd);
      }
      if (b.type === "message" && b.role === "user") {
        const message = b.content?.find?.((c) => c.type === "input_text")?.text;
        if (typeof message === "string" && !/^\s*(?:<|# AGENTS\.md instructions)/.test(message)) prompt(message, at, 1);
      }
      if (b.type === "function_call" && isPost(b.name)) posting.add(b.call_id);
      if (b.type === "function_call_output" && posting.delete(b.call_id)) {
        const post = postFrom(b.output);
        if (post) posts.add(post);
      }
    }
  }
  if (!meta) return null;
  const messages = [...prompts.values()].flatMap((p) => p.entries);
  return { ...meta, title: messages[0]?.title || "", prompts: messages.map((m) => m.at), edits: [...edits.values()], posts: [...posts] };
}

export async function codexSessions(walk) {
  const names = new Map();
  try {
    for await (const row of rows(path.join(CODEX_HOME, "session_index.jsonl"))) {
      if (typeof row.thread_name === "string" && row.thread_name.trim()) names.set(`codex-${row.id}`, row.thread_name);
    }
  } catch (err) { if (!["ENOENT", "EACCES", "EPERM"].includes(err.code)) throw err; }
  const sessions = new Map(), nextCache = new Map();
  let remaining = maxCacheSize;
  for (const dir of ["sessions", "archived_sessions"]) {
    for (const file of walk(path.join(CODEX_HOME, dir), (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))) {
      try {
        const st = fs.statSync(file);
        const stamp = `${st.mtimeMs}:${st.size}`;
        let entry = cache.get(file);
        if (entry?.stamp !== stamp) {
          const session = await readRollout(file);
          // Account for retained strings and records without serializing a second copy.
          let size = 512 + file.length * 2;
          if (session) {
            size += 2 * (session.cwd.length + session.title.length) + session.posts.length * 64 + session.prompts.length * 16;
            for (const e of session.edits) {
              size += 256 + 2 * (e.path.length + e.id.length);
              for (const h of e.hunks) for (const l of h.lines) size += 64 + 2 * l.length;
            }
          }
          entry = { stamp, session, size };
        }
        if (entry.size <= remaining) { nextCache.set(file, entry); remaining -= entry.size; }
        const { session } = entry;
        if (session && !sessions.has(session.id)) sessions.set(session.id, { ...session, title: names.get(session.id) || session.title, archived: dir === "archived_sessions" });
      } catch (err) { if (!["ENOENT", "EACCES", "EPERM"].includes(err.code)) throw err; }
    }
  }
  cache.clear();
  for (const [file, entry] of nextCache) cache.set(file, entry);
  return sessions;
}
