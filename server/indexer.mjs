// Reads local Claude and Codex sessions,
// and rebuilds each published page at every publish by replaying Write and Edit calls.
// Output: index.json in the Rounds data folder, plus content-addressed snapshots in its store.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

import { HOME, DATA, STORE, IMG, POSTS, PUSHES, PUBLISHED, CLAUDE, DESKTOP_SESSIONS, projects, loadConfig } from "./config.mjs";
import { filePostTopics } from "./topics.mjs";
import { codexSessions, isCodexData } from "./codex-history.mjs";
export { DATA, STORE, IMG };
const TRANSCRIPTS = path.join(CLAUDE, "projects");

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

// A program on PATH, or null. Looked for by hand, so nothing is spawned to find out.
export function which(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}
// sips is macOS's own image tool. Elsewhere there is none, and nothing asks it.
let sips;
export const hasSips = () => (sips ??= !!which("sips"));

function walk(dir, test, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(e.name)) out.push(p);
  }
  return out;
}

function readThreads(P, hidden) {
  const threads = new Map();
  const byCli = new Map();
  for (const file of walk(DESKTOP_SESSIONS, (n) => n.startsWith("local_") && n.endsWith(".json"))) {
    let s;
    try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!s.sessionId || !s.title) continue;
    const recap = s.turnWrapUp?.description || s.postTurnSummary?.status_detail || "";
    const t = {
      id: s.sessionId,
      title: s.title,
      cwd: s.cwd || "",
      archived: !!s.isArchived,
      at: Number(s.lastActivityAt || s.createdAt || 0),
      recap,
      clis: [s.cliSessionId, s.lastAssistantCliSessionId].filter(Boolean),
    };
    if (P.isPrivate(t.title, t.cwd)) {
      hidden.add(t.id);
      for (const cli of t.clis) hidden.add(cli);
      continue;
    }
    threads.set(t.id, t);
    for (const cli of [s.cliSessionId, s.lastAssistantCliSessionId]) if (cli) byCli.set(cli, t.id);
  }
  return { threads, byCli };
}

function applyEdit(text, input) {
  if (text == null) return null;
  const { old_string: a, new_string: b, replace_all } = input;
  if (typeof a !== "string" || typeof b !== "string" || !text.includes(a)) return null;
  return replace_all ? text.split(a).join(b) : text.replace(a, () => b);
}

// What one Edit, Write or MultiEdit changed, as Claude Code recorded it: the hunks with their
// line numbers, or a new file's lines. A very long change keeps its first lines and says how many
// more there were.
const CUT = 600;
const linesOf = (s) => { const a = s.split("\n"); if (a.length > 1 && a[a.length - 1] === "") a.pop(); return a; };
function changeOf(name, input, r) {
  r = r && typeof r === "object" ? r : null;
  let hunks;
  if (r?.type === "create" && typeof r.content === "string") hunks = [{ o: 0, n: 1, lines: linesOf(r.content).map((l) => `+${l}`) }];
  else if (Array.isArray(r?.structuredPatch) && r.structuredPatch.length) hunks = r.structuredPatch.map((h) => ({ o: h.oldStart, n: h.newStart, lines: h.lines }));
  else if (name === "Write" && typeof input.content === "string") hunks = [{ o: 0, n: 1, lines: linesOf(input.content).map((l) => `+${l}`) }];
  else {
    // no record of the result: the old and new text, with the lines they share as context
    hunks = (name === "MultiEdit" ? input.edits || [] : [input]).filter((e) => typeof e?.old_string === "string" && typeof e?.new_string === "string").map((e) => {
      const a = linesOf(e.old_string), b = linesOf(e.new_string);
      let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
      let t = 0; while (t < a.length - s && t < b.length - s && a[a.length - 1 - t] === b[b.length - 1 - t]) t++;
      return { o: 0, n: 0, lines: [...a.slice(0, s).map((l) => ` ${l}`), ...a.slice(s, a.length - t).map((l) => `-${l}`), ...b.slice(s, b.length - t).map((l) => `+${l}`), ...a.slice(a.length - t).map((l) => ` ${l}`)] };
    });
  }
  let add = 0, del = 0;
  for (const h of hunks) for (const l of h.lines) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
  let left = CUT, cut = 0;
  const kept = [];
  for (const h of hunks) {
    const take = h.lines.slice(0, Math.max(0, left));
    cut += h.lines.length - take.length; left -= take.length;
    if (take.length) kept.push({ ...h, lines: take });
  }
  return { add, del, hunks: kept, ...(cut ? { cut } : {}), ...(r?.type === "create" ? { created: true } : {}) };
}

