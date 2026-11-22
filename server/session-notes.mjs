// A pin belongs to the post or page version the user pinned. Older pins sometimes have
// only a content hash. Deliver those only when the matching work agrees on its owner.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA, POSTS, projects } from "./config.mjs";

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

const screenKey = hash => "shot/" + hash;
const pageKey = (page, hash) => "page/" + page + "/" + hash;
const targetKey = c => !c.page || c.set || c.page.startsWith("shot-") ? screenKey(c.hash) : pageKey(c.page, c.hash);

export function myNotes({ cwd, session, contentOnly }, comments = read(path.join(DATA, "comments.json"), [])) {
  if (!comments.length) return [];
  const index = read(path.join(DATA, "index.json"), {});
  const history = read(path.join(DATA, "private-history.json"), {});
  const P = projects();
  const hidden = new Set(history.sessions);
  const hiddenPosts = new Map(history.owners);
  const threads = new Map();
  for (const t of index.threads || []) {
    for (const id of [t.id, ...(t.clis || [])]) {
      threads.set(id, t);
      if (P.isPrivate(t.title, t.cwd)) hidden.add(id);
    }
  }
  const canonical = id => threads.get(id)?.id || id || null;
  const owner = canonical(session);
  if (owner && (hidden.has(session) || hidden.has(owner))) return [];
  const targets = new Map(comments.map(c => [targetKey(c), []]));
  function add(key, post, id, hiddenPost = false) {
    const candidates = targets.get(key);
    if (candidates) candidates.push({ post, owner: canonical(id), hidden: hiddenPost || hidden.has(id) || hidden.has(canonical(id)) });
  }

  // A file dropped on the canvas has no session. It still participates in disambiguating
  // old hash-only pins if a session happened to post the same bytes.
  const added = read(path.join(DATA, "added.json"), {});
  const sets = new Map([...(index.sets || []), ...(added.sets || [])].map(s => [s.id, s]));
  const pages = new Map([...(index.pages || []), ...(added.pages || [])].map(p => [p.id, p]));
  const posted = new Set();
  const postedPages = new Set();
  for (const file of fs.existsSync(POSTS) ? fs.readdirSync(POSTS) : []) {
    if (!file.endsWith(".json")) continue;
    const p = read(path.join(POSTS, file), null);
    if (!p) continue;
    posted.add(p.id);
    const invisible = hiddenPosts.has(p.id) || P.isPrivate(p.caption, p.cwd, p.topic, p.sessionTitle, p.page?.title);
    for (const shot of p.shots || []) add(screenKey(shot.hash), p, p.session || sets.get(p.id)?.thread, invisible);
    if (p.page) {
      const id = "post-" + p.page.key;
      const key = pageKey(id, p.page.hash);
      if (!targets.has(key)) continue;
      postedPages.add(key);
      const page = pages.get(id);
      const version = page?.versions.findLast(v => v.hash === p.page.hash && v.at <= p.at);
      const source = version && (version.thread === undefined ? page.thread : version.thread);
      add(key, p, p.session || source, invisible);
    }
  }
  for (const s of sets.values()) {
    if (posted.has(s.id)) continue;
    const invisible = P.isPrivate(s.caption, s.topic, s.cwd);
    for (const shot of s.shots || []) add(screenKey(shot.hash), s, s.thread, invisible);
  }
  for (const p of pages.values()) {
    const invisible = P.isPrivate(p.title, p.topic, p.cwd);
    for (const v of p.versions) {
      const key = pageKey(p.id, v.hash);
      // Raw posts preserve finer attribution than the collapsed, indexed versions of posted pages.
      if (!targets.has(key) || postedPages.has(key)) continue;
      add(key, { ...p, caption: p.title }, v.thread === undefined ? p.thread : v.thread, invisible);
    }
  }

  // Old Claude Code servers only know their folder until a tool hook binds the first post.
  const roots = new Map();
  function repo(dir) {
    if (!dir) return null;
    if (!roots.has(dir)) {
      try { roots.set(dir, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
      catch { roots.set(dir, dir); }
    }
    return roots.get(dir);
  }
  const notes = [];
  for (const c of comments) {
    if (hidden.has(c.thread) || (contentOnly && c.thread !== session)) continue;
    let matches = targets.get(targetKey(c));
    if (c.set) matches = matches.filter(m => m.post.id === c.set);
    if (c.thread) matches = matches.filter(m => m.owner === canonical(c.thread));
    else if (new Set(matches.map(m => m.owner)).size > 1) continue;
    if (!matches.length || matches.some(m => m.hidden)) continue;
    const match = matches.find(m => {
      if (contentOnly) return m.post.client === "chatgpt" && m.post.session === session;
      if (owner) return m.owner === owner;
      const thread = threads.get(m.owner);
      const client = m.post.client || thread?.client;
      return (!client || client === "claude") && repo(m.post.cwd || thread?.cwd) === repo(cwd);
    });
    if (match) notes.push({ c, post: match.post });
  }
  return notes.sort((a, b) => b.c.at - a.c.at);
}
