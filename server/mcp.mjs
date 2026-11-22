#!/usr/bin/env node
// Local MCP over JSON-RPC/stdio. Clients can share a server or launch one per session.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { DATA, STORE, IMG, POSTS, loadConfig, projects } from "./config.mjs";
import { keepImage } from "./indexer.mjs";

import { updateComments } from "./comments-store.mjs";

const remote = process.argv.includes("--content-only") ? await import("./remote-content.mjs") : null;
const clientFlag = process.argv.indexOf("--client");
const configuredClient = clientFlag === -1 ? process.argv.find(arg => arg.startsWith("--client="))?.slice(9) : process.argv[clientFlag + 1];
let clientName = "";
const cfg = loadConfig();
const COMMENTS = path.join(DATA, "comments.json");
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const resolve = (p, cwd) => (p.startsWith("~") ? path.join(process.env.HOME || "", p.slice(1)) : path.resolve(cwd, p));

const INSTRUCTIONS = `Rounds is the user's canvas of everything their sessions make. Post to it whenever you
finish visual work worth looking at: screens you built or changed, a page you published, a before and after.
Name a topic for each post: the line of work it belongs to, in plain words, two to five of them, reusing a
topic you or another session already used when it's the same work. Write captions the way you'd tell a
person what changed and why.

Call rounds_notes when you resume work to check for notes. Clients with a notes hook can also receive
notes on the user's next message. Treat a note as a request from the user about that screen, act on it, then answer with
rounds_reply.`;

const identity = {
  session_id: { type: "string", description: "Your stable conversation ID. Codex and Claude Code normally supply it automatically. Other clients should choose a unique ID for this chat and reuse it on every call." },
  cwd: { type: "string", description: "Absolute local project directory when the server runs outside your project. Relative artifact paths and Git ranges are resolved here." },
};
const sessionTitle = { type: "string", description: "Optional readable name for this conversation on the canvas." };

