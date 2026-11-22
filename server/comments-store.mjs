// The canvas and independent MCP processes share comments.json. Each writer takes a ticket
// before reading it, then publishes the complete replacement with a same-directory rename.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DATA } from "./config.mjs";

const file = path.join(DATA, "comments.json");
const queue = path.join(DATA, "comment-writers");

function writers() {
  const active = [];
  for (const name of fs.readdirSync(queue)) {
    if (!/^[1-9]\d*-[a-f0-9-]{36}$/.test(name)) continue;
    try {
      const pid = Number(name.split("-")[0]);
      process.kill(pid, 0);
      active.push({ name, ticket: Number(fs.readFileSync(path.join(queue, name), "utf8")) });
    } catch (err) {
      // A crashed writer's unique ticket can be reclaimed without touching a successor.
      if (err.code === "ESRCH") fs.rmSync(path.join(queue, name), { force: true });
      else if (err.code !== "ENOENT") throw err;
    }
  }
  return active;
}

export async function updateComments(mutate) {
  fs.mkdirSync(queue, { recursive: true });
  const name = `${process.pid}-${randomUUID()}`;
  const marker = path.join(queue, name);
  const tmp = path.join(DATA, `comments-${name}.tmp`);
  fs.writeFileSync(marker, "", { flag: "wx" }); // choosing a ticket
  try {
    const ticket = 1 + Math.max(0, ...writers().map(w => w.ticket));
    fs.writeFileSync(marker, String(ticket));
    const until = Date.now() + 10_000;
    while (writers().some(w => w.ticket < ticket || (w.ticket === ticket && w.name < name))) {
      if (Date.now() >= until) throw new Error("Another Rounds client is saving notes. Retry this call.");
      await delay(10);
    }
    let comments = [];
    try { comments = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (err) { if (err.code !== "ENOENT") throw err; }
    const result = mutate(comments);
    fs.writeFileSync(tmp, JSON.stringify(comments, null, 1));
    fs.renameSync(tmp, file);
    return result;
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(tmp, { force: true });
  }
}
