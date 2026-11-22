// Topics: what a project's screens were about, across sends and days. Claude reads each
// send's caption (and the thread it came from) and files it under a topic, so the canvas can
// lay related screens side by side even when they were shown a week apart.
//
// topics.json in the data folder (~/.rounds): { projects: { <key>: [{ id, title, sets: [setId…] }] } }
// A send no topic holds yet is "unfiled"; the canvas shows it as its own sitting until the
// next pass files it. Passes are incremental: Claude sees the existing topics and the new
// sends only, and either files each send under a topic or opens a new one.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DATA } from "./config.mjs";

export const TOPICS = path.join(DATA, "topics.json");
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
export function loadTopics() {
  const topics = readJSON(TOPICS, { projects: {}, moves: {} });
  topics.projects = Object.assign(Object.create(null), topics.projects);
  return topics;
}

/** A send filed under another project's topic belongs to that project. */
export function applyMoves(index, topics = loadTopics()) {
  const moves = topics.moves || {};
  return { ...index, sets: index.sets.map((s) => (moves[s.id] ? { ...s, project: moves[s.id] } : s)) };
}

const SYSTEM = `You file design work into topics. Each item is one set of screenshots a coding
thread showed the person, with the caption it gave them and the thread's name. A topic is the thing
being worked on (a screen, a feature, a visual direction, a mark), named the way the person would
say it: plain words, two to five of them, no em dashes, no dots between words, no jargon he
didn't use. Group by what the screens are about, not by when or by which thread. Reuse an
existing topic whenever an item belongs to it. Return only JSON:
{"files": [{"set": "<item id>", "topic": "<existing topic id>"} | {"set": "<item id>", "new": "<new topic title>"}]}
Every item appears exactly once.`;

function ask(prompt) {
  // The command-line Claude, run bare of his own settings (no hooks, so nothing lands in his
  // session capture) and without saving a session (so the indexer never sees it).
  return new Promise((resolve, reject) => {
    const p = spawn("claude", [
      "-p", "--setting-sources", "project", "--no-session-persistence", "--tools", "",
      "--model", "haiku", "--system-prompt", SYSTEM, "--output-format", "json",
    ], { cwd: path.dirname(new URL(import.meta.url).pathname) });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => {
      try {
        const r = JSON.parse(out);
        if (r.is_error) return reject(new Error(String(r.result).slice(0, 200)));
        const m = String(r.result).match(/\{[\s\S]*\}/);
        resolve(JSON.parse(m[0]));
      } catch (e) { reject(e); }
    });
    p.stdin.end(prompt);
  });
}

const line = (s, threads) => {
  const t = threads.get(s.thread);
  const day = new Date(s.at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const names = s.shots.slice(0, 4).map((x) => x.name).join(", ");
  return `- ${s.id} (${day}${t ? `, thread "${t.title}"` : ""}): ${(s.caption || "(no caption)").slice(0, 220)} [files: ${names}]`;
};

/** File every unfiled send. Returns how many were filed, or throws when Claude can't be reached. */
export async function fileTopics(raw, { log = () => {} } = {}) {
  const topics = loadTopics();
  const index = applyMoves(raw, topics);
  const threads = new Map(index.threads.map((t) => [t.id, t]));
  let filed = 0;
  for (const key of Object.keys(index.projects)) {
    const list = (topics.projects[key] ||= []);
    const held = new Set(list.flatMap((t) => t.sets));
    const fresh = index.sets.filter((s) => s.project === key && !held.has(s.id));
    if (!fresh.length) continue;
    for (let i = 0; i < fresh.length; i += 60) {
      const batch = fresh.slice(i, i + 60);
      const prompt = `Project: ${index.projects[key]}\n\nExisting topics:\n${list.map((t) => `- ${t.id}: ${t.title}`).join("\n") || "(none yet)"}\n\nNew items:\n${batch.map((s) => line(s, threads)).join("\n")}`;
      const r = await ask(prompt);
      for (const f of r.files || []) {
        if (!batch.some((s) => s.id === f.set)) continue;
        let t = f.topic && list.find((x) => x.id === f.topic);
        if (!t && f.new) {
          t = list.find((x) => x.title.toLowerCase() === String(f.new).toLowerCase());
          if (!t) list.push((t = { id: crypto.randomUUID().slice(0, 8), title: String(f.new).replace(/\s*[—–]\s*/g, ", ").slice(0, 48), sets: [] }));
        }
        if (t && !t.sets.includes(f.set)) { t.sets.push(f.set); filed++; }
      }
      fs.writeFileSync(TOPICS, JSON.stringify(topics, null, 1));
      log(`${index.projects[key]}: filed ${batch.length}`);
    }
  }
  return filed;
}

/** Posts that named their topic go straight under it: the session knew what it was working on. */
export function filePostTopics(index) {
  const topics = loadTopics();
  let changed = false;
  const held = new Set(Object.values(topics.projects).flat().flatMap((t) => t.sets));
  for (const s of index.sets) {
    if (!s.topic || held.has(s.id)) continue;
    const list = (topics.projects[s.project] ||= []);
    let t = list.find((x) => x.title.toLowerCase() === s.topic.toLowerCase());
    if (!t) list.push((t = { id: crypto.randomUUID().slice(0, 8), title: s.topic.replace(/\s*[\u2014\u2013]\s*/g, ", ").slice(0, 48), sets: [] }));
    t.sets.push(s.id);
    changed = true;
  }
  if (changed) fs.writeFileSync(TOPICS, JSON.stringify(topics, null, 1));
}