const TOOLS = [
  {
    name: "rounds_post",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Put screens (image files) or a page (an HTML file) on the user's Rounds canvas, with a caption and a topic. Post the same HTML path again later and the canvas shows a before and after.",
    inputSchema: {
      type: "object",
      properties: {
        ...identity, session_title: sessionTitle,
        caption: { type: "string", description: "What this shows and what changed, in a sentence or two of plain words." },
        topic: { type: "string", description: "The line of work this belongs to, two to five plain words, e.g. \"Swipe-up card\". Reuse an existing topic for the same work." },
        images: { type: "array", items: { type: "string" }, description: "Image files (png, jpg, webp), absolute or relative to the project." },
        page: { type: "string", description: "An HTML file to show as a page." },
        before: { type: "array", items: { type: "string" }, description: "Optional before images, one per image in the same order, for a before and after." },
        replaces: { type: "string", description: "Optional id of an earlier post these screens supersede; its screens become the before." },
      },
      required: ["caption", "topic"],
    },
  },
  {
    name: "rounds_change",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Record a change you pushed to the main branch: the commits, a plain summary, and after screens of what it touched (with before screens when you have them). Call it after a push to main.",
    inputSchema: {
      type: "object",
      properties: {
        ...identity, session_title: sessionTitle,
        summary: { type: "string", description: "What changed for the person using it, in a sentence or two." },
        range: { type: "string", description: "The pushed commit range, e.g. \"a1b2c3d..e4f5a6b\"." },
        after: { type: "array", items: { type: "string" }, description: "Screens of what the change touched, as it is now." },
        before: { type: "array", items: { type: "string" }, description: "The same screens before the change, in the same order." },
        topic: { type: "string", description: "The line of work this belongs to; defaults to Changes." },
      },
      required: ["summary"],
    },
  },
  {
    name: "rounds_notes",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: "The notes the user pinned on this session’s work, newest first, each with its screen and the point they pinned.",
    inputSchema: { type: "object", properties: { ...identity, all: { type: "boolean", description: "Include notes already answered." } } },
  },
  {
    name: "rounds_reply",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: "Answer a note once you've acted on it: one or two plain sentences on what you changed. The reply shows on the user's pin.",
    inputSchema: { type: "object", properties: { ...identity, id: { type: "string" }, reply: { type: "string" } }, required: ["id", "reply"] },
  },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

function keep(files = [], cwd) {
  fs.mkdirSync(IMG, { recursive: true });
  const out = [], missing = [];
  for (const f of files) {
    const p = resolve(String(f), cwd);
    const m = fs.existsSync(p) ? keepImage(p) : null;
    if (m) out.push(m); else missing.push(f);
  }
  return { out, missing };
}

function save(post) {
  if (!post.session) madeHere.add(post.id);
  fs.mkdirSync(POSTS, { recursive: true });
  const file = path.join(POSTS, `${post.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(post, null, 1));
  fs.renameSync(tmp, file);
  // let a running canvas know there is something new (it reads posts as they land)
  fs.writeFileSync(path.join(DATA, "posted"), String(Date.now()));
}

const link = (id) => `http://localhost:${process.env.ROUNDS_PORT || cfg.port}/#${id}`;
function projectName(post) {
  const P = projects(loadConfig());
  const owner = post.session && readJSON(path.join(DATA, "index.json"), {}).threads?.find(t => t.id === post.session || t.clis?.includes(post.session));
  const key = P.of([owner?.title || post.sessionTitle || post.caption], owner?.cwd || post.cwd);
  return P.names.get(key) || key;
}

function commitsOf(range, cwd) {
  if (!range) return [];
  try {
    return execFileSync("git", ["log", "-n", "50", "--format=%h%x09%s", "--end-of-options", range, "--"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean).map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha, subject: rest.join("\t") };
    });
  } catch { return []; }
}

// The session this server works for, learned from its own posts (the tool hook writes the
// session onto each post right after it is made).
const madeHere = new Set();
const mySession = () => { for (const id of madeHere) { const p = readJSON(path.join(POSTS, `${id}.json`), null); if (p?.session) return p.session; } return null; };

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

function localContext(a, meta = {}, requestClient = clientName) {
  const cwd = a.cwd ?? process.cwd();
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("cwd must be an absolute local project directory.");
  const client = configuredClient || requestClient;
  let turn = meta["x-codex-turn-metadata"];
  if (typeof turn === "string") { try { turn = JSON.parse(turn); } catch { turn = null; } }
  const isCodex = configuredClient !== "generic" && (/codex/i.test(client) || !!turn);
  const native = isCodex ? meta.threadId || turn?.thread_id || process.env.CODEX_THREAD_ID : null;
  const raw = native || a.session_id;
  if (raw != null && (typeof raw !== "string" || !raw.trim() || raw.length > 512)) throw new Error("Use a nonempty session_id of at most 512 characters.");
  const claude = !isCodex && (/claude/i.test(client) || !client);
  const sessionTitle = typeof a.session_title === "string" ? a.session_title.trim().slice(0, 200) : "";
  if (isCodex) {
    if (!uuid.test(raw)) throw new Error("Supply the Codex thread UUID from CODEX_THREAD_ID as session_id.");
    return { cwd, client: "codex", session: `codex-${raw.toLowerCase()}`, sessionTitle: sessionTitle || "Codex session" };
  }
  if (claude) {
    if (raw && !uuid.test(raw)) throw new Error("Use the Claude Code session UUID or omit session_id to let the hook identify it.");
    const session = raw || process.env.CLAUDE_CODE_SESSION_ID || mySession();
    return { cwd, client: "claude", session, sessionTitle };
  }
  if (!raw) throw new Error("Supply a stable session_id for this conversation. Reuse it on all Rounds calls.");
  return { cwd, client: "mcp", session: `mcp-${sha(JSON.stringify([requestClient || "mcp", raw]))}`, sessionTitle: sessionTitle || raw };
}

function threadOwners(session, index) {
  const ids = new Set(session ? [session] : []);
  for (const t of index.threads || []) {
    if (t.id === session || t.clis?.includes(session)) {
      ids.add(t.id);
      for (const cli of t.clis || []) ids.add(cli);
    }
  }
  return ids;
}

function myNotes({ cwd, session, contentOnly }) {
  const posts = fs.existsSync(POSTS) ? fs.readdirSync(POSTS).filter(f => f.endsWith(".json")).map(f => readJSON(path.join(POSTS, f), null)).filter(Boolean) : [];
  const index = readJSON(path.join(DATA, "index.json"), {});
  const ids = threadOwners(session, index);
  // Older Claude setups learn the session from a hook after the first post.
  const repo = (d) => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return d; } };
  const here = session ? null : repo(cwd);
  const mine = posts.filter(p => session ? ids.has(p.session) : (!p.client || p.client === "claude") && p.cwd && repo(p.cwd) === here);
  if (!session) {
    for (const p of mine) if (p.session) for (const id of threadOwners(p.session, index)) ids.add(id);
    for (const t of index.threads || []) {
      if (t.cwd && (!t.client || t.client === "claude") && repo(t.cwd) === here) ids.add(t.id);
    }
  }
  const notes = [];
  for (const c of readJSON(COMMENTS, [])) {
    if (c.thread && !ids.has(c.thread)) continue;
    if (contentOnly && c.thread !== session) continue;
    const pagePin = !String(c.page || "").startsWith("shot-");
    const post = mine.find(p => pagePin
      ? p.page && c.page === `post-${p.page.key}` && c.hash === p.page.hash
      : (!c.set || p.id === c.set) && p.shots?.some(s => s.hash === c.hash));
    if (post) { notes.push({ c, post }); continue; }
    // Screens and pages originally discovered in a native transcript may have no MCP post.
    if (contentOnly || !c.thread) continue;
    const item = pagePin ? index.pages?.find(p => p.id === c.page && p.versions.some(v => v.hash === c.hash))
      : index.sets?.find(s => s.thread === c.thread && (!c.set || s.id === c.set) && s.shots?.some(sh => sh.hash === c.hash));
    const owner = pagePin ? item?.versions.find(v => v.hash === c.hash)?.thread || item?.thread : item?.thread;
    if (item && ids.has(owner)) notes.push({ c, post: { ...item, caption: item.caption || item.title } });
  }
  return notes.sort((a, b) => b.c.at - a.c.at);
}

