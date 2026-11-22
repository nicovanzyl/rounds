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
  const env = { ...process.env, HOME: dir, ROUNDS_HOME: data, CODEX_HOME: codex, ROUNDS_CODEX_HOME: path.join(dir, "separate-history"), ROUNDS_PORT: "4877",
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
else if (args[1] === 'add') {
  const separator = args.indexOf('--');
  const env = Object.fromEntries(args.flatMap((arg, i) => arg === '--env' ? [args[i + 1].split('=')] : []));
  fs.writeFileSync(file, JSON.stringify({transport: {type:'stdio', command: args[separator + 1], args: args.slice(separator + 2), env}}));
}
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
  assert.match(generic, /"ROUNDS_PORT": "4877"/);
  assert.equal(fs.existsSync(path.join(claude, "settings.json")), false);
  assert.deepEqual(json(hooks), { hooks: { PostToolUse: [{ hooks: [other] }] } });

  const init = () => run(["init", "--client", "codex", "--yes"]);
  assert.match(init(), /Review and trust/);
  assert.match(init(), /Review and trust/);
  assert.deepEqual(json(path.join(codex, "server.json")).transport.args, [cli, "mcp", "--client", "codex"]);
  assert.deepEqual(json(path.join(codex, "server.json")).transport.env, { ROUNDS_HOME: data, ROUNDS_PORT: "4877" });
  assert.equal(fs.existsSync(path.join(env.ROUNDS_CODEX_HOME, "hooks.json")), false);
  const promptHook = json(hooks).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(promptHook, /ROUNDS_HOME=/);
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
  run(["hook", "tool"], JSON.stringify({ session_id: "other-chat", hook_event_name: "PostToolUse",
    tool_name: "mcp__rounds__rounds_post", tool_response: { content: [{ type: "text", text: "post " + id }] } }));
  assert.equal(json(posted).session, "codex-" + thread, "Claude hooks preserve native MCP attribution");
  write(path.join(data, "comments.json"), [{ id: "note", hash: "screen", text: "Widen it", x: 0.5, y: 0.5 }]);
  const prompt = JSON.stringify({ session_id: thread });
  assert.equal(run(["hook", "notes"], prompt), "");
  const detachedEnv = { ...env };
  delete detachedEnv.ROUNDS_HOME;
  delete detachedEnv.ROUNDS_PORT;
  assert.match(execFileSync("/bin/sh", ["-c", promptHook], { cwd: dir, env: detachedEnv, input: prompt, encoding: "utf8" }), /Widen it/);
  assert.equal(run(["hook", "notes", "--client", "codex"], prompt), "");

  const shot = { hash: "historical", ext: "png", w: 100, h: 60 };
  write(path.join(data, "index.json"), { threads: [], pages: [], sets: [
    { id: "codex-edit", thread: "codex-" + thread, caption: "Codex capture", shots: [shot] },
    { id: "other-edit", thread: "other-chat", caption: "Another capture", shots: [shot] },
  ] });
  write(path.join(data, "comments.json"), [
    { id: "unbound", page: "shot-historical", hash: shot.hash, text: "Ambiguous legacy pin" },
    { id: "bound", page: "shot-historical", set: "codex-edit", hash: shot.hash, text: "Known capture", x: 0.3, y: 0.5 },
  ]);
  const historical = run(["hook", "notes", "--client", "codex"], prompt);
  assert.match(historical, /Known capture/);
  assert.match(historical, /historical\.png \(100x60\), pinned at x 30, y 30/);
  assert.doesNotMatch(historical, /Ambiguous legacy pin/);
  assert.equal(fs.existsSync(path.join(data, "sent/unbound.json")), false);
  write(path.join(data, "private-history.json"), { sessions: ["codex-" + thread] });
  write(path.join(data, "comments.json"), [{ id: "private", page: "shot-historical", set: "codex-edit",
    thread: "codex-" + thread, hash: shot.hash, text: "Private pin" }]);
  assert.equal(run(["hook", "notes", "--client", "codex"], prompt), "");
  assert.equal(fs.existsSync(path.join(data, "sent/private.json")), false);

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

  // Both clients can discover the same user-managed skill directory.
  fs.rmdirSync(path.join(claude, "skills"));
  fs.symlinkSync(path.join(dir, ".agents/skills"), path.join(claude, "skills"), "dir");
  init();
  run(["init", "--yes"]);
  run(["uninstall", "--client", "codex", "--yes"]);
  assert.ok(fs.existsSync(skill), "the remaining Claude integration uses the same skill");
  run(["uninstall", "--yes"]);
  assert.equal(fs.existsSync(skill), false);
});

