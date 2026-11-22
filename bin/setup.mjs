import fs from "node:fs";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLAUDE, DATA } from "../server/config.mjs";

export const labels = { claude: "Claude Code", codex: "Codex", generic: "your MCP client" };
export const ourHook = /[\\/]bin[\\/](rounds|workbench)\.mjs["']? hook /;
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const claudeHome = process.env.ROUNDS_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || CLAUDE;
const skillsDir = (client) => client === "claude" ? path.join(claudeHome, "skills") : path.join(os.homedir(), ".agents", "skills");
const hooksFile = (client) => client === "claude" ? path.join(claudeHome, "settings.json") : path.join(codexHome, "hooks.json");
const clientsDir = path.join(DATA, "installed-clients");
const say = console.log;
const shellArg = (value) => /^[\w./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";

// A GUI, Git, and stdio clients may launch independently of the shell that ran init.
const canvasEnv = {
  ...(process.env.ROUNDS_HOME && { ROUNDS_HOME: path.resolve(DATA) }),
  ...(process.env.ROUNDS_PORT && { ROUNDS_PORT: process.env.ROUNDS_PORT }),
};
const assignments = Object.entries(canvasEnv).map(([key, value]) => key + "=" + value);
export function hookCommand(self, name, client) {
  const args = [process.execPath, self, "hook", name];
  if (client === "codex") args.push("--client", "codex");
  if (assignments.length) args.unshift("env", ...assignments);
  return args.map(shellArg).join(" ");
}

let codexCli;
function cli(command, args) {
  const env = command === "codex" ? { ...process.env, CODEX_HOME: codexHome } : process.env;
  if (command === "codex" && !codexCli) {
    const candidates = ["codex"];
    if (process.platform === "darwin") candidates.push("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "/Applications/Codex.app/Contents/Resources/codex");
    codexCli = candidates.find((exe) => spawnSync(exe, ["--version"], { env, stdio: "ignore" }).status === 0) || "codex";
  }
  return spawnSync(command === "codex" ? codexCli : command, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function rememberClient(client) {
  // An existing npx installation without client records predates multi-client setup.
  const legacy = fs.existsSync(path.join(DATA, "app")) && !fs.existsSync(clientsDir);
  fs.mkdirSync(clientsDir, { recursive: true });
  if (legacy) fs.writeFileSync(path.join(clientsDir, "claude"), "");
  fs.closeSync(fs.openSync(path.join(clientsDir, client), "a"));
}

function pushHooks(client) {
  const record = path.join(clientsDir, client);
  const content = fs.existsSync(record) && fs.readFileSync(record, "utf8");
  return content ? JSON.parse(content) : {};
}
const hookHash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function rememberPushHook(client, file) {
  const hooks = pushHooks(client);
  hooks[file] = hookHash(file);
  const record = path.join(clientsDir, client);
  const tmp = path.join(DATA, `install-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(hooks), { flag: "wx" });
    fs.renameSync(tmp, record);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function forgetClient(client, currentHook, ownedPushHook) {
  const record = path.join(clientsDir, client);
  const hooks = pushHooks(client);
  const recorded = fs.existsSync(record);
  if (!recorded && (fs.existsSync(clientsDir) || client !== "claude")) return false;
  const remaining = fs.existsSync(clientsDir) ? fs.readdirSync(clientsDir).filter((other) => other !== client) : [];
  const shared = new Set(remaining.flatMap((other) => Object.keys(pushHooks(other))));
  // Old installs didn't record repo paths. Preserve their historical uninstall behavior.
  if (!remaining.length && currentHook && !Object.hasOwn(hooks, currentHook) && ownedPushHook(currentHook)) {
    hooks[currentHook] = hookHash(currentHook);
  }
  const referenced = {};
  for (const [file, hash] of Object.entries(hooks)) {
    if (shared.has(file) || !fs.existsSync(file)) continue;
    if (!ownedPushHook(file) || hookHash(file) !== hash) {
      if (fs.readFileSync(file, "utf8").includes(path.join(DATA, "app", "bin"))) referenced[file] = hash;
      say(`  Preserved the modified hook at ${file}.`);
      continue;
    }
    fs.unlinkSync(file);
    say(`  Removed ${file}.`);
  }
  if (Object.keys(referenced).length) {
    fs.mkdirSync(clientsDir, { recursive: true });
    fs.writeFileSync(record, JSON.stringify(referenced));
    say("  A customized hook still uses the installed Rounds runtime. After updating that hook, repeat uninstall to clean up.");
    return false;
  }
  if (recorded) fs.unlinkSync(record);
  return !remaining.length;
}

function codexServer() {
  if (!fs.existsSync(codexHome)) return null;
  const result = cli("codex", ["mcp", "get", "--json", "rounds"]);
  if (result.status !== 0) {
    if (/no MCP server named/i.test(result.stderr || "")) return null;
    throw new Error("Couldn't read the Codex MCP configuration. Check that codex mcp list works and retry.");
  }
  const { transport } = JSON.parse(result.stdout);
  return transport;
}

function ownsServer(server) {
  return server && (!server.type || server.type === "stdio") && /^(node|node\.exe)$/i.test(path.basename(server.command || "")) &&
    /[\\/]bin[\\/](rounds|workbench)\.mjs$/.test(server.args?.[0] || "") && server.args[1] === "mcp";
}

function claudeRegistry() {
  const dir = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  const file = path.join(dir, ".claude.json");
  if (!fs.existsSync(file)) return { entries: {} };
  const original = fs.readFileSync(file, "utf8");
  const config = JSON.parse(original);
  return { file: fs.realpathSync(file), original, config, entries: config.mcpServers || {} };
}

// Claude's CLI adds and removes entries. Replacing an existing entry with two commands
// leaves a gap and can lose the original if the second command fails.
function replaceClaudeServer(registry, args) {
  const existing = registry.entries.rounds;
  const env = { ...existing.env };
  delete env.ROUNDS_HOME;
  delete env.ROUNDS_PORT;
  Object.assign(env, canvasEnv);
  registry.entries.rounds = { ...existing, command: process.execPath, args, env };
  const tmp = registry.file + "." + randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify(registry.config, null, 2), { flag: "wx", mode: 0o600 });
    if (fs.readFileSync(registry.file, "utf8") !== registry.original) throw new Error("Claude settings changed during setup. Run init again.");
    fs.renameSync(tmp, registry.file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function removeClaudeServer(name) {
  if (!ownsServer(claudeRegistry().entries[name])) return;
  if (cli("claude", ["mcp", "remove", "--scope", "user", name]).status !== 0) {
    throw new Error(`Claude Code could not remove the ${name} MCP server. Check claude mcp list and retry.`);
  }
}

function addServer(client, self) {
  const args = [self, "mcp"];
  if (client === "generic") {
    args.push("--client", "generic");
    say("Add this stdio server to your MCP client's configuration:");
    say(JSON.stringify({ mcpServers: { rounds: { command: process.execPath, args, ...(assignments.length && { env: canvasEnv }) } } }, null, 2));
    return;
  }
  const scope = client === "claude" ? ["--scope", "user"] : [];
  if (client === "codex") {
    fs.mkdirSync(codexHome, { recursive: true });
    args.push("--client", "codex");
  }
  const install = ["mcp", "add", ...scope, "rounds", ...assignments.flatMap((pair) => ["--env", pair]), "--", process.execPath, ...args];
  const line = [client, ...install].map(shellArg).join(" ");
  if (client === "claude" && process.env.ROUNDS_CLAUDE_HOME) {
    say("  (trial run) would run: " + line);
    return;
  }
  const registry = client === "claude" ? claudeRegistry() : null;
  const existing = registry ? registry.entries.rounds : codexServer();
  if (existing && !ownsServer(existing)) {
    throw new Error(`${labels[client]} already has another user MCP server named rounds. Its configuration was preserved.`);
  }
  if (existing?.command === process.execPath && JSON.stringify(existing.args) === JSON.stringify(args) &&
      ["ROUNDS_HOME", "ROUNDS_PORT"].every((key) => existing.env?.[key] === canvasEnv[key])) {
    say("  The rounds MCP server is already registered.");
  } else if (existing && registry) {
    replaceClaudeServer(registry, args);
    say("  Updated the rounds MCP server.");
  } else if (cli(client, install).status === 0) {
    say("  Added the rounds MCP server.");
  } else {
    say("  Couldn't register the MCP server. Run this where the client CLI is available:\n  " + line);
    process.exitCode = 1;
    return;
  }
  if (registry) removeClaudeServer("workbench");
}

const marker = "<!-- Installed by Rounds -->";
const linkedSkill = (file) => [file, path.dirname(file)].some((part) => fs.lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink());
function ownSkill(file, client, name) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  return text.includes(marker) || (client === "claude" &&
    new RegExp(`^name: ${name}$`, "m").test(text) && text.includes(`${name}_post`) && text.includes(`${name}_reply`));
}

export function installSkill(home, client, update = false) {
  const dir = skillsDir(client);
  const dest = path.join(dir, "rounds", "SKILL.md");
  if (linkedSkill(dest)) {
    if (!update) say("  Kept the linked skill at " + dest);
    return;
  }
  if (update && !ownSkill(dest, client, "rounds")) return;
  if (fs.existsSync(dest) && !ownSkill(dest, client, "rounds")) {
    say("  Kept the existing skill at " + dest);
    return;
  }
  if (!update && client === "claude") removeSkill(client, "workbench");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(home, "skill", "SKILL.md"), dest);
  if (!update) say("  Installed " + dest);
}

function removeSkill(client, name) {
  const file = path.join(skillsDir(client), name, "SKILL.md");
  if (linkedSkill(file) || !ownSkill(file, client, name)) return;
  // Some users share their skill directory between Codex and Claude with a symlink.
  const other = client === "claude" ? "codex" : "claude";
  const otherFile = path.join(skillsDir(other), name, "SKILL.md");
  if (fs.existsSync(path.join(clientsDir, other)) && fs.existsSync(otherFile) &&
      fs.realpathSync(otherFile) === fs.realpathSync(file)) return;
  fs.unlinkSync(file);
  if (!fs.readdirSync(path.dirname(file)).length) fs.rmdirSync(path.dirname(file));
  say("  Removed " + file);
}

function editHooks(client, self) {
  const file = hooksFile(client);
  if (!self && !fs.existsSync(file)) return;
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    settings.hooks[event] = groups.flatMap((group) => {
      if (!Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((h) => !ourHook.test(h.command || ""));
      if (hooks.length === group.hooks.length) return [group];
      removed += group.hooks.length - hooks.length;
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (self) {
    const hook = (name) => ({ type: "command", command: hookCommand(self, name, client) });
    const matcher = (client === "claude" ? "Bash|Artifact" : "Bash") + "|mcp__rounds__rounds_post|mcp__rounds__rounds_change";
    settings.hooks ||= {};
    (settings.hooks.UserPromptSubmit ||= []).push({ hooks: [hook("notes")] });
    (settings.hooks.PostToolUse ||= []).push({ matcher, hooks: [hook("tool")] });
    const hasBackup = [".before-rounds", ".before-workbench"].some((ending) => fs.existsSync(file + ending));
    if (fs.existsSync(file) && !hasBackup) fs.copyFileSync(file, file + ".before-rounds");
  } else {
    if (!removed) return;
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  say(`  ${self ? "Installed" : "Removed"} Rounds hooks in ${file}.`);
  if (self && client === "codex") say("  Review and trust the hooks in Codex with /hooks or Settings > Hooks.");
}

export async function installClient(client, self, ask) {
  if (client === "generic" || await ask(`Add the Rounds MCP server to ${labels[client]}?`)) addServer(client, self);
  if (client === "generic") return;
  if (await ask(`Install the rounds skill for ${labels[client]}?`)) installSkill(path.dirname(path.dirname(self)), client);
  if (await ask(`Install ${labels[client]} hooks for notes and pushes${client === "claude" ? " and published pages" : ""}?`)) editHooks(client, self);
}

export function removeClient(client) {
  if (client === "generic") {
    say("  Remove the rounds server entry from each MCP client where you added it.");
    return;
  }
  if (client === "codex") {
    if (ownsServer(codexServer()) && cli("codex", ["mcp", "remove", "rounds"]).status !== 0) {
      throw new Error("Codex could not remove its rounds server. Check codex mcp list and retry.");
    }
  } else if (!process.env.ROUNDS_CLAUDE_HOME) {
    for (const name of ["rounds", "workbench"]) removeClaudeServer(name);
  }
  removeSkill(client, "rounds");
  if (client === "claude") removeSkill(client, "workbench");
  editHooks(client);
}
