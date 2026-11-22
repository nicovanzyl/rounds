// The local API for Rounds, mounted into Vite's dev server: the index, page snapshots, rendered
// shots, and comments. With the relay on ("relay": true in config), a note on a desktop thread is
// written to the data folder's inbox; the relay session delivers it to its thread and writes
// sent/<id>.json beside it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { buildIndex, keepImage, hasSips, which, DATA, STORE, IMG } from "./indexer.mjs";
import { pastPushes, importPushes } from "./history.mjs";
import { applyMoves, fileTopics, filePostTopics, loadTopics } from "./topics.mjs";
import { POSTS, projects, loadConfig } from "./config.mjs";
import { SNAPSHOT_MARK } from "./remote-content.mjs";
import { updateComments } from "./comments-store.mjs";
import { watchReleases, versionState, runUpdate, handOver } from "./updates.mjs";

const SHOTS = path.join(DATA, "shots");
const SIZED = path.join(DATA, "sized");
const INBOX = path.join(DATA, "inbox");
const SENT = path.join(DATA, "sent");
const COMMENTS = path.join(DATA, "comments.json");
// What he drops onto the canvas himself, kept apart from what the indexer finds.
const ADDED = path.join(DATA, "added.json");
const DROPS = path.join(DATA, "drops");
for (const d of [SHOTS, INBOX, SENT, STORE, IMG, SIZED, DROPS]) fs.mkdirSync(d, { recursive: true });

const PORT = process.env.ROUNDS_PORT || process.env.WORKBENCH_PORT || loadConfig().port || 4797;

// Page previews (thumbnails and full shots) are drawn by a Chromium browser, found once: the one
// the environment names (ROUNDS_BROWSER=none turns previews off), else the usual places. With
// none, pages still open live in the viewer; only their previews go.
const MAC_BROWSERS = ["Google Chrome", "Google Chrome Canary", "Chromium", "Microsoft Edge", "Brave Browser"];
const PATH_BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser", "brave"];
const runnable = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
const NO_BROWSER = "No Chrome found, so page previews are off. Set ROUNDS_BROWSER to a Chromium browser to turn them on.";
function findBrowser() {
  const tried = new Set(); // config.mjs sets ROUNDS_ and WORKBENCH_ alike: each value once
  for (const key of ["ROUNDS_BROWSER", "WORKBENCH_BROWSER", "CHROME_PATH"]) {
    const v = process.env[key]?.trim();
    if (!v || tried.has(v)) continue;
    tried.add(v);
    if (v.toLowerCase() === "none") { console.log(`[rounds] ${key} is none, so page previews are off.`); return null; }
    const f = /[\\/]/.test(v) ? (runnable(v) ? v : null) : which(v);
    if (f) return f;
    console.log(`[rounds] ${key} is ${v}, which isn't a browser this machine can run; looking in the usual places.`);
  }
  if (process.platform === "darwin") {
    for (const dir of ["/Applications", path.join(os.homedir(), "Applications")]) {
      for (const n of MAC_BROWSERS) { const f = path.join(dir, `${n}.app`, "Contents", "MacOS", n); if (runnable(f)) return f; }
    }
  } else {
    for (const n of PATH_BROWSERS) { const f = which(n); if (f) return f; }
  }
  console.log(`[rounds] ${NO_BROWSER}`);
  return null;
}
let browserPath; // undefined until looked for, null when previews are off
const previews = () => (browserPath === undefined ? (browserPath = findBrowser()) : browserPath);

let browser = null;
let launching = null;
// The browser, started once and shared; null when previews are off. One that won't start turns
// previews off for this run, said once, instead of trying again for every page.
async function chrome() {
  if (browser?.isConnected()) return browser;
  if (!previews()) return null;
  launching ??= (async () => {
    try {
      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath: browserPath, args: ["--hide-scrollbars"], handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false });
      return browser;
    } catch (e) {
      console.log(`[rounds] ${browserPath} didn't start (${String(e?.message || e).split("\n")[0]}), so page previews are off. Set ROUNDS_BROWSER to a Chromium browser to turn them on.`);
      browserPath = null;
      return null;
    } finally { launching = null; }
  })();
  return launching;
}