test("Claude setup preserves foreign servers and retires Workbench only after a successful move", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rounds-claude-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = path.join(dir, ".claude.json");
  const env = { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: dir, ROUNDS_HOME: path.join(dir, "canvas"),
    ROUNDS_CODEX_HOME: path.join(dir, "history"), ROUNDS_DESKTOP_SESSIONS: path.join(dir, "desktop"),
    PATH: dir + path.delimiter + process.env.PATH };
  delete env.ROUNDS_CLAUDE_HOME;
  delete env.WORKBENCH_CLAUDE_HOME;
  const run = (cmd, extraEnv = {}) => execFileSync(process.execPath, [cli, cmd, "--yes"], {
    cwd: dir, env: { ...env, ...extraEnv }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  fs.writeFileSync(path.join(dir, "claude"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2), f = process.env.CLAUDE_CONFIG_DIR + "/.claude.json";
const config = JSON.parse(fs.readFileSync(f)), servers = config.mcpServers;
if (args[1] === "remove") delete servers[args.at(-1)];
else if (args[1] === "add") {
  if (process.env.FAIL_ADD || servers.rounds) process.exit(1);
  const split = args.indexOf("--");
  servers.rounds = { command: args[split + 1], args: args.slice(split + 2) };
} else process.exit(1);
fs.writeFileSync(f, JSON.stringify(config));
`, { mode: 0o755 });
  const foreign = { type: "http", url: "https://example.test/service" };
  const legacy = { command: "node", args: ["/old/bin/workbench.mjs", "mcp"] };
  const write = entries => fs.writeFileSync(registry, JSON.stringify({ unrelated: { preserve: true }, mcpServers: entries }));
  const read = () => JSON.parse(fs.readFileSync(registry, "utf8"));
  write({ workbench: legacy, rounds: foreign });
  assert.throws(() => run("init"), /another user MCP server named rounds/);
  assert.deepEqual(read().mcpServers, { workbench: legacy, rounds: foreign });

  write({ workbench: legacy });
  assert.throws(() => run("init", { FAIL_ADD: "1" }));
  assert.deepEqual(read().mcpServers, { workbench: legacy });
  run("init");
  assert.ok(read().mcpServers.rounds);
  assert.equal(read().mcpServers.workbench, undefined);

  const oldRounds = { command: "node", args: ["/old/bin/rounds.mjs", "mcp"], env: { CUSTOM: "kept" }, timeout: 123 };
  write({ workbench: foreign, rounds: oldRounds });
  run("init", { FAIL_ADD: "1" }); // Replaces our own entry without an unregister/register gap.
  assert.deepEqual(read().mcpServers.rounds.args, [cli, "mcp"]);
  assert.equal(read().mcpServers.rounds.env.CUSTOM, "kept");
  assert.equal(read().mcpServers.rounds.timeout, 123);
  assert.deepEqual(read().unrelated, { preserve: true });
  run("uninstall");
  assert.deepEqual(read().mcpServers, { workbench: foreign });
  write({ workbench: foreign, rounds: foreign });
  run("uninstall");
  assert.deepEqual(read().mcpServers, { workbench: foreign, rounds: foreign });
});

test("uninstall removes managed pre-push hooks across repositories and preserves manual edits", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rounds-push-hooks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, ROUNDS_HOME: path.join(dir, "canvas"), ROUNDS_CODEX_HOME: dir,
    ROUNDS_CLAUDE_HOME: path.join(dir, "claude"), ROUNDS_DESKTOP_SESSIONS: dir };
  const run = (cwd, cmd, client) => execFileSync(process.execPath, [cli, cmd, "--client", client, "--yes"], { cwd, env, encoding: "utf8" });
  const [a, b, c] = ["a", "b", "c"].map(name => path.join(dir, name));
  for (const repo of [a, b, c]) execFileSync("git", ["init", "-q", repo], { env });
  const hook = (repo) => path.join(repo, ".git", "hooks", "pre-push");
  run(a, "init", "generic");
  run(b, "init", "generic");
  run(b, "init", "claude");
  run(c, "init", "generic");
  fs.appendFileSync(hook(c), "# Custom follow-up\n");
  run(dir, "uninstall", "generic");
  assert.equal(fs.existsSync(hook(a)), false);
  assert.ok(fs.existsSync(hook(b)));
  assert.match(fs.readFileSync(hook(c), "utf8"), /Custom follow-up/);
  run(dir, "uninstall", "claude");
  assert.equal(fs.existsSync(hook(b)), false);
  assert.match(fs.readFileSync(hook(c), "utf8"), /Custom follow-up/);
});
