// Stdio tools for a client without a shared filesystem. A conversation receives a
// random key on its first post. Only its digest is stored with the work on disk.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA } from "./config.mjs";

export const SNAPSHOT_MARK = "<!-- Rounds: content-only snapshot -->\n";
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const string = (description, maxLength) => ({ type: "string", description, maxLength });
const sessionKey = string("Reuse the private key returned by the first post in this conversation. Omit it only to start a new conversation.", 64);
const project = string("Project name on the canvas.", 80);
const title = string("A short name for this conversation on the canvas.", 120);
const images = {
  type: "array", maxItems: 8, description: "Inline PNG, JPEG or WebP images as base64 data URLs. The total decoded image limit is 5 MiB per call.",
  items: { type: "string" },
};
const writeFields = { project, session_title: title };
const fields = {
  rounds_post: { ...writeFields, caption: string("What changed.", 2000), topic: string("The line of work.", 120), images, before: images,
    page_html: string("A self-contained HTML snapshot. Inline styles and embedded images are supported.", 1_000_000),
    page_name: string("Stable page name. Reuse it in this conversation to post another version.", 120) },
  rounds_change: { ...writeFields, summary: string("Summary of a pushed change.", 2000), topic: string("The line of work.", 120), after: images, before: images },
  rounds_notes: { all: { type: "boolean", description: "Include answered notes." } },
  rounds_reply: { id: string("The note ID.", 80), reply: string("What you changed.", 2000) },
};

export function contentTools(tools) {
  return tools.map(({ name, annotations }) => ({
    name, annotations,
    description: {
      rounds_post: "Post a page or screens to the user's local canvas using inline content.",
      rounds_change: "Record a change summary and optional before and after screens.",
      rounds_notes: "Read notes pinned to this conversation's work.",
      rounds_reply: "Answer a note on this conversation's work.",
    }[name],
    inputSchema: { type: "object", properties: { ...fields[name], session_key: sessionKey }, additionalProperties: false,
      required: { rounds_post: ["caption", "topic"], rounds_change: ["summary"], rounds_notes: ["session_key"], rounds_reply: ["session_key", "id", "reply"] }[name] },
  }));
}

function readImage(url) {
  if (typeof url !== "string" || url.length > 7_000_000) throw new Error("Expected an inline image under 5 MiB.");
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match) throw new Error("Supply PNG, JPEG or WebP image data URLs.");
  const [, type, data] = match;
  const bytes = Buffer.from(data, "base64");
  const valid = type === "png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : type === "jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new Error("Image data does not match its declared format.");
  return { bytes, ext: type === "jpeg" ? "jpg" : type };
}

export async function callContent(name, args, callLocal) {
  let scratch;
  try {
    if (!Object.hasOwn(fields, name)) throw new Error("Unknown tool.");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected tool arguments.");
    const schema = { ...fields[name], session_key: sessionKey };
    for (const [key, value] of Object.entries(args)) {
      const field = schema[key];
      if (!Object.hasOwn(schema, key)) throw new Error("Unsupported content-only argument.");
      if (field.type === "array" ? !Array.isArray(value) || value.length > field.maxItems
        : typeof value !== field.type || (field.type === "string" && value.length > field.maxLength)) throw new Error(`Invalid ${key}.`);
    }
    const writing = name === "rounds_post" || name === "rounds_change";
    if ((!writing || args.session_key !== undefined) && !/^[a-f0-9]{64}$/.test(args.session_key || "")) throw new Error("Supply the session_key returned by your first post.");
    const key = args.session_key ?? crypto.randomBytes(32).toString("hex");
    const session = "mcp-" + digest("content-only\0" + key).slice(0, 32);
    const sessions = path.join(DATA, "content-sessions");
    const identityFile = path.join(sessions, session + ".json");
    let identity;
    if (args.session_key) {
      try { identity = JSON.parse(fs.readFileSync(identityFile, "utf8")); }
      catch (err) { if (err.code === "ENOENT") throw new Error("Unknown session_key."); throw err; }
    }
    const projectName = identity?.project || args.project?.trim() || "ChatGPT";
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(projectName)) throw new Error("Use a plain project name.");
    const sessionTitle = identity?.title || args.session_title?.trim() || "ChatGPT session";
    const context = { cwd: path.join(DATA, "remote-projects", projectName), client: "chatgpt", session, sessionTitle, contentOnly: true };
    if (args.page_html !== undefined) {
      if (!args.page_html.trim()) throw new Error("Supply HTML for this page.");
      const pageName = args.page_name?.trim() || "Page";
      context.inlinePage = { key: digest(session + "\0" + pageName).slice(0, 16), html: SNAPSHOT_MARK + args.page_html, title: pageName };
    }
    const local = {};
    for (const param of ["caption", "topic", "summary", "id", "reply", "all"]) if (param in args) local[param] = args[param];
    let size = 0;
    for (const kind of ["images", "before", "after"]) {
      if (!args[kind]?.length) continue;
      scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "rounds-upload-"));
      local[kind] = args[kind].map((image, index) => {
        const { bytes, ext } = readImage(image);
        size += bytes.length;
        if (size > 5 * 1024 * 1024) throw new Error("Images together exceed 5 MiB.");
        const filename = path.join(scratch, `${kind}-${index + 1}.${ext}`);
        fs.writeFileSync(filename, bytes);
        return filename;
      });
    }
    const result = await callLocal(name, local, context);
    if (scratch && result.isError) {
      for (const part of result.content) if (part.type === "text") part.text = part.text.replaceAll(scratch + path.sep, "");
    }
    if (!identity && !result.isError) {
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(identityFile, JSON.stringify({ project: projectName, title: sessionTitle }), { flag: "wx" });
      result.content.push({ type: "text", text: `Keep this private session_key for subsequent calls in this conversation: ${key}` });
    }
    return result;
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.code ? "Unable to store the supplied content." : error.message }] };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
