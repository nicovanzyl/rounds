// End to end, with real Claude Code sessions and the setup `rounds init` installed (the MCP
// server, the skill, the hooks). Nothing lands on your own canvas: the sessions, their hooks and
// the canvas all point at a throwaway Rounds folder.
//
// The loop it checks, the way a person would use it:
//   1. A session builds a page, captures it and posts it to the canvas.
//   2. You pin a note on that screen.
//   3. Your next message there brings the note in; the session acts on it, posts the after
//      with its before, and answers on the pin.
//   4. It commits and pushes to main; the push is recorded with what changed.
//
//   node evals/e2e.mjs            (needs `claude` signed in: claude auth login)
//   EVAL_MODEL=sonnet node evals/e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "rounds-eval-"));
const HOME = path.join(T, "rounds"), SITE = path.join(T, "site"), REMOTE = path.join(T, "remote.git");
const PORT = 4791;
const env = { ...process.env, ROUNDS_HOME: HOME };
// a session started from inside another one must not inherit its identity
for (const k of Object.keys(env)) if (/^CLAUDE_CODE_|^CLAUDECODE$/.test(k) && k !== "CLAUDE_CODE_OAUTH_TOKEN") delete env[k];

const results = [];
const check = (ok, what, detail = "") => { results.push({ ok, what, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && detail ? `\n      ${String(detail).slice(0, 600)}` : ""}`); return ok; };
const git = (...a) => execFileSync("git", a, { cwd: SITE, encoding: "utf8" }).trim();
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const posts = () => { try { return fs.readdirSync(path.join(HOME, "posts")).map((f) => read(path.join(HOME, "posts", f))).filter(Boolean).sort((a, b) => a.at - b.at); } catch { return []; } };

// ---- the project: a page, a way to capture it, a repo with a remote -------------------------
fs.mkdirSync(path.join(SITE, "screens"), { recursive: true });
fs.writeFileSync(path.join(SITE, "index.html"), `<!doctype html><title>Eval</title>
<style>body{margin:0;font:18px system-ui;background:#f6f5f2;color:#15181d;display:grid;place-items:center;height:100vh}
h1{font-size:56px;letter-spacing:-0.03em;margin:0 0 24px}button{font:inherit;padding:14px 28px;border:0;border-radius:999px;background:#15181d;color:#fff}</style>
<main><h1>Welcome</h1><button>Get started</button></main>`);
fs.writeFileSync(path.join(SITE, "shoot.mjs"), `// Captures index.html as screens/home.png at 1280 by 800.
import { chromium } from ${JSON.stringify(path.join(ROOT, "node_modules/playwright-core/index.mjs"))};
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await p.goto("file://" + new URL("./index.html", import.meta.url).pathname);
await p.screenshot({ path: new URL("./screens/" + (process.argv[2] || "home.png"), import.meta.url).pathname });
await b.close();
console.log("saved screens/" + (process.argv[2] || "home.png"));
`);
git("init", "-q", "-b", "main");
git("config", "user.email", "eval@rounds.local"); git("config", "user.name", "Rounds eval");
git("add", "."); git("commit", "-qm", "Add: the landing page");
execFileSync("git", ["init", "-q", "--bare", REMOTE]);
git("remote", "add", "origin", REMOTE);
git("push", "-q", "-u", "origin", "main");

// ---- a Claude Code session, the way a person runs one -----------------------------------------
const ALLOWED = [
  "Read", "Edit", "Write", "Skill", "Bash(node shoot.mjs*)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)",
  "Bash(git add*)", "Bash(git commit*)", "Bash(git push*)", "mcp__rounds__rounds_post", "mcp__rounds__rounds_change",
  "mcp__rounds__rounds_notes", "mcp__rounds__rounds_reply",
].join(",");
let spent = 0;
function claude(prompt, resume) {
  // default mode, whatever yours is: the tools above are allowed and nothing else is asked about
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "default", "--allowedTools", ALLOWED, ...(resume ? ["--resume", resume] : []), ...(process.env.EVAL_MODEL ? ["--model", process.env.EVAL_MODEL] : [])];
  return new Promise((done) => {
    const c = spawn("claude", args, { cwd: SITE, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => c.kill(), 6 * 60e3);
    c.on("close", () => {
      clearTimeout(timer);
      let r = null; try { r = JSON.parse(out); } catch {}
      spent += r?.total_cost_usd || 0;
      done(r || { is_error: true, result: (out + err).slice(-800) });
    });
  });
}

// ---- the canvas, on the same throwaway folder --------------------------------------------------
const empty = path.join(T, "no-transcripts");
fs.mkdirSync(path.join(empty, "projects"), { recursive: true });
const server = spawn("node", ["-e", `import(${JSON.stringify(path.join(ROOT, "server/serve.mjs"))}).then((m) => m.serve(${PORT}))`],
  { env: { ...env, ROUNDS_CLAUDE_HOME: empty, ROUNDS_CODEX_HOME: empty, ROUNDS_DESKTOP_SESSIONS: empty }, stdio: "ignore" });
const api = async (p, body) => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); return await r.json(); }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("the canvas never answered");
};

try {
  // 1. build, capture, post
  console.log(`\nWorking in ${T}\n\n1. A session captures the page and posts it`);
  const one = await claude("This is a small landing page. Capture it with `node shoot.mjs`, then put the screen on my Rounds canvas under the topic \"Eval page\", with a one-line caption.");
  const session = one.session_id;
  if (!check(!one.is_error && !!session, "the session ran", one.result)) throw new Error("stopped");
  const first = posts().find((p) => p.topic === "Eval page" && p.shots?.length);
  check(!!first, "it posted the screen to the canvas, under its topic", JSON.stringify(posts().map((p) => p.topic)));
  if (!first) throw new Error("stopped");
  check(first.session === session, "the tool hook tied the post to its session", `post.session ${first.session}, session ${session}`);
  const idx = await api("/api/index");
  const set = idx.sets.find((s) => s.id === first.id);
  check(!!set && set.thread === session, "the canvas shows it under that session", JSON.stringify(set && { thread: set.thread, topic: set.topic }));

  // 2. a note on it
  console.log("\n2. You pin a note on that screen");
  const shot = first.shots[0];
  const note = await api("/api/comments", { page: `shot-${shot.hash}`, hash: shot.hash, set: first.id, x: 0.5, y: 0.42, text: "Make the heading say Hello, Rounds, and make the button green." });
  check(note.route === "hook" && note.thread === session && note.state === "queued", "the pin says it goes to that session with your next message", JSON.stringify(note));

  // 3. the next message brings it in
  console.log("\n3. Your next message there brings the note in");
  const two = await claude("Carry on.", session);
  check(!two.is_error, "the session ran again", two.result);
  const sent = read(path.join(HOME, "sent", `${note.id}.json`), null);
  check(sent?.delivery === "hook" && sent?.session === session, "the notes hook delivered the note into that session, once", JSON.stringify(sent));
  const page = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  check(/Hello, Rounds/.test(page), "the session did what the note asked (the heading)", page.match(/<h1>[^<]*<\/h1>/)?.[0]);
  const after = posts().filter((p) => p.at > first.at && p.shots?.length);
  const withBefore = after.find((p) => p.before?.length || p.replaces === first.id);
  check(!!withBefore, "it posted the after, with the before to compare", JSON.stringify(after.map((p) => ({ topic: p.topic, before: !!p.before, replaces: p.replaces }))));
  const answered = (await api("/api/comments")).find((c) => c.id === note.id);
  check(!!answered?.reply?.text, "it answered on the pin", JSON.stringify(answered?.reply));

  // 4. commit and push
  console.log("\n4. It commits and pushes to main");
  const before = git("rev-parse", "--short=7", "origin/main");
  const three = await claude("Commit this and push it to main.", session);
  check(!three.is_error, "the session ran a third time", three.result);
  const now = git("rev-parse", "--short=7", "origin/main");
  check(now !== before, "the push reached main", `${before} -> ${now}`);
  const change = posts().find((p) => p.kind === "change");
  check(!!change, "the push hook had it record the change on the canvas", JSON.stringify(posts().map((p) => p.kind)));
  check(!!change && change.range?.includes(now) && (change.commits || []).length > 0, "the change carries the pushed range and its commits", JSON.stringify(change && { range: change.range, commits: change.commits }));
  check(!!change && change.session === session, "the change is tied to the session too", change?.session);
} catch (e) {
  if (e.message !== "stopped") check(false, "the eval ran to the end", e.stack);
} finally {
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} of ${results.length} passed. Spent $${spent.toFixed(2)}. Everything it made is in ${T}`);
  process.exit(failed ? 1 : 0);
}
