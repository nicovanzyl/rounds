import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/rounds.mjs", import.meta.url));

test("client-specific setup, Codex hook delivery, and scoped removal", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rounds-clients-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, "canvas");
  const codex = path.join(dir, ".codex");
  const claude = path.join(dir, ".claude");
  const env = { ...process.env, HOME: dir, ROUNDS_HOME: data, CODEX_HOME: codex, ROUNDS_CODEX_HOME: codex,
    ROUNDS_CLAUDE_HOME: claude, ROUNDS_DESKTOP_SESSIONS: dir, PATH: dir + path.delimiter + process.env.PATH };
  const run = (args, input) => execFileSync(process.execPath, [cli, ...args], { cwd: dir, env, input, encoding: "utf8" });
  const json = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));
  const write = (filename, value) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(value));
  };
  // Emulate Codex's CLI boundary, including the distinction between absent and retained servers.
  fs.writeFileSync(path.join(dir, "codex"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), file = process.env.CODEX_HOME + '/server.json';
if (args[0] === '--version') console.log('codex-cli');
else if (args[1] === 'add') fs.writeFileSync(file, JSON.stringify({transport: {type:'stdio', command: args[4], args: args.slice(5)}}));
else if (args[1] === 'list') console.log(JSON.stringify(fs.existsSync(file) ? [{name:'rounds', ...JSON.parse(fs.readFileSync(file))}] : []));
else if (args[1] === 'get' && fs.existsSync(file)) console.log(fs.readFileSync(file, 'utf8'));
else if (args[1] === 'remove') fs.rmSync(file);
else { console.error("No MCP server named 'rounds' found."); process.exit(1); }
`, { mode: 0o755 });

  const other = { type: "command", command: "echo other" };
  const hooks = path.join(codex, "hooks.json");
  write(hooks, { hooks: { PostToolUse: [{ hooks: [other] }] } });
  const shared = path.join(data, "app", "in-use");
  write(shared, true); // Legacy Claude installed the npx runtime before client records existed.
  run(["uninstall", "--client", "generic", "--yes"]);
  assert.ok(fs.existsSync(shared));
  const generic = run(["init", "--client", "generic", "--yes"]);
  assert.match(generic, /"mcpServers"/);
  assert.match(generic, /"--client",\s+"generic"/);
  assert.equal(fs.existsSync(path.join(claude, "settings.json")), false);
  assert.deepEqual(json(hooks), { hooks: { PostToolUse: [{ hooks: [other] }] } });

  const init = () => run(["init", "--client", "codex", "--yes"]);
  assert.match(init(), /Review and trust/);
  assert.match(init(), /Review and trust/);
  assert.deepEqual(json(path.join(codex, "server.json")).transport.args, [cli, "mcp", "--client", "codex"]);
  assert.equal(json(hooks).hooks.UserPromptSubmit.length, 1);
  assert.deepEqual(json(hooks).hooks.PostToolUse[0].hooks, [other]);
  assert.equal(json(hooks).hooks.PostToolUse.length, 2);
  const skill = path.join(dir, ".agents/skills/rounds/SKILL.md");
  assert.ok(fs.existsSync(skill));

  const id = "0123456789abcdef", thread = "01234567-abcd-1234-5678-0123456789ab";
  const posted = path.join(data, "posts", id + ".json");
  write(posted, { id, caption: "First revision", shots: [{ hash: "screen", ext: "png", w: 8, h: 8 }] });
  run(["hook", "tool", "--client", "codex"], JSON.stringify({ session_id: thread, hook_event_name: "PostToolUse",
    tool_name: "mcp__rounds__rounds_post", tool_response: { content: [{ type: "text", text: "post " + id }] } }));
  assert.equal(json(posted).session, "codex-" + thread);
  write(path.join(data, "comments.json"), [{ id: "note", hash: "screen", text: "Widen it", x: 0.5, y: 0.5 }]);
  const prompt = JSON.stringify({ session_id: thread });
  assert.equal(run(["hook", "notes"], prompt), "");
  assert.match(run(["hook", "notes", "--client", "codex"], prompt), /Widen it/);
  assert.equal(run(["hook", "notes", "--client", "codex"], prompt), "");

  run(["init", "--yes"]);
  assert.ok(fs.existsSync(path.join(claude, "skills/rounds/SKILL.md")));
  run(["uninstall", "--client", "codex", "--yes"]);
  assert.equal(fs.existsSync(path.join(codex, "server.json")), false);
  assert.deepEqual(json(hooks), { hooks: { PostToolUse: [{ hooks: [other] }] } });
  assert.equal(fs.existsSync(skill), false);
  assert.ok(fs.existsSync(shared));
  assert.ok(fs.existsSync(path.join(claude, "skills/rounds/SKILL.md")));
  run(["uninstall", "--yes"]);
  assert.ok(fs.existsSync(shared));
  run(["uninstall", "--client", "generic", "--yes"]);
  assert.equal(fs.existsSync(shared), false);
  assert.ok(fs.existsSync(posted));
});