function markRead(notes, session) {
  const sent = path.join(DATA, "sent");
  fs.mkdirSync(sent, { recursive: true });
  for (const { c } of notes) {
    if (c.reply || !/^[\w-]+$/.test(c.id)) continue;
    try {
      fs.writeFileSync(path.join(sent, `${c.id}.json`), JSON.stringify({ delivery: "mcp", session, at: Date.now() }), { flag: "wx" });
    } catch (err) { if (err.code !== "EEXIST") throw err; }
  }
}

function describe({ c, post }, contentOnly) {
  const shot = (post.shots || []).find((s) => s.hash === c.hash);
  const lines = [
    `Note ${c.id}${c.reply ? " (answered)" : ""}: ${c.text}`,
    `On: "${post.caption}"${post.topic ? ` (topic: ${post.topic})` : ""}`,
    shot ? `The screen: ${contentOnly ? "posted image" : path.join(STORE, "img", `${shot.hash}.${shot.ext}`)} (${shot.w}x${shot.h}), pinned at x ${Math.round(c.x * shot.w)}, y ${Math.round(c.y * shot.h)}` : `The page: ${contentOnly ? post.page?.title || post.caption : path.join(STORE, `${c.hash}.html`)}, pinned at x ${Math.round(c.x)}, y ${Math.round(c.y)} on the page at 1280 wide`,
    c.reply ? `You replied: ${c.reply.text}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

async function call(name, a, context) {
  const { cwd, session, sessionTitle, client, contentOnly, inlinePage } = context;
  const attribution = session ? { session, ...(sessionTitle && { sessionTitle }), client } : {};
  if ((name === "rounds_post" || name === "rounds_change") && a.before?.length && a.before.length !== (name === "rounds_post" ? a.images : a.after)?.length) {
    return text("Give one before image for each after image, in the same order.", true);
  }
  if (name === "rounds_post") {
    const caption = String(a.caption || "").trim(), topic = String(a.topic || "").trim();
    if (!caption || !topic) return text("A post needs a caption and a topic.", true);
    if (!a.images?.length && !a.page && !inlinePage) return text("Give images or a page to post.", true);
    const { out: shots, missing } = keep(a.images, cwd);
    const { out: before, missing: missingBefore } = keep(a.before, cwd);
    missing.push(...missingBefore);
    if (missing.length) return text(contentOnly ? "An inline image could not be read." : `These images couldn't be read: ${missing.join(", ")}.`, true);
    let page = null;
    if (a.page || inlinePage) {
      const p = inlinePage ? "" : resolve(String(a.page), cwd);
      if (!inlinePage && !fs.existsSync(p)) return text(`There is no page at ${a.page}.`, true);
      const html = inlinePage ? inlinePage.html : fs.readFileSync(p, "utf8");
      const hash = sha(html);
      fs.mkdirSync(STORE, { recursive: true });
      fs.writeFileSync(path.join(STORE, `${hash}.html`), html);
      page = { key: inlinePage?.key || sha(p), hash, path: p, title: inlinePage?.title || html.match(/<title>([^<]{1,120})<\/title>/i)?.[1]?.trim() || path.basename(p, path.extname(p)) };
    }
    const post = { id: sha(crypto.randomUUID()), ...attribution, kind: page ? "page" : "screens", caption, topic, cwd, at: Date.now(), shots, ...(before.length ? { before } : {}), ...(page ? { page } : {}), ...(a.replaces ? { replaces: String(a.replaces) } : {}) };
    save(post);
    const what = page ? `the page "${page.title}"` : `${shots.length} screen${shots.length === 1 ? "" : "s"}`;
    return text(`Saved to Rounds as post ${post.id}: ${what}${contentOnly ? "" : `, under ${projectName(post)}`}, topic "${topic}"${before.length ? ", with its before" : ""}. ${link(page && !shots.length ? `page-post-${page.key}` : post.id)}`);
  }
  if (name === "rounds_change") {
    const summary = String(a.summary || "").trim();
    if (!summary) return text("A change needs a summary.", true);
    const { out: shots, missing } = keep(a.after, cwd);
    const { out: before, missing: missingBefore } = keep(a.before, cwd);
    missing.push(...missingBefore);
    if (missing.length) return text(contentOnly ? "An inline image could not be read." : `These images couldn't be read: ${missing.join(", ")}.`, true);
    const range = a.range ? String(a.range) : "";
    const post = { id: sha(crypto.randomUUID()), ...attribution, kind: "change", caption: summary, topic: String(a.topic || "Changes").trim(), cwd, at: Date.now(), shots, ...(before.length ? { before } : {}), range, commits: contentOnly ? [] : commitsOf(range, cwd) };
    save(post);
    return text(`Recorded the change to Rounds as post ${post.id}: ${post.commits.length} commit${post.commits.length === 1 ? "" : "s"}, ${shots.length} screen${shots.length === 1 ? "" : "s"}${before.length ? (shots.length === 1 ? " with its before" : " with their before") : ""}. ${link(post.id)}`);
  }
  if (name === "rounds_notes") {
    const notes = myNotes(context).filter((x) => a.all || !x.c.reply);
    if (!notes.length) return text("No notes waiting.");
    if (session) markRead(notes, session);
    return text(notes.map(note => describe(note, contentOnly)).join("\n\n"));
  }
  if (name === "rounds_reply") {
    const reply = String(a.reply || "").trim();
    if (!reply) return text("The reply is empty.", true);
    const id = String(a.id);
    if (!myNotes(context).some(({ c }) => c.id === id)) return text(`There is no note ${id} for this session.`, true);
    return updateComments(comments => {
      const c = comments.find(x => x.id === id);
      if (!c) return text(`There is no note ${id}.`, true);
      c.reply = { text: reply, at: Date.now() };
      return text(`Your reply is on note ${c.id}.`);
    });
  }
  return text(`Unknown tool ${name}.`, true);
}