// The repo a changed file belongs to and its path there. A worktree counts as the repo it was
// made from, so two sessions in two worktrees changing one file change the same file; what a
// worktree belonged to is remembered (repos.json) for when it has been removed. Scratch and temp
// files, Claude's own folder and Library belong to no project.
const REPOS = path.join(DATA, "repos.json");
function repoFinder() {
  let known = {};
  try { known = JSON.parse(fs.readFileSync(REPOS, "utf8")); } catch {}
  const memo = new Map();
  let dirty = false;
  const off = (f) => /^\/(private\/)?(tmp|var\/folders)\//.test(f) || f.includes("/scratchpad/") || f.startsWith(`${path.join(HOME, ".claude")}/`) || f.startsWith(`${path.join(HOME, "Library")}/`);
  const at = (d) => {
    if (memo.has(d)) return memo.get(d);
    let out = null;
    const wt = d.match(/^(.*)\/\.claude\/worktrees\/[^/]+$/);
    if (wt) out = { root: d, repo: wt[1] };
    else if (known[d]) out = { root: d, repo: known[d] };
    else {
      let st = null;
      try { st = fs.statSync(path.join(d, ".git")); } catch {}
      if (st?.isDirectory()) out = { root: d, repo: d };
      else if (st?.isFile()) {
        let gd = "";
        try { gd = (fs.readFileSync(path.join(d, ".git"), "utf8").match(/gitdir:\s*(.+)/) || [])[1]?.trim() || ""; } catch {}
        gd = gd && path.resolve(d, gd);
        const i = gd.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
        out = { root: d, repo: i > 0 ? gd.slice(0, i) : d };
      }
      if (out && !known[d]) { known[d] = out.repo; dirty = true; }
    }
    memo.set(d, out);
    return out;
  };
  return {
    find(file) {
      if (!path.isAbsolute(file) || off(file) || isCodexData(file)) return null;
      for (let d = path.dirname(file); d !== HOME && d !== path.dirname(d); d = path.dirname(d)) {
        const r = at(d);
        if (r) return { repo: r.repo, file: path.relative(r.root, file) };
      }
      return null;
    },
    save() { if (dirty) try { fs.writeFileSync(REPOS, JSON.stringify(known)); } catch {} },
  };
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/;

const DAY_RE = /"timestamp":"([0-9T:.\-]+Z)"/;
// The day in this Mac's own time zone, so a late-night prompt counts for that evening.
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;
// A Rounds post made through the MCP server: the result names the post it made.
const POST_RE = /\bpost ([a-f0-9]{16})\b/;

async function readTranscript(file, onPublish, onDay, onSend, onMeta = () => {}, onPost = () => {}, onEdit = () => {}) {
  const files = new Map(); // path -> reconstructed text, or null when unknown
  const posting = new Set(); // tool_use ids of Rounds posts
  const meta = { cwd: "", title: "", summary: "", at: 0 };
  let lastLine = "";
  const pending = new Map(); // tool_use id -> publish
  const sending = new Map(); // tool_use id -> a set of screens shown to him
  const editing = new Map(); // tool_use id -> a file being changed
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    // A prompt he typed: a user row that is not a tool result. Counted per day, cheaply.
    if (line.startsWith('{"parentUuid"') || line.includes('"type":"user"')) {
      if (line.includes('"type":"user"') && !line.includes("tool_result") && !line.includes('"isMeta":true')) {
        const m = line.match(DAY_RE);
        if (m) onDay(localDay(m[1]));
        // a session with no desktop record is named for its first prompt
        if (!meta.title) {
          try {
            const r = JSON.parse(line);
            const c = r.message?.content;
            const t = typeof c === "string" ? c : Array.isArray(c) ? c.find((x) => x.type === "text")?.text : "";
            // not a command (/compact) or a pasted block; a person's first words
            // a file it was handed (@"~/Downloads/brief.md") is no part of the name
            const words = t && t.replace(/@"[^"]*"|@[~/]\S*/g, "").replace(/\s+/g, " ").trim();
            if (words && !/^\s*[</]/.test(t)) meta.title = words.slice(0, 64);
          } catch {}
        }
      }
    }
    if (!meta.cwd) { const m = line.match(CWD_RE); if (m) meta.cwd = JSON.parse(`"${m[1]}"`); }
    lastLine = line;
    if (line.startsWith('{"type":"summary"')) { try { meta.summary = JSON.parse(line).summary || meta.summary; } catch {} }
    if (!line.includes("tool_")) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === "tool_use") {
        const i = c.input || {};
        if ((c.name === "Edit" || c.name === "Write" || c.name === "MultiEdit") && typeof i.file_path === "string") editing.set(c.id, { name: c.name, input: i });
        if (c.name === "Write" && i.file_path && typeof i.content === "string") files.set(i.file_path, i.content);
        else if (c.name === "Edit" && i.file_path) files.set(i.file_path, applyEdit(files.get(i.file_path), i));
        else if (c.name === "MultiEdit" && i.file_path) {
          let t = files.get(i.file_path);
          for (const e of i.edits || []) t = applyEdit(t, e);
          files.set(i.file_path, t);
        } else if (c.name === "SendUserFile" && Array.isArray(i.files)) {
          const cwd = row.cwd || "";
          const shots = i.files
            .filter((f) => typeof f === "string" && /\.(png|jpe?g|webp)$/i.test(f))
            .map((f) => (f.startsWith("~") ? path.join(HOME, f.slice(1)) : path.isAbsolute(f) ? f : path.join(cwd, f)));
          if (shots.length) sending.set(c.id, { id: c.id, session: row.sessionId, shots, caption: typeof i.caption === "string" ? i.caption : "", cwd, at: Date.parse(row.timestamp) || 0 });
        } else if (/(rounds|workbench)_(post|change)$/.test(c.name || "")) {
          posting.add(c.id);
        } else if (c.name === "Artifact" && i.file_path && /\.html?$/i.test(i.file_path) && !i.asset && (!i.action || i.action === "publish")) {
          // a path given from the session's folder (scratch/page/index.html) is in that folder
          const fp = i.file_path.startsWith("~/") ? path.join(HOME, i.file_path.slice(2)) : path.resolve(row.cwd || meta.cwd || HOME, i.file_path);
          pending.set(c.id, {
            session: row.sessionId,
            filePath: fp,
            url: typeof i.url === "string" ? i.url : null,
            text: files.has(fp) ? files.get(fp) : files.has(i.file_path) ? files.get(i.file_path) : null,
            at: Date.parse(row.timestamp) || 0,
          });
        }
      } else if (c.type === "tool_result" && editing.has(c.tool_use_id)) {
        const e = editing.get(c.tool_use_id);
        editing.delete(c.tool_use_id);
        if (!c.is_error) onEdit({ id: c.tool_use_id, session: row.sessionId, path: e.input.file_path, at: Date.parse(row.timestamp) || 0, ...changeOf(e.name, e.input, row.toolUseResult) });
      } else if (c.type === "tool_result" && posting.has(c.tool_use_id)) {
        posting.delete(c.tool_use_id);
        const body = typeof c.content === "string" ? c.content : JSON.stringify(c.content || "");
        const m = body.match(/\bto (?:Rounds|Workbench) as post ([a-f0-9]{16})\b/i) || body.match(POST_RE);
        if (m && !c.is_error) onPost(m[1], row.sessionId);
      } else if (c.type === "tool_result" && sending.has(c.tool_use_id)) {
        const send = sending.get(c.tool_use_id);
        sending.delete(c.tool_use_id);
        if (!c.is_error) onSend(send);
      } else if (c.type === "tool_result" && pending.has(c.tool_use_id)) {
        const p = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        const body = typeof c.content === "string" ? c.content : JSON.stringify(c.content || "");
        if (c.is_error || /refused|rejected|conflict/i.test(body.slice(0, 200))) continue;
        const m = body.match(ARTIFACT_URL);
        p.url = p.url || (m && m[0]);
        if (p.url) onPublish(p);
      }
    }
  }
  { const m = lastLine.match(DAY_RE); if (m) meta.at = Date.parse(m[1]) || 0; }
  onMeta(meta);
}

