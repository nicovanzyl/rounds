#!/usr/bin/env node
// UserPromptSubmit hook: when you type in a session that has new notes on its work, they come
// into the conversation with your message, so the session sees them without any relay.
//
// A note belongs to this session when its thread is this session (or the desktop thread this
// session runs in), or when it is on work this session made: a post (the tool hook records
// which session made each post) or anything the canvas has since traced to it. Never by guessing from the folder: two sessions in one repo each
// get only their own. Each note is delivered once.
import fs from "node:fs";
import path from "node:path";
import { DATA, STORE } from "../server/config.mjs";
import { myNotes } from "../server/session-notes.mjs";
import { updateNotice } from "../server/updates.mjs";

// A new Rounds is said once, to the person, beside whatever notes this prompt brings to Claude.
const notice = updateNotice();
const done = (context) => {
  const out = { ...(notice && { systemMessage: notice }), ...(context && { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }) };
  if (!notice && !context) process.exit(0);
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
  return new Promise(() => {}); // nothing after this runs
};

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
const rawSession = input.session_id || "";
const session = rawSession && process.argv.includes("codex") ? `codex-${rawSession.toLowerCase()}` : rawSession;

if (!session) await done();

const comments = read(path.join(DATA, "comments.json"), []);
const SENT = path.join(DATA, "sent"), INBOX = path.join(DATA, "inbox");
const delivered = (c) => c.state === "sent" || fs.existsSync(path.join(SENT, `${c.id}.json`));
// A note the desktop relay is carrying is the relay's for its first five minutes: the relay's
// own message to the session runs this hook too, and the note would arrive twice. Past that the
// relay isn't running, and the next message here brings it.
const relaying = (c) => { try { return Date.now() - fs.statSync(path.join(INBOX, `${c.id}.json`)).mtimeMs < 5 * 60e3; } catch { return false; } };
const waiting = comments.filter((c) => /^[\w-]+$/.test(c.id) && !delivered(c) && !c.reply && !relaying(c));
if (!waiting.length) await done();

const mineWaiting = myNotes({ session, cwd: input.cwd || process.cwd() }, waiting);
if (!mineWaiting.length) await done();

// A simultaneous MCP read or another hook can claim the same note.
fs.mkdirSync(SENT, { recursive: true });
const notes = mineWaiting.filter(({ c }) => {
  try {
    fs.writeFileSync(path.join(SENT, `${c.id}.json`), JSON.stringify({ delivery: "hook", session, at: Date.now() }), { flag: "wx" });
  } catch (err) { if (err.code === "EEXIST") return false; throw err; }
  try { fs.unlinkSync(path.join(INBOX, `${c.id}.json`)); } catch {}
  return true;
});
if (!notes.length) await done();

const lines = notes.map(({ c, post: p }) => {
  const shot = p?.shots?.find((s) => s.hash === c.hash);
  const where = shot
    ? `on the screen ${path.join(STORE, "img", `${shot.hash}.${shot.ext}`)} (${shot.w}x${shot.h}), pinned at x ${Math.round(c.x * shot.w)}, y ${Math.round(c.y * shot.h)}`
    : `on the page ${path.join(STORE, `${c.hash}.html`)}, pinned at x ${Math.round(c.x)}, y ${Math.round(c.y)} on the page at 1280 wide`;
  return `- Note ${c.id}: "${c.text}" ${where}${p ? `, from your post "${p.caption}"` : ""}.`;
});
const context = [
  `The user left ${notes.length === 1 ? "a note" : `${notes.length} notes`} on your work in Rounds:`,
  ...lines,
  "Treat each as a request about that screen. Look at it (crop around the pinned point), act on it, then answer with rounds_reply and the note's id.",
].join("\n");

await done(context);
