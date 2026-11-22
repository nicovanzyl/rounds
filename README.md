<p align="center">
  <img src="docs/rounds-mark.svg" width="72" alt="">
</p>

<h1 align="center">Rounds</h1>

<p align="center">Screens, pages and changes from your AI sessions, on one canvas.</p>

[![The Rounds canvas](docs/rounds-og.png)](docs/rounds-film.mp4)

<p align="center"><a href="docs/rounds-film.mp4">Watch the film</a></p>

I run a lot of Claude Code sessions at once and kept losing track of what each one made. Now it
all lands in one place, and I can leave notes on it.

## Try it

```bash
npx github:krispuckett/rounds --demo
```

The demo is six of my public projects and the real notes I left on them. It runs in its own
folder and doesn't touch your setup.

## What it does

Screens, pages and pushes from every session, sorted by project.

![The Road, one of the projects on the canvas](docs/canvas-project.jpg)

Pin a note on a screen. The session that made it gets the note, makes the fix and replies.

![A note on a screen, with the session's reply](docs/canvas-note.jpg)

Drag to compare a screen with the one it replaced.

![A sky before and after a fix](docs/canvas-compare.jpg)

Step back to any day to see what was made on it.

![Earlier days stacked behind the current one](docs/canvas-time.jpg)

Search a session by name, or tap a group's title in the timeline, to see only that session's
work, newest first.

The files a session changed sit on a sheet beside its screens. Open one to read every change
line by line, and to see which other sessions changed it too.

Claude Code deletes terminal sessions after 30 days by default. What they made stays on your
canvas, and so does every page they published, even after its folder is cleared.

## Set it up

Rounds runs locally with Node 20 or newer. macOS supports image resizing and page previews with a Chromium browser. Choose the setup for the client you use. To try this branch from a checkout, run `npm ci` once and use `node bin/rounds.mjs` for the commands below.

| Client | Setup from this checkout | What reaches the canvas |
| --- | --- | --- |
| Claude Code | `node bin/rounds.mjs init` | Local transcript history, published pages, posts and hooks |
| Codex CLI, desktop or IDE | `node bin/rounds.mjs init --client codex` | Local Codex rollouts, recorded file changes, posts and supported hooks |
| Other local MCP clients | `node bin/rounds.mjs init --client generic` | Screens, pages and changes explicitly posted with MCP |
| ChatGPT on the web | Connect the content-only server through a private tunnel, as described below | Inline pages, images and change summaries posted from the connected chat |

Then open the canvas with `node bin/rounds.mjs`. You can run setup for more than one client. To remove an integration, run `node bin/rounds.mjs uninstall` with the same `--client` option.

For the released Claude Code setup, run `npx github:krispuckett/rounds init`, then `npx github:krispuckett/rounds` to open the canvas. Opening the released version through npx updates the installed hooks and server. The dock also offers an Update button when a release is available. For installations from before 1.1, run `init` again to enable published page capture.

**Codex.** Setup registers the MCP server and offers to install the Rounds skill and hooks. Review the hooks with `/hooks` or in **Settings → Hooks**, then start a new session. The index reads active and archived rollouts from `CODEX_HOME` (normally `~/.codex`). Set `ROUNDS_CODEX_HOME` to index a different location. To share a screenshot or version an HTML page, ask Codex to post it to Rounds. [Codex MCP setup](https://developers.openai.com/codex/mcp) · [Codex hooks](https://developers.openai.com/codex/hooks)

**Other local clients.** Generic setup prints the stdio command and arguments for your MCP configuration. For clients with a different configuration format, register the same executable and argument list under the server name `rounds`. Give each conversation a unique `session_id` and reuse it for all four tools. Supply `cwd` when the server launches outside your project, and `session_title` to give the session a readable name. Ask the client to check `rounds_notes` when you return to the conversation.

**ChatGPT on the web.** Use a private Secure MCP Tunnel from the Mac that holds your canvas. Create a tunnel associated with your ChatGPT workspace, install OpenAI’s tunnel client, and configure its runtime key using the setup guide. With your tunnel ID in `TUNNEL_ID`, run the following from this checkout. [OpenAI tunnel setup and permissions](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

```bash
tunnel-client init --sample sample_mcp_stdio_local --profile rounds \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-command "node \"$PWD/bin/rounds.mjs\" mcp --content-only"
tunnel-client doctor --profile rounds --explain
tunnel-client run --profile rounds
```

Keep the tunnel running. In ChatGPT on the web, add a custom MCP server, choose **Tunnel**, and select that tunnel. This setup is for a personal canvas. Anyone granted access to the connection can post to it. Workspace permissions govern who can add the server and use its write tools. [Connect a custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server)

For a first check, ask ChatGPT to post a small HTML page under a named project. It can send self-contained HTML in `page_html` or PNG, JPEG and WebP images as base64 data URLs. On the first post, Rounds returns a private `session_key` for the chat to reuse when it posts revisions, checks notes or replies. Reuse `page_name` to version a page. The canvas opens on the computer running Rounds.

## Privacy

The canvas, snapshots and notes live in `~/.rounds`. Local clients can post files the MCP process can read. The content-only server accepts inline content, serves uploaded HTML as a static snapshot and limits note access to the conversation holding the key. When you connect ChatGPT, tool inputs and responses travel through your OpenAI tunnel. Only work you post from ChatGPT appears on the canvas.

To sort older, unfiled screens into topics, Rounds can ask Claude Haiku through your own Claude Code, sending the caption, session name and file names. Explicitly named post topics work with every client. Once a day Rounds asks GitHub whether there is a newer version. Set `"updates": false` in the config to disable that check.

<details>
<summary>More</summary>

### Tools

Sessions post with `rounds_post` and `rounds_change`, read notes with `rounds_notes` and answer
them with `rounds_reply`. The optional Claude Code and Codex hooks deliver notes on the next prompt and recognize pushes to main. The Claude Code hook also keeps a copy of each published artifact.

In auto mode, Claude Code may ask you before acting on a note. Say yes and it carries on.

### Keys

| Key | Does |
| --- | --- |
| T | Timeline |
| ← → | Back or forward through the days with work |
| / or ⌘K | Search |
| + − 0 | Zoom in, zoom out, fit everything |
| Space | Hold to pan, or to see the before while comparing |
| Esc | Back out |

Scroll pans and pinch zooms, in the timeline too; scrolling over its rail moves through
the days. Drop an image or an HTML file on the canvas to add it to a project.

### Config

`~/.rounds/config.json`, every field optional:

```json
{
  "projects": [{ "key": "shop", "name": "Shop", "match": ["shop", "storefront"] }],
  "private": ["acme-internal"],
  "port": 4797,
  "updates": true
}
```

`projects` groups work by words in its session, folder or caption. Anything matching `private`
never shows up. `ROUNDS_HOME` and `ROUNDS_PORT` override the folder and the port.

### Develop

```bash
npm install
npm run dev     # the canvas, on :4797
npm test        # isolated client integration tests
npm run eval    # the whole loop with real Claude sessions
```

A release is a version tag on GitHub: `npm run release` checks that the version in
`package.json` is new and pushed, then tags it and writes its release notes. Copies opened with
npx see it within a day.

</details>

## License

MIT. Made by [Kris Puckett](https://krispuckett.com).