// A subagent's transcript, for the files it changed and nothing else: only the rows that can
// hold a change are read.
async function readEdits(file, onEdit) {
  const editing = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!(editing.size && line.includes('"tool_result"')) && !/"name":"(Edit|Write|MultiEdit)"/.test(line)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === "tool_use" && (c.name === "Edit" || c.name === "Write" || c.name === "MultiEdit") && typeof c.input?.file_path === "string") editing.set(c.id, { name: c.name, input: c.input });
      else if (c.type === "tool_result" && editing.has(c.tool_use_id)) {
        const e = editing.get(c.tool_use_id);
        editing.delete(c.tool_use_id);
        if (!c.is_error) onEdit({ id: c.tool_use_id, session: row.sessionId, path: e.input.file_path, at: Date.parse(row.timestamp) || 0, ...changeOf(e.name, e.input, row.toolUseResult) });
      }
    }
  }
}

// Width and height from the file's own header (PNG, JPEG), else from sips where there is one.
function dims(buf, file) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length - 9) {
      if (buf[o] !== 0xff) { o++; continue; }
      const m = buf[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(o + 7), h: buf.readUInt16BE(o + 5) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  if (!hasSips()) return null;
  try {
    const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
    return { w: Number(out.match(/pixelWidth: (\d+)/)[1]), h: Number(out.match(/pixelHeight: (\d+)/)[1]) };
  } catch { return null; }
}

// A screen a session showed, copied into the store by its content so it outlives the scratchpad
// it was saved to.
export function keepImage(file) {
  let buf;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 40e6) return null;
    buf = fs.readFileSync(file);
  } catch { return null; }
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const ext = path.extname(file).slice(1).toLowerCase().replace("jpeg", "jpg");
  const dest = path.join(IMG, `${hash}.${ext}`);
  const metaFile = path.join(IMG, `${hash}.json`);
  if (fs.existsSync(metaFile)) {
    try { return JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
  }
  const d = dims(buf, file);
  if (!d || !d.w || !d.h) return null;
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  const meta = { hash, ext, w: d.w, h: d.h, name: path.basename(file, path.extname(file)) };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  return meta;
}

function readDir(dir) {
  const records = [];
  let files;
  try { files = fs.readdirSync(dir); } catch { return records; }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try { records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))); } catch {}
  }
  return records;
}