// One render at a time per shot; a few at once overall.
const inflight = new Map();
let running = 0;
const queue = [];
const slot = () => new Promise((r) => (running < 3 ? (running++, r()) : queue.push(r)));
const release = () => { const n = queue.shift(); n ? n() : running--; };

// The drawn preview's file, or null when previews are off (shots drawn before still go out).
async function shoot(hash, full, thumb = false) {
  const file = path.join(SHOTS, `${hash}${full ? "-full" : ""}${thumb ? ".jpg" : ".png"}`);
  if (fs.existsSync(file)) return file;
  if (!previews()) return null;
  if (inflight.has(file)) return inflight.get(file);
  const job = (async () => {
    await slot();
    try {
      const b = await chrome();
      if (!b) return null;
      const page = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: thumb ? 0.5 : 1 });
      try {
        // some pages draw after load (fonts, a fade in, a canvas): wait for the network to
        // settle and give them a moment more
        await page.goto(`http://localhost:${PORT}/api/page/${hash}`, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1600);
        if (full) {
          const h = await page.evaluate(() => Math.min(document.documentElement.scrollHeight, 7200)).catch(() => 800);
          await page.setViewportSize({ width: 1280, height: Math.max(800, h) });
          await page.waitForTimeout(250);
        }
        await page.screenshot(thumb ? { path: file, type: "jpeg", quality: 84, animations: "disabled" } : { path: file, animations: "disabled" });
      } finally {
        await page.close();
      }
      return file;
    } finally {
      release();
      inflight.delete(file);
    }
  })();
  inflight.set(file, job);
  return job;
}