const versionKey = "io.modelcontextprotocol/protocolVersion";
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const infoKey = "io.modelcontextprotocol/clientInfo";
const modernVersion = "2026-07-28";
const handshakeVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const versions = [modernVersion, ...handshakeVersions];
const serverInfo = { name: "rounds", version: readJSON(new URL("../package.json", import.meta.url), {}).version || "1.2.0" };
const capabilities = { tools: {} };
const instructions = remote ? "Post inline images or page_html to Rounds. Keep the private session_key returned by your first successful post or change and reuse it on subsequent calls in this conversation. Call rounds_notes to check for pins, then rounds_reply after acting on them." : INSTRUCTIONS;

function rpcError(code, message, data) {
  return Object.assign(new Error(message), { code, data });
}

async function handle({ method, params = {} }, modern) {
  if (method === "server/discover") return { supportedVersions: versions, capabilities, instructions };
  if (method === "initialize" && !modern) {
    clientName = String(params.clientInfo?.name || "");
    const protocolVersion = handshakeVersions.includes(params.protocolVersion) ? params.protocolVersion : handshakeVersions[0];
    return { protocolVersion, capabilities, serverInfo, instructions };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: remote ? remote.contentTools(TOOLS) : TOOLS };
  if (method === "tools/call") {
    if (!TOOLS.some(t => t.name === params.name)) throw rpcError(-32602, "Unknown tool.");
    try {
      const a = params.arguments || {};
      if (remote) return await remote.callContent(params.name, a, call);
      const requestClient = modern ? params._meta[infoKey]?.name || "mcp" : clientName;
      return await call(params.name, a, localContext(a, params._meta, requestClient));
    } catch (err) { return text(remote ? "Rounds couldn't complete this call." : err.message, true); }
  }
  throw rpcError(-32601, `Method not found: ${method}`);
}

async function respond(msg) {
  const id = msg?.id ?? null;
  try {
    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") throw rpcError(-32600, "Invalid request");
    if (msg.id === undefined) return; // a notification
    const meta = msg.params?._meta || {};
    const modern = versionKey in meta || msg.method === "server/discover";
    if (modern) {
      if (typeof meta[versionKey] !== "string" || !meta[capabilitiesKey] || typeof meta[capabilitiesKey] !== "object" || Array.isArray(meta[capabilitiesKey])) {
        throw rpcError(-32602, "Missing or invalid per-request MCP metadata.");
      }
      if (meta[versionKey] !== modernVersion) throw rpcError(-32022, "Unsupported protocol version", { supported: versions, requested: meta[versionKey] });
    }
    const result = await handle(msg, modern);
    if (modern) Object.assign(result, { resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } });
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    return { jsonrpc: "2.0", id, error: { code: err.code || -32603, message: err.message, ...(err.data && { data: err.data }) } };
  }
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  if (Array.isArray(msg) && msg.length) {
    const replies = (await Promise.all(msg.map(respond))).filter(Boolean);
    if (replies.length) send(replies);
  } else {
    const reply = await respond(msg);
    if (reply) send(reply);
  }
});