// Posts the MCP server wrote (see server/mcp.mjs). Screens become a set; a page becomes a version
// of the page at that path, so posting the same file again makes a before and after; a change
// becomes a set of after screens, each with its before. Pushes the git hook saw become text.
function readPosts(posts, P, threads, postThread, pages, sets) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  for (const p of posts) {
    const threadId = postThread.get(p.id) || null;
    const thread = threadId ? threads.get(threadId) : null;
    const project = thread ? P.of([thread.title], thread.cwd) : P.of([p.caption], p.cwd);
    if (p.page) {
      const id = `post-${p.page.key}`;
      const page = pages.get(id) || { id, url: "", filePath: p.page.path, thread: threadId, versions: [], project, cwd: p.cwd, posted: true };
      page.title = p.page.title || page.title;
      page.topic = p.topic || page.topic;
      page.versions.push({ at: p.at, thread: threadId, text: (() => { try { return fs.readFileSync(path.join(STORE, `${p.page.hash}.html`), "utf8"); } catch { return null; } })() });
      if (threadId) page.thread = threadId;
      pages.set(id, page);
    }
    if (!p.shots?.length && p.kind !== "change") continue;
    // before screens: given with the post, or the screens of the post it replaces, by position
    const prev = p.replaces ? byId.get(p.replaces) : null;
    const before = p.before?.length ? p.before : prev?.shots || [];
    sets.push({
      id: p.id, thread: threadId, project, at: p.at, caption: p.caption || "", topic: p.topic || "",
      kind: p.kind, shots: p.shots || [], ...(before.length ? { before } : {}), ...(p.commits ? { commits: p.commits } : {}),
    });
  }
  for (const x of readDir(PUSHES)) {
    if (P.isPrivate(x.repo, ...(x.commits || []).map((c) => c.subject))) continue;
    // the session recorded this push itself, with screens: keep that one
    const same = (a, b) => a.startsWith(b) || b.startsWith(a);
    if (posts.some((p) => p.kind === "change" && (x.commits || []).length && x.commits.every((c) => (p.commits || []).some((pc) => same(c.sha, pc.sha))))) continue;
    sets.push({ id: x.id, thread: null, project: P.of([], x.repo), at: x.at, caption: x.summary || `Pushed to ${x.branch}`, topic: "Changes", kind: "push", shots: [], commits: x.commits, files: x.files });
  }
  return posts.length;
}

const titleOf = (html) => {
  const m = html && html.match(/<title>([^<]{1,120})<\/title>/i);
  return m ? m[1].trim().replace(/&amp;/g, "&") : null;
};

// Rounds keeps what it has seen. Claude Code deletes a terminal session's transcript after
// cleanupPeriodDays (30 by default), and a desktop thread's record goes when the thread is
// deleted; the screens and pages they showed are already in the store. So each index starts from
// the last one: a send or a page read from a transcript that's gone carries on, and so do a
// session's name and its days. A session no longer on this Mac is marked gone: its work stays
// on the canvas, but there's nothing left in Claude to open or send a note to. Posts and pushes
// keep their own records in the data folder and are read from there. What the config now keeps
// private still leaves.
function keepSeen(index, P, hidden, prev) {
  if (!prev) return 0;
  const threads = new Map(index.threads.map((t) => [t.id, t]));
  const indexedThreads = new Set(threads.keys());
  // a send's session as it is now, or as the last index knew it (to judge a session gone private)
  const was = new Map((prev.threads || []).map((t) => [t.id, t]));
  const whose = (id) => (id && (threads.get(id) || was.get(id))) || null;
  let kept = 0;
  for (const t of prev.threads || []) {
    const now = threads.get(t.id);
    if (now) {
      // its days are counted from its transcript: the ones counted before stay counted
      for (const [d, n] of Object.entries(t.days || {})) if (!(now.days[d] >= n)) now.days[d] = n;
      continue;
    }
    if (hidden.has(t.id) || P.isPrivate(t.title, t.cwd)) continue;
    const g = { ...t, gone: true, project: P.of([t.title], t.cwd) };
    index.threads.push(g);
    threads.set(t.id, g);
  }
  // a post tied to the Claude Code session inside a desktop thread that's gone finds that thread
  const byCli = new Map();
  for (const t of index.threads) if (t.gone) for (const c of t.clis || []) byCli.set(c, t.id);
  for (const x of [...index.sets, ...index.pages]) if (x.thread && !threads.has(x.thread) && byCli.has(x.thread)) x.thread = byCli.get(x.thread);

  const inStore = (sh) => fs.existsSync(path.join(IMG, `${sh.hash}.${sh.ext}`));
  const have = new Set(index.sets.map((x) => x.id));
  for (const x of prev.sets || []) {
    if (x.kind || have.has(x.id)) continue; // only sends read from transcripts have no kind
    const t = x.thread ? threads.get(x.thread) : null, w = whose(x.thread);
    if (hidden.has(x.thread) || P.isPrivate(x.caption, w?.title, w?.cwd)) continue;
    const shots = x.shots.filter(inStore);
    if (!shots.length) continue;
    index.sets.push({ ...x, thread: t ? x.thread : null, shots, project: t ? P.of([t.title], t.cwd) : x.project });
    kept++;
  }
  index.sets.sort((a, b) => a.at - b.at);

  const pages = new Map(index.pages.map((x) => [x.id, x]));
  for (const x of prev.pages || []) {
    if (x.posted) continue;
    const versions = x.versions.filter((v) => fs.existsSync(path.join(STORE, `${v.hash}.html`)));
    const now = pages.get(x.id);
    if (now) {
      // a page rebuilt from fewer transcripts than before keeps the publishes it had
      const hashes = new Set(now.versions.map((v) => v.hash));
      const more = versions.filter((v) => !hashes.has(v.hash));
      if (more.length) { now.versions = [...now.versions, ...more].sort((a, b) => a.at - b.at); now.at = now.versions[now.versions.length - 1].at; }
      continue;
    }
    const t = x.thread ? threads.get(x.thread) : null, w = whose(x.thread);
    if (!versions.length || hidden.has(x.thread) || P.isPrivate(x.title, x.dir, w?.title, w?.cwd)) continue;
    index.pages.push({ ...x, thread: t ? x.thread : null, versions, at: versions[versions.length - 1].at });
    kept++;
  }
  // the files a session changed, when its transcript is gone, from the last index (the changes
  // themselves stay in the store)
  for (const c of prev.changed || []) {
    const t = threads.get(c.thread);
    if (!t || indexedThreads.has(c.thread) || P.isPrivate(c.repo, c.file, t.title, t.cwd)) continue;
    if (!fs.existsSync(path.join(EDITS, `${c.thread}.json`))) continue;
    index.changed.push(c);
  }
  index.folders = [...new Set([...(index.folders || []), ...(prev.folders || []).filter((cwd) => !P.isPrivate(cwd))])];
  index.projects = { ...(prev.projects || {}), ...Object.fromEntries(P.names) };
  return kept;
}