// A kept screen at a width the canvas can afford: macOS's own sips, cached once per size. With
// no sips (off macOS), or when it fails on a file, the original goes out instead.
const sizing = new Map();
function sized(hash, ext, w) {
  const src = path.join(IMG, `${hash}.${ext}`);
  const out = path.join(SIZED, `${hash}-${w}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!hasSips()) return Promise.resolve(src);
  if (sizing.has(out)) return sizing.get(out);
  const job = (async () => {
    await slot();
    try {
      await new Promise((ok, no) => execFile("sips", ["-Z", String(w), "-s", "format", "jpeg", "-s", "formatOptions", "84", src, "--out", out], (e) => (e ? no(e) : ok())));
      return out;
    } catch {
      return src;
    } finally { release(); sizing.delete(out); }
  })();
  sizing.set(out, job);
  return job;
}

// Files go out with byte ranges, which Safari needs before it will play a video.
function sendFile(req, res, f, type, cache = false) {
  const size = fs.statSync(f).size;
  res.setHeader("content-type", type);
  res.setHeader("accept-ranges", "bytes");
  if (cache) res.setHeader("cache-control", "max-age=31536000, immutable");
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (!m) { res.setHeader("content-length", size); return fs.createReadStream(f).pipe(res); }
  let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] !== "" && m[2] !== "" ? Number(m[2]) : size - 1;
  if (start >= size || start > end) { res.statusCode = 416; res.setHeader("content-range", `bytes */${size}`); return res.end(); }
  end = Math.min(end, size - 1);
  res.statusCode = 206;
  res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
  res.setHeader("content-length", end - start + 1);
  fs.createReadStream(f, { start, end }).pipe(res);
}

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

// A note goes to the thread that made the work. A desktop thread hears it through the relay (when on);
// any Claude Code session through its notes hook, with its next message. Work no session made
// keeps the note on the canvas, and the pin says so.
// The relay is opt-in ("relay": true in config); without it a desktop thread's note goes by the
// hook like any other.
function route(thread) {
  if (!thread) return "kept";
  if (thread.startsWith("mcp-") || thread.startsWith("codex-")) return "mcp";
  return thread.startsWith("local_") && loadConfig().relay ? "relay" : "hook";
}

// Every note with where it goes, said plainly on its pin. A note pinned before the canvas knew
// whose post it was finds its session once the tool hook has tied the post to it; the notes
// hook delivers those, so they go by the hook.
function comments(idx) {
  const list = readJSON(COMMENTS, []);
  idx ||= withLivePosts(readJSON(path.join(DATA, "index.json"), { pages: [], threads: [], sets: [] }));
  const threads = new Map((idx.threads || []).map((t) => [t.id, t]));
  const hidden = new Set(readJSON(path.join(DATA, "private-history.json"), {}).sessions || []);
  const added = readJSON(ADDED, { sets: [], pages: [] });
  const pages = new Set([...idx.pages, ...added.pages].map((p) => p.id));
  const sets = new Set([...idx.sets, ...added.sets].map((s) => s.id));
  const visible = list.filter((c) => !hidden.has(c.thread) && (c.set ? sets.has(c.set) : c.page.startsWith("shot-") || pages.has(c.page)));
  for (const c of visible) {
    if (!c.thread) {
      const page = idx.pages.find((x) => x.id === c.page);
      const madeBy = page?.versions.findLast((v) => v.hash === c.hash)?.thread || page?.thread
        || idx.sets.find((x) => (!c.set || x.id === c.set) && x.shots.some((s) => s.hash === c.hash))?.thread;
      if (madeBy) Object.assign(c, { thread: madeBy, state: "queued", route: route(madeBy) });
    }
    c.route ||= route(c.thread);
    c.threadTitle ||= threads.get(c.thread)?.title || null;
    // a note still waiting when its session left this Mac will never be heard: it stays here
    if (c.state === "queued" && threads.get(c.thread)?.gone) { c.state = "kept"; c.route = "kept"; }
    if (c.state === "sent") continue;
    const s = readJSON(path.join(SENT, `${c.id}.json`), null);
    if (s) Object.assign(c, { state: "sent", delivery: s.delivery || "delivered" });
  }
  return visible;
}

// Posts that landed since the last index show at once; the next index ties them to their thread.
function withLivePosts(idx) {
  let posts = [];
  try { posts = fs.readdirSync(POSTS).filter((f) => f.endsWith(".json")).map((f) => readJSON(path.join(POSTS, f), null)).filter(Boolean).sort((a, b) => a.at - b.at); } catch {}
  if (!posts.length) return idx;
  const P = projects();
  const byId = new Map(posts.map((p) => [p.id, p]));
  const sets = new Map(idx.sets.map((s) => [s.id, s]));
  const latestAt = new Map(idx.pages.map((p) => [p.id, p.at]));
  const hidden = new Set(readJSON(path.join(DATA, "private-history.json"), {}).sessions || []);
  // the session a post was made in (the tool hook records it): its desktop thread, or itself
  const threadOf = (s) => (s && (idx.threads.find((t) => t.id === s || (t.clis || []).includes(s))?.id || s)) || null;
  for (const s of idx.sets) {
    const session = byId.get(s.id)?.session;
    if (!s.thread && session && !hidden.has(session)) s.thread = threadOf(session);
  }
  for (const p of posts) {
    // what the config keeps private stays off the canvas, posted or not (the indexer skips it too)
    if (p.at < (idx.scanStartedAt ?? idx.builtAt) || hidden.has(p.session) || P.isPrivate(p.caption, p.cwd, p.topic, p.sessionTitle, p.page?.title)) continue;
    const thread = threadOf(p.session);
    let owner = thread && idx.threads.find((t) => t.id === thread);
    if (P.isPrivate(owner?.title, owner?.cwd)) continue;
    const project = owner ? owner.project : P.of([p.sessionTitle || p.caption], p.cwd);
    if (!owner && thread && p.sessionTitle) {
      owner = { id: thread, title: p.sessionTitle, cwd: p.cwd || "", archived: false, at: p.at, recap: "", project, cli: true, days: {}, client: p.client };
      idx.threads.push(owner);
    }
    if ((p.shots?.length || p.kind === "change") && !sets.has(p.id)) {
      const before = p.before?.length ? p.before : sets.get(p.replaces)?.shots || [];
      const set = { id: p.id, thread, project, at: p.at, caption: p.caption, topic: p.topic, kind: p.kind, shots: p.shots || [], ...(before.length ? { before } : {}), ...(p.commits ? { commits: p.commits } : {}) };
      idx.sets.push(set);
      sets.set(set.id, set);
    }
    if (p.page) {
      const id = `post-${p.page.key}`;
      if ((latestAt.get(id) ?? -1) >= p.at) continue;
      let pg = idx.pages.find((x) => x.id === id);
      if (!pg) idx.pages.push((pg = { id, url: "", project, dir: p.page.path ? path.dirname(p.page.path) : null, versions: [], posted: true }));
      if (pg.versions.at(-1)?.hash !== p.page.hash) pg.versions.push({ at: p.at, hash: p.page.hash, thread });
      else pg.versions.at(-1).thread = thread;
      pg.title = p.page.title;
      pg.thread = thread;
      pg.at = p.at;
      if (p.topic) pg.topic = p.topic;
    }
  }
  idx.projects = { ...idx.projects, ...Object.fromEntries(P.names) };
  filePostTopics(idx);
  return idx;
}

let indexing = null;
let history = null; // what the first launch can bring in, found once
let filing = null;
function reindex() {
  indexing ??= buildIndex().then((idx) => { fileInBackground(idx); warm(); return idx; }).finally(() => (indexing = null));
  return indexing;
}
// Make the small sizes of every recent screen ahead of time, so the canvas never waits on
// sips for the first view. Runs at start and after each index, a few at a time.
let warming = false;
async function warm() {
  if (warming) return;
  warming = true;
  previews(); // looked for at start, so a machine with no browser hears it once, up front
  try {
    const idx = readJSON(path.join(DATA, "index.json"), { sets: [] });
    const recent = (idx.sets || []).filter((s) => Date.now() - s.at < 45 * 864e5);
    for (const s of recent) for (const sh of s.shots) for (const w of [240, 480, 960]) {
      if (!fs.existsSync(path.join(SIZED, `${sh.hash}-${w}.jpg`))) await sized(sh.hash, sh.ext, w).catch(() => {});
    }
    // and recent pages, drawn ahead: each version's thumbnail, and the last two full height,
    // so a before and after opens at once
    for (const pg of (idx.pages || []).filter((x) => Date.now() - x.at < 45 * 864e5)) {
      const vs = pg.versions;
      for (const v of vs) await shoot(v.hash, false, true).catch(() => {});
      for (const v of vs.slice(-2)) await shoot(v.hash, true).catch(() => {});
    }
  } finally { warming = false; }
}
setTimeout(warm, 2000);
watchReleases();

// New sends get filed under topics after each index, when the command-line Claude can be
// reached; until then they show as their own sittings.
function fileInBackground(idx) {
  filing ??= fileTopics(idx).catch((e) => console.log(`[rounds] topics: ${e.message}`)).finally(() => (filing = null));
}

const body = (req) => new Promise((res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => res(s ? JSON.parse(s) : {})); });
const json = (res, v, code = 200) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };

// The API as plain middleware: the Vite plugin below uses it in development, and
// server/serve.mjs uses it to run the built canvas with no Vite at all.
// Only this machine, by its own name. A page on any website can send requests to localhost, and
// one that renames itself to a local address (DNS rebinding) could read the canvas; notes reach
// Claude sessions as the person's own words, so a forged one would be an instruction from a
// stranger. The API answers only requests addressed to a local host name, and changes only
// from pages it served itself (or from no page at all: the MCP server, scripts, curl).
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const fromHere = (req) => {
  if (!LOCAL.test(String(req.headers.host || ""))) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return LOCAL.test(new URL(origin).host); } catch { return false; }
};

export async function handle(req, res, next) {
        const url = new URL(req.url, "http://x");
        const p = url.pathname;
        if (!p.startsWith("/api/")) return next();
        if (!fromHere(req)) return json(res, { error: "only this machine" }, 403);
        try {
          if (p === "/api/index") {
            let idx = readJSON(path.join(DATA, "index.json"), null);
            if (!idx || url.searchParams.has("fresh")) idx = await reindex();
            else if (Date.now() - idx.builtAt > 10 * 60e3) reindex();
            withLivePosts(idx);
            const added = readJSON(ADDED, { sets: [], pages: [] });
            const topics = loadTopics();
            const all = applyMoves({ ...idx, sets: [...(idx.sets || []), ...added.sets] }, topics);
            // previews: whether page previews (and the page compare drawn from them) can be made here
            return json(res, { ...all, pages: [...idx.pages, ...added.pages], topics: topics.projects, comments: comments(idx), previews: !!previews() });
          }
          if (p === "/api/comments" && req.method === "GET") return json(res, comments());
          // one session's changes to one file, in order: /api/edits/<thread>?repo=…&file=…
          if (p.startsWith("/api/edits/")) {
            const thread = decodeURIComponent(p.slice("/api/edits/".length));
            if (!/^[\w-]+$/.test(thread)) return json(res, { error: "bad" }, 400);
            const all = readJSON(path.join(STORE, "edits", `${thread}.json`), {});
            return json(res, all[`${url.searchParams.get("repo")}\n${url.searchParams.get("file")}`] || []);
          }
          // An empty canvas offers the last 30 days of pushes to main from the repos the sessions
          // worked in (server/history.mjs); bringing them in writes push records and indexes again.
          if (p === "/api/history") {
            const idx = readJSON(path.join(DATA, "index.json"), null) || (await reindex());
            const P = projects();
            history ??= pastPushes([...(idx.folders || []), ...(idx.threads || []).map((t) => t.cwd)]).filter((x) => !P.isPrivate(x.repo));
            if (req.method === "GET") return json(res, { pushes: history.length, projects: new Set(history.map((x) => x.repo)).size });
            if (req.method !== "POST") return json(res, { error: "bad" }, 405);
            const added = importPushes(history, (x) => !P.isPrivate(x.repo, ...x.commits.map((c) => c.subject)));
            history = null;
            await reindex();
            return json(res, { added });
          }
          // cheap to ask every few seconds: when something was last posted or noted
          if (p === "/api/stamp") {
            const t = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
            // a note added or answered changes the list; one delivered adds a file to sent/
            return json(res, { posted: t(path.join(DATA, "posted")), comments: Math.max(t(COMMENTS), t(SENT)) });
          }
          // which version runs, and a newer one when GitHub has it; POST brings it in and starts
          // it, and the page reloads once the new one answers
          if (p === "/api/version" && req.method === "GET") return json(res, versionState());
          if (p === "/api/update" && req.method === "POST") {
            const r = await runUpdate();
            if (r.error) return json(res, { error: r.error }, 409);
            res.on("finish", () => handOver(r.root));
            return json(res, { version: r.version });
          }
          // A file dropped on the canvas: an image joins its project as a screen, an HTML file
          // as a page.
          if (p === "/api/drop" && req.method === "POST") {
            const d = await body(req);
            const name = String(d.name || "drop").replace(/[^\w.\- ]/g, "").slice(0, 80) || "drop";
            const buf = Buffer.from(String(d.data || "").replace(/^data:[^,]*,/, ""), "base64");
            if (!buf.length || buf.length > 40e6) return json(res, { error: "bad" }, 400);
            const project = String(d.project || "studio");
            const added = readJSON(ADDED, { sets: [], pages: [] });
            const at = Date.now();
            if (/\.(png|jpe?g|webp)$/i.test(name)) {
              const f = path.join(DROPS, `${at}-${name}`);
              fs.writeFileSync(f, buf);
              const m = keepImage(f);
              if (!m) return json(res, { error: "unreadable" }, 400);
              const caption = String(d.caption || name.replace(/\.[^.]+$/, ""));
              const last = added.sets[added.sets.length - 1];
              // several files dropped together are one set
              if (last && last.project === project && last.drop === d.drop) { last.shots.push(m); var addedKey = last.id; }
              else addedKey = undefined, added.sets.push({ id: crypto.createHash("sha1").update(`${at}${name}`).digest("hex").slice(0, 16), thread: null, project, at, caption, shots: [m], drop: d.drop });
            } else if (/\.html?$/i.test(name)) {
              const text = buf.toString("utf8");
              const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
              fs.writeFileSync(path.join(STORE, `${hash}.html`), text);
              const title = (text.match(/<title>([^<]{1,120})<\/title>/i)?.[1] || name.replace(/\.[^.]+$/, "")).trim();
              added.pages.push({ id: `local-${hash}`, url: "", title, thread: null, project, at, dir: null, versions: [{ at, hash }] });
            } else return json(res, { error: "unsupported" }, 400);
            fs.writeFileSync(ADDED, JSON.stringify(added));
            // what to find on the canvas: the set this image joined, or the new page
            const key = /\.(png|jpe?g|webp)$/i.test(name) ? (addedKey || added.sets[added.sets.length - 1].id) : `page-${added.pages[added.pages.length - 1].id}`;
            return json(res, { ok: true, key, at });
          }
          if (p === "/api/comments" && req.method === "POST") {
            const c = await body(req);
            // the canvas as it shows now: posts that just landed, tied to their sessions
            const idx = withLivePosts(readJSON(path.join(DATA, "index.json"), { pages: [], threads: [], sets: [] }));
            const added = readJSON(ADDED, { sets: [], pages: [] });
            idx.sets = [...idx.sets, ...added.sets];
            idx.pages = [...idx.pages, ...added.pages];
            // a pin on a screen goes to the thread that showed it to him
            if (typeof c.page === "string" && c.page.startsWith("shot-")) {
              const set = (idx.sets || []).find((x) => x.id === c.set && x.shots.some((s) => s.hash === c.hash))
                || (idx.sets || []).find((x) => x.shots.some((s) => s.hash === c.hash));
              const sh = set?.shots.find((s) => s.hash === c.hash);
              if (!set || !sh || !c.text?.trim()) return json(res, { error: "bad" }, 400);
              const thread = idx.threads.find((t) => t.id === set.thread);
              // a session no longer on this Mac can't hear it: the note stays on the canvas
              const to = thread?.gone ? null : set.thread;
              const comment = {
                id: crypto.randomUUID().slice(0, 8), page: c.page, set: set.id, hash: c.hash, x: c.x, y: c.y,
                text: c.text.trim(), at: Date.now(), thread: set.thread || null, state: to ? "queued" : "kept",
                route: route(to), threadTitle: thread?.title || null,
              };
              await updateComments((list) => list.push(comment));
              if (comment.route === "relay") {
                fs.writeFileSync(path.join(INBOX, `${comment.id}.json`), JSON.stringify({
                  ...comment,
                  kind: "screen",
                  caption: set.caption,
                  threadTitle: thread?.title,
                  shownAt: set.at,
                  image: path.join(IMG, `${sh.hash}.${sh.ext}`),
                  px: Math.round(c.x * sh.w), py: Math.round(c.y * sh.h), w: sh.w, h: sh.h,
                }, null, 1));
              }
              return json(res, comment);
            }
            const page = idx.pages.find((x) => x.id === c.page);
            if (!page?.versions.some((v) => v.hash === c.hash) || !c.text?.trim()) return json(res, { error: "bad" }, 400);
            const owner = page.versions.findLast((v) => v.hash === c.hash)?.thread || page.thread;
            const thread = idx.threads.find((t) => t.id === owner);
            const to = thread?.gone ? null : owner;
            const comment = {
              id: crypto.randomUUID().slice(0, 8),
              page: page.id,
              hash: c.hash,
              x: c.x, y: c.y,
              text: c.text.trim(),
              at: Date.now(),
              thread: owner || null,
              state: to ? "queued" : "kept",
              route: route(to),
              threadTitle: thread?.title || null,
            };
            await updateComments((list) => list.push(comment));
            if (comment.route === "relay") {
              fs.writeFileSync(path.join(INBOX, `${comment.id}.json`), JSON.stringify({
                ...comment,
                pageTitle: page.title,
                pageUrl: page.url,
                threadTitle: thread?.title,
                version: page.versions.findIndex((v) => v.hash === c.hash) + 1,
                versions: page.versions.length,
                snapshot: path.join(STORE, `${c.hash}.html`),
              }, null, 1));
            }
            return json(res, comment);
          }
          let m;
          if ((m = p.match(/^\/api\/page\/([0-9a-f]{16})$/))) {
            const f = path.join(STORE, `${m[1]}.html`);
            if (!fs.existsSync(f)) return json(res, { error: "missing" }, 404);
            const idx = readJSON(path.join(DATA, "index.json"), { pages: [] });
            const page = idx.pages.find((x) => x.versions.some((v) => v.hash === m[1]));
            let html = fs.readFileSync(f, "utf8");
            if (html.startsWith(SNAPSHOT_MARK)) {
              res.setHeader("Content-Security-Policy", "sandbox allow-same-origin; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'");
              res.setHeader("Referrer-Policy", "no-referrer");
            } else if (page?.dir && fs.existsSync(page.dir) && !/<base\s/i.test(html)) {
              const base = `<base href="/api/asset/${page.id}/">`;
              html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + base) : base + html;
            }
            res.setHeader("content-type", "text/html; charset=utf-8");
            return res.end(html);
          }
          if ((m = p.match(/^\/api\/asset\/([A-Za-z0-9-]+)\/(.+)$/))) {
            const idx = readJSON(path.join(DATA, "index.json"), { pages: [] });
            const page = idx.pages.find((x) => x.id === m[1]);
            if (!page?.dir) return json(res, { error: "missing" }, 404);
            const f = path.resolve(page.dir, decodeURIComponent(m[2]));
            if (!f.startsWith(path.resolve(page.dir) + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return json(res, { error: "missing" }, 404);
            const ext = path.extname(f).toLowerCase();
            const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mov": "video/quicktime", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".html": "text/html" };
            return sendFile(req, res, f, types[ext] || "application/octet-stream");
          }
          if ((m = p.match(/^\/api\/img\/([0-9a-f]{16})\.(png|jpg|webp)$/))) {
            const f = path.join(IMG, `${m[1]}.${m[2]}`);
            if (!fs.existsSync(f)) return json(res, { error: "missing" }, 404);
            return sendFile(req, res, f, { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[m[2]], true);
          }
          if ((m = p.match(/^\/api\/img\/([0-9a-f]{16})\.(png|jpg|webp)@(240|480|960|1600)\.jpg$/))) {
            if (!fs.existsSync(path.join(IMG, `${m[1]}.${m[2]}`))) return json(res, { error: "missing" }, 404);
            const f = await sized(m[1], m[2], Number(m[3]));
            // the original when it couldn't be sized: sent as what it is
            const type = f.endsWith(`-${m[3]}.jpg`) ? "image/jpeg" : { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[m[2]];
            return sendFile(req, res, f, type, true);
          }
          if ((m = p.match(/^\/api\/thumb\/([0-9a-f]{16})\.jpg$/))) {
            const f = await shoot(m[1], false, true);
            if (!f) return json(res, { error: "previews off" }, 404);
            return sendFile(req, res, f, "image/jpeg", true);
          }
          if ((m = p.match(/^\/api\/shot\/([0-9a-f]{16})(-full)?\.png$/))) {
            const f = await shoot(m[1], !!m[2]);
            if (!f) return json(res, { error: "previews off" }, 404);
            return sendFile(req, res, f, "image/png", true);
          }
          json(res, { error: "not found" }, 404);
        } catch (e) {
          json(res, { error: String(e?.message || e) }, 500);
        }
}

export function api() {
  return { name: "rounds-api", configureServer(server) { server.middlewares.use(handle); } };
}
