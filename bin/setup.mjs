import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLAUDE, DATA } from "../server/config.mjs";

export const labels = { claude: "Claude Code", codex: "Codex", generic: "your MCP client" };
export const ourHook = /[\\/]bin[\\/](rounds|workbench)\.mjs["']? hook /;
const codexHome = process.env.ROUNDS_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const skillsDir = (client) => client === "claude" ? path.join(CLAUDE, "skills") : path.join(os.homedir(), ".agents", "skills");
const hooksFile = (client) => client === "claude" ? path.join(CLAUDE, "settings.json") : path.join(codexHome, "hooks.json");
const clientsDir = path.join(DATA, "installed-clients");
const say = console.log;
export const shellArg = (value) => /^[\w./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";

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
  fs.writeFileSync(path.join(clientsDir, client), "");
}

export function forgetClient(client) {
  if (!fs.existsSync(clientsDir)) return client === "claude";
  const record = path.join(clientsDir, client);
  if (!fs.existsSync(record)) return false;
  fs.unlinkSync(record);
  return fs.readdirSync(clientsDir).length === 0;
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

const ownsServer = (transport) => transport?.type === "stdio" &&
  /[\\/]bin[\\/]rounds\.mjs$/.test(transport.args?.[0] || "") && transport.args[1] === "mcp";

function addServer(client, self) {
  const args = [self, "mcp"];
  if (client === "generic") {
    args.push("--client", "generic");
    say("Add this stdio server to your MCP client's configuration:");
    say(JSON.stringify({ mcpServers: { rounds: { command: process.execPath, args } } }, null, 2));
    return;
  }
  const scope = client === "claude" ? ["--scope", "user"] : [];
  if (client === "codex") {
    fs.mkdirSync(codexHome, { recursive: true });
    const existing = codexServer();
    if (existing && !ownsServer(existing)) {
      say("Codex already has another MCP server named rounds. Kept its configuration.");
      process.exitCode = 1;
      return;
    }
    args.push("--client", "codex");
    if (existing?.command === process.execPath && JSON.stringify(existing.args) === JSON.stringify(args)) {
      say("  The rounds MCP server is already registered.");
      return;
    }
  }
  const install = ["mcp", "add", ...scope, "rounds", "--", process.execPath, ...args];
  const line = [client, ...install].map(shellArg).join(" ");
  if (client === "claude" && process.env.ROUNDS_CLAUDE_HOME) {
    say("  (trial run) would run: " + line);
    return;
  }
  if (client === "claude") for (const name of ["workbench", "rounds"]) cli(client, ["mcp", "remove", ...scope, name]);
  if (cli(client, install).status === 0) say("  Added the rounds MCP server.");
  else {
    say("  Couldn't register the MCP server. Run this where the client CLI is available:\n  " + line);
    process.exitCode = 1;
  }
}

const marker = "<!-- Installed by Rounds -->";
function ownSkill(file, client, name) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  return text.includes(marker) || (client === "claude" && new RegExp(`^name: ${name}$`, "m").test(text));
}

export function installSkill(home, client, update = false) {
  const dir = skillsDir(client);
  const dest = path.join(dir, "rounds", "SKILL.md");
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
  if (!ownSkill(file, client, name)) return;
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
    const suffix = client === "codex" ? " --client codex" : "";
    const hook = (name) => ({ type: "command", command: `${shellArg(process.execPath)} ${shellArg(self)} hook ${name}${suffix}` });
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
    for (const name of ["rounds", "workbench"]) cli(client, ["mcp", "remove", "--scope", "user", name]);
  }
  removeSkill(client, "rounds");
  if (client === "claude") removeSkill(client, "workbench");
  editHooks(client);
}