// Each session's changes to project files, every hunk, in the store (one file per session), and
// in the index what the canvas needs to list them: per file, when each change came and how many
// lines it added and removed. A session's store file keeps the changes it had: a transcript
// rebuilt from fewer rows than before (a forked or cleaned-up session) loses none.
const EDITS = path.join(STORE, "edits");
const fileKey = (repo, file) => `${repo}\n${file}`;
// What git ignores in a repo (scratch folders, builds, node_modules) is no project's file either.
// Asked once per repo per build; a repo that's gone, or no git, ignores nothing.
function ignored(lists) {
  const out = new Set();
  if (!which("git")) return out;
  for (const [repo, files] of lists) {
    if (!fs.existsSync(repo)) continue;
    let text = "";
    try { text = execFileSync("git", ["-C", repo, "check-ignore", "--stdin"], { input: [...files].join("\n"), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }); }
    catch (e) { text = e.stdout || ""; } // it exits 1 when nothing is ignored
    for (const f of text.split("\n")) if (f) out.add(fileKey(repo, f));
  }
  return out;
}
function keepEdits(edits, threads, P, hidden, privateEdits) {
  fs.mkdirSync(EDITS, { recursive: true });
  const lists = new Map();
  for (const e of edits.values()) lists.set(e.repo, (lists.get(e.repo) || new Set()).add(e.file));
  const skip = ignored(lists);
  const byThread = new Map();
  for (const e of edits.values()) {
    const t = threads.get(e.thread);
    if (!t || skip.has(fileKey(e.repo, e.file)) || P.isPrivate(e.repo, e.file, t.title, t.cwd)) continue;
    const m = byThread.get(e.thread) || new Map();
    const k = fileKey(e.repo, e.file);
    m.set(k, [...(m.get(k) || []), { at: e.at, add: e.add, del: e.del, hunks: e.hunks, ...(e.source ? { source: e.source } : {}), ...(e.cut ? { cut: e.cut } : {}), ...(e.created ? { created: true } : {}) }]);
    byThread.set(e.thread, m);
  }
  // a session whose changes were all read in an earlier build (a subagent's, say) keeps them
  for (const f of fs.readdirSync(EDITS)) { const id = f.replace(/\.json$/, ""); if (threads.has(id) && !byThread.has(id)) byThread.set(id, new Map()); }
  const out = [];
  for (const [thread, m] of byThread) {
    const f = path.join(EDITS, `${thread}.json`);
    let was = {};
    try { was = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const t = threads.get(thread);
    for (const [k, list] of Object.entries(was)) {
      const [repo, file] = k.split("\n");
      if (P.isPrivate(repo, file, t.title, t.cwd)) continue;
      const now = m.get(k) || [];
      const have = new Set(now.map((e) => `${e.at} ${e.add} ${e.del}`));
      for (const e of list) {
        const stamp = `${e.at} ${e.add} ${e.del}`;
        if (have.has(stamp) || hidden.has(e.source) || (!e.source && privateEdits.has(`${k}\n${stamp}`))) continue;
        now.push(e);
      }
      if (now.length) m.set(k, now);
    }
    const store = {};
    for (const [k, list] of m) {
      list.sort((a, b) => a.at - b.at);
      store[k] = list;
      const [repo, file] = k.split("\n");
      out.push({ thread, repo, file, edits: list.map((e) => [e.at, e.add, e.del]) });
    }
    const text = JSON.stringify(store);
    let same = false;
    try { same = fs.statSync(f).size === Buffer.byteLength(text) && fs.readFileSync(f, "utf8") === text; } catch {}
    if (!same) fs.writeFileSync(f, text);
  }
  return out;
}

export async function buildIndex({ log = () => {} } = {}) {
  const scanStartedAt = Date.now();
  fs.mkdirSync(IMG, { recursive: true });
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8")); } catch {}
  const cfg = loadConfig();
  const P = projects(cfg);
  const hidden = new Set();
  const privateEdits = new Set();
  const { threads, byCli } = readThreads(P, hidden);
  const cliMeta = new Map(); // a session with no desktop record: what its transcript says
  const postThread = new Map(); // post id -> the thread that made it
  const codexChildren = new Map();
  const sets = [];
  const pages = new Map(); // artifact id -> page
  const days = new Map(); // thread id -> { "YYYY-MM-DD": prompts }

  // a subagent's transcript belongs to its parent session; it isn't a thread of its own, but the
  // files it changed were changed for that session
  const all = walk(TRANSCRIPTS, (n) => n.endsWith(".jsonl"));
  const isSub = (f) => f.includes(`${path.sep}subagents${path.sep}`);
  const transcripts = all.filter((f) => !isSub(f));
  log(`${threads.size} threads, ${transcripts.length} transcripts`);
  const repos = repoFinder();
  const edits = new Map(); // tool_use id -> a change to a project file, and the thread that made it
  // A change belongs to the session that made it: a forked session's transcript carries its
  // parent's rows, still marked with the parent's id, and a subagent's rows carry its session's.
  const editsFor = (threadId) => (e) => {
    if (edits.has(e.id) || (!e.add && !e.del)) return;
    const where = repos.find(e.path);
    const { session, ...rest } = e;
    if (where) edits.set(e.id, { ...rest, ...where, thread: session ? byCli.get(session) || session : threadId });
  };
  // a subagent's transcript stops changing when it finishes: one read before is enough, its
  // changes are in the store
  const AGENTS = path.join(DATA, "agents-read.json");
  let agents = {};
  try { agents = JSON.parse(fs.readFileSync(AGENTS, "utf8")); } catch {}
  const agentsNow = {};
  for (const file of all.filter(isSub)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    agentsNow[file] = stamp;
    if (agents[file] === stamp) continue;
    const cli = path.basename(path.dirname(path.dirname(file)));
    await readEdits(file, editsFor(byCli.get(cli) || cli));
  }
  for (const file of transcripts) {
    const cli = path.basename(file, ".jsonl");
    // the desktop app's record when there is one; otherwise the Claude Code session itself
    const threadId = byCli.get(cli) || cli;
    // what a row did belongs to the session it names: a forked session's transcript carries its
    // parent's rows, marked with the parent's id
    const own = (session) => (session ? byCli.get(session) || session : threadId);
    await readTranscript(file, (p) => {
      const id = p.url.split("/").pop();
      const tid = own(p.session);
      const page = pages.get(id) || { id, url: p.url, filePath: p.filePath, thread: tid, versions: [] };
      page.filePath = p.filePath;
      if (tid) page.thread = tid;
      let text = p.text;
      page.versions.push({ at: p.at, text });
      pages.set(id, page);
    }, (day) => {
      if (!threadId) return;
      const d = days.get(threadId) || {};
      d[day] = (d[day] || 0) + 1;
      days.set(threadId, d);
    }, (send) => {
      // each send once, under the session that made it (one with a name, when an older
      // transcript doesn't say)
      const tid = own(send.session);
      const dup = sets.find((x) => x.id === sha(send.id));
      if (dup) { if (threads.has(tid) && !threads.has(dup.thread)) dup.thread = tid; return; }
      const thread = threads.get(tid);
      if (byCli.has(send.session || cli) && !thread) return; // its desktop thread was kept off the canvas
      if (P.isPrivate(send.caption, send.cwd, send.shots.join(" "), thread?.title, thread?.cwd)) return;
      const shots = [];
      for (const f of send.shots) {
        const m = keepImage(f);
        if (m && !shots.some((x) => x.hash === m.hash)) shots.push(m);
      }
      if (!shots.length) return;
      sets.push({
        id: sha(send.id),
        thread: tid,
        // the thread decides first; a caption that says "mid-ride" shouldn't move a Shadowfax send
        // the thread decides; a caption that says "mid-ride" or "Shadowfax" doesn't move a send
        project: thread ? P.of([thread.title], thread.cwd) : P.of([send.caption, send.shots[0]], send.cwd),
        at: send.at,
        caption: send.caption,
        shots,
      });
    }, (meta) => {
      if (!threads.has(threadId)) cliMeta.set(threadId, meta);
    }, (postId, session) => postThread.set(postId, own(session)), editsFor(threadId));
  }
  const codex = await codexSessions(walk);
  const previousThreads = new Map((previous?.threads || []).map((t) => [t.id, t]));
  const priorCodexOwner = new Map();
  for (const t of previousThreads.values()) {
    if (!t.native || t.client !== "codex") continue;
    priorCodexOwner.set(t.id, t);
    for (const id of t.clis || []) {
      priorCodexOwner.set(id, t);
      if (!codex.has(id)) byCli.set(id, t.id);
    }
    if (!codex.has(t.id) && P.isPrivate(t.title, t.cwd)) hidden.add(t.id);
  }
  // A skipped owner has no public index entry. Keep ID-only evidence across cleanup, including
  // when an additional exclusion is configured while the transcript is gone.
  const privateHistoryFile = path.join(DATA, "private-history.json");
  const rules = sha(JSON.stringify(cfg.private));
  const patterns = new Map((cfg.private || []).map((pattern) => [sha(pattern), new RegExp(pattern, "i")]));
  const reasons = new Map();
  let privateHistory;
  try { privateHistory = JSON.parse(fs.readFileSync(privateHistoryFile, "utf8")); } catch {}
  for (const id of privateHistory?.sessions || []) {
    const matches = privateHistory.reasons?.[id];
    if (!patterns.size || (matches && !matches.some((rule) => patterns.has(rule)))) continue;
    if (codex.has(id) || cliMeta.has(id) || threads.has(id)) continue;
    hidden.add(id);
    reasons.set(id, matches || [...patterns.keys()]);
  }
  for (const session of codex.values()) {
    let owner = session;
    const ancestors = new Set();
    let privateSession = false;
    while (!ancestors.has(owner.id)) {
      ancestors.add(owner.id);
      if (P.isPrivate(owner.title, owner.cwd)) {
        const subject = [owner.title, owner.cwd].filter(Boolean).join(" ");
        reasons.set(session.id, [...patterns].filter(([, re]) => re.test(subject)).map(([key]) => key));
        privateSession = true;
        break;
      }
      if (hidden.has(owner.parent)) {
        reasons.set(session.id, reasons.get(owner.parent) || [...patterns.keys()]);
        privateSession = true;
        break;
      }
      const parent = codex.get(owner.parent) || priorCodexOwner.get(owner.parent);
      if (!parent) break;
      owner = parent;
    }
    if (privateSession) {
      hidden.add(session.id);
      for (const post of session.posts) postThread.set(post, session.id);
      // Earlier Rounds edit files omitted the contributing subagent's ID.
      if (session.parent) for (const e of session.edits) {
        const where = repos.find(e.path);
        if (where) privateEdits.add(`${fileKey(where.repo, where.file)}\n${e.at} ${e.add} ${e.del}`);
      }
      continue;
    }
    byCli.set(session.id, owner.id);
    if (!codex.has(owner.id)) threads.set(owner.id, { ...owner, gone: true });
    if (session.id === owner.id) {
      cliMeta.set(owner.id, { ...owner, client: "codex" });
      const counts = {};
      for (const at of owner.prompts) {
        const day = localDay(at);
        counts[day] = (counts[day] || 0) + 1;
      }
      days.set(owner.id, counts);
    }
    for (const post of session.posts) postThread.set(post, owner.id);
    const record = editsFor(owner.id);
    for (const edit of session.edits) record(session.id === owner.id ? edit : { ...edit, source: session.id });
  }
  for (const [id, owner] of byCli) {
    if (!id.startsWith("codex-") || id === owner || hidden.has(id) || hidden.has(owner)) continue;
    const children = codexChildren.get(owner) || [];
    children.push(id);
    codexChildren.set(owner, children);
  }
  repos.save();

  // Pages the tool hook caught as they were published (hooks/tool.mjs): one written by a script
  // the transcript can't replay, or kept in a folder that's gone since, still has what it was.
  for (const rec of readDir(PUBLISHED)) {
    if (!rec.id || !rec.url) continue;
    const page = pages.get(rec.id) || { id: rec.id, url: rec.url, filePath: rec.filePath, thread: rec.session ? byCli.get(rec.session) || rec.session : null, versions: [] };
    for (const v of rec.versions || []) if (!page.versions.some((x) => x.hash === v.hash)) page.versions.push({ at: v.at, text: null, hash: v.hash });
    pages.set(rec.id, page);
  }

  // A post the tool hook tied to its session belongs to that session's thread (the desktop
  // thread it runs in, or the session itself), even before its transcript mentions it.
  const posts = readDir(POSTS).sort((a, b) => a.at - b.at);
  for (const [post, owner] of privateHistory?.owners || []) {
    if (hidden.has(owner) && !postThread.has(post)) postThread.set(post, owner);
  }
  const priorOwners = new Map((previous?.sets || []).filter((x) => x.thread).map((x) => [x.id, x.thread]));
  const priorPages = new Map((previous?.pages || []).map((p) => [p.id, p]));
  for (const p of posts) {
    if (p.session && (p.client || !postThread.has(p.id))) postThread.set(p.id, hidden.has(p.session) ? p.session : byCli.get(p.session) || p.session);
    if (!postThread.has(p.id)) {
      const priorPage = p.page && priorPages.get(`post-${p.page.key}`);
      const version = priorPage?.versions.find((v) => v.hash === p.page.hash && v.at === p.at);
      const prior = priorOwners.get(p.id) || version?.thread || (priorPage?.versions.length === 1 && priorPage.thread);
      if (prior) postThread.set(p.id, prior);
    }
  }
  for (const t of previous?.threads || []) {
    if (!cliMeta.has(t.id) && !threads.has(t.id) && P.isPrivate(t.title, t.cwd)) hidden.add(t.id);
  }

  // A Claude Code session with no desktop record becomes a thread when it made something.
  let stored = [];
  try { stored = fs.readdirSync(EDITS).map((f) => f.replace(/\.json$/, "")); } catch {}
  const madeBy = new Set([...sets.map((s) => s.thread), ...[...pages.values()].map((p) => p.thread), ...postThread.values(), ...[...edits.values()].map((e) => e.thread), ...stored]);
  for (const [id, m] of cliMeta) {
    const title = m.summary || m.title || path.basename(m.cwd || "") || "Session";
    if (P.isPrivate(title, m.cwd)) { hidden.add(id); continue; }
    if (hidden.has(id) || threads.has(id) || !madeBy.has(id)) continue;
    threads.set(id, { id, title, cwd: m.cwd, archived: !!m.archived, at: m.at, recap: "", cli: true, ...(m.client ? { client: m.client, native: true } : {}), ...(codexChildren.has(id) ? { clis: codexChildren.get(id) } : {}) });
  }
  // A post that names its session, when no transcript here knows that session (work brought in
  // from elsewhere, the demo), brings the session's name with it.
  const visiblePosts = posts.filter((p) => {
    const owner = postThread.get(p.id);
    const t = threads.get(owner);
    return !hidden.has(owner) && !P.isPrivate(p.caption, p.cwd, p.topic, p.page?.title, p.sessionTitle, t?.title, t?.cwd);
  });
  for (const p of visiblePosts) {
    const id = postThread.get(p.id);
    if (!id) continue;
    const t = threads.get(id);
    if (!t && previousThreads.get(id)?.native) threads.set(id, { ...previousThreads.get(id), gone: true });
    else if (!p.sessionTitle) continue;
    else if (!t) threads.set(id, { id, title: p.sessionTitle, cwd: p.cwd || "", archived: false, at: p.at, recap: "", cli: true, ...(p.client ? { client: p.client } : {}) });
    else if (t.cli) {
      if (!t.native && !cliMeta.has(id) && p.at >= t.at) t.title = p.sessionTitle;
      if (!t.client && p.client) t.client = p.client;
      t.at = Math.max(t.at, p.at);
    }
  }
  // sends from a session that turned out private, or unknown, leave the canvas
  for (let i = sets.length - 1; i >= 0; i--) {
    const t = sets[i].thread;
    if (t && !threads.has(t)) { const m = cliMeta.get(t); if (!m || P.isPrivate(m.title, m.cwd, m.summary)) sets.splice(i, 1); else sets[i].thread = null; }
  }

  // Posts made through the MCP server (screens, pages, pushed changes), and pushes the git hook
  // recorded on its own.
  readPosts(visiblePosts, P, threads, postThread, pages, sets);

  const out = [];
  for (const page of pages.values()) {
    page.versions.sort((a, b) => a.at - b.at);
    for (const v of page.versions) if (v.text == null && v.hash) try { v.text = fs.readFileSync(path.join(STORE, `${v.hash}.html`), "utf8"); } catch {}
    // The newest publish falls back to the file on disk when the transcript can't rebuild it.
    const last = page.versions[page.versions.length - 1];
    if (last.text == null && page.filePath) {
      try { last.text = fs.readFileSync(page.filePath, "utf8"); } catch {}
    }
    const versions = [];
    for (const v of page.versions) {
      if (v.text == null) continue;
      const hash = sha(v.text);
      const previousVersion = versions.at(-1);
      if (previousVersion?.hash === hash && (!page.posted || previousVersion.thread === v.thread)) {
        if (page.posted) Object.assign(versions.at(-1), { thread: v.thread, at: v.at });
        continue;
      }
      const dest = path.join(STORE, `${hash}.html`);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, v.text);
      versions.push({ at: v.at, hash, ...(page.posted ? { thread: v.thread } : {}) });
    }
    if (!versions.length) continue;
    const latestText = fs.readFileSync(path.join(STORE, `${versions[versions.length - 1].hash}.html`), "utf8");
    const thread = page.thread ? threads.get(page.thread) : null;
    const title = page.title || titleOf(latestText) || (page.filePath && path.basename(page.filePath, path.extname(page.filePath))) || "Page";
    if (P.isPrivate(title, page.filePath, thread?.title, thread?.cwd)) continue;
    if (page.thread && !thread) page.thread = null;
    out.push({
      id: page.id,
      url: page.url,
      title,
      thread: page.thread,
      project: page.project || P.of([title, page.filePath, thread?.title], thread?.cwd || page.cwd),
      at: versions[versions.length - 1].at,
      dir: page.filePath ? path.dirname(page.filePath) : "",
      ...(page.posted ? { posted: true } : {}),
      ...(page.topic ? { topic: page.topic } : {}),
      versions,
    });
  }

  const threadList = [...threads.values()].map((t) => ({ ...t, project: P.of([t.title], t.cwd), days: days.get(t.id) || {} }));
  sets.sort((a, b) => a.at - b.at);
  // every folder a session ran in, made something or not: where a first launch looks for pushes
  const folders = [...new Set([...cliMeta.values(), ...threads.values()].map((m) => m.cwd).filter((c) => c && !P.isPrivate(c)))];
  const changed = keepEdits(edits, threads, P, hidden, privateEdits);
  try { fs.writeFileSync(AGENTS, JSON.stringify(agentsNow)); } catch {}
  const index = { scanStartedAt, builtAt: Date.now(), projects: Object.fromEntries(P.names), threads: threadList, pages: out, sets, folders, changed };
  const kept = keepSeen(index, P, hidden, previous);
  if (kept) log(`${kept} kept from earlier: their transcripts are gone`);
  filePostTopics(index); // a post that named its topic is filed under it now
  const sessions = [...hidden];
  const privateReasons = Object.fromEntries(sessions.map((id) => [id, reasons.get(id) || [...patterns.keys()]]));
  const owners = [...postThread].filter(([, owner]) => hidden.has(owner));
  const tmp = privateHistoryFile + "." + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify({ rules, reasons: privateReasons, sessions, owners }), { mode: 0o600 });
  fs.renameSync(tmp, privateHistoryFile);
  fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify(index));
  log(`${out.length} pages, ${out.reduce((n, p) => n + p.versions.length, 0)} versions, ${sets.length} sets, ${sets.reduce((n, s) => n + s.shots.length, 0)} screens`);
  return index;
}
