---
name: rounds
description: Put your work on the user's Rounds canvas and act on the notes they leave there. Use after you finish visual work worth looking at (screens built or changed, a page made, a before and after), after you push to the main branch, and whenever a note from Rounds arrives. Needs the rounds MCP server (rounds_post, rounds_change, rounds_notes, rounds_reply).
---

<!-- Installed by Rounds -->

# Rounds

Rounds is the user's local canvas of everything their sessions make, organized by
project and topic, with history on a timeline. You put work there; they look, compare, and pin
notes on it; the notes come back to you.

## When to post

Post at natural finishing points, without being asked:

- You built or changed something the user will look at: a screen, a component in a running app,
  a page, a chart, an image.
- You have a before and after worth seeing side by side.
- You published or wrote an HTML page they should see.

Don't post every intermediate frame, debugging captures, or screens nobody changed. One post per
finished piece of work; a few screens in it is fine.

## How to post

Claude Code and Codex normally identify the chat automatically. If Codex needs a session ID,
use the thread ID from `CODEX_THREAD_ID`. In generic local MCP clients, pass a unique, stable `session_id`
for this conversation on every call. You can give the session a readable `session_title`
when posting. In content-only mode, keep the returned `session_key` and send inline images
or `page_html` using the tool schema. For local files, supply the project's absolute `cwd`
if the server runs elsewhere.

`rounds_post` with:

- **topic**: the line of work, two to five plain words ("Swipe-up card", "Pricing page",
  "Onboarding copy"). Reuse the same topic for the same work, across sessions and days; that is
  what keeps the canvas organized. Name the thing, not the task ("Checkout form", not "Fixing
  bugs").
- **caption**: what this shows and what changed, the way you'd tell a person: one or two
  sentences. Say which is before and which is after when there are both.
- **images** (screens) or **page** (an HTML file). Paths are relative to the project.
- **before**, optional: the same screens before your change, one per image, same order, same
  size and data. Or **replaces**: the id of your earlier post these supersede.

Posting the same HTML path again adds a version of that page, and the canvas shows the change
between versions.

## How to capture

Capture what the user would actually see:

- A web app: a real browser at a real size (Playwright, or the browser tools you have). Wait for
  fonts and images to load.
- An iOS app: the simulator's own screenshot.
- Before and after: same window size, same data, same scroll position. Take the before first,
  before you change anything, when you know a change is coming.

Save captures somewhere that lasts long enough to post (the project's own screenshots folder is
good; Rounds copies them into its store when you post).

## After a push to main

After pushing to the main branch, call `rounds_change` with the pushed commit range
(from the hook when available), a plain summary of what changed for the person
using it, and when it's visible, the screens it touched now (**after**) and before (**before**).
If nothing visible changed, record just the range and the summary.

## Notes from the user

The user pins notes on your screens and pages. The optional Claude Code and Codex hooks
deliver them with the next message. In other clients, or when hooks are disabled, check
`rounds_notes` when resuming work or when the user asks about feedback. Inspect the screen around the pinned point.

Treat a note as a request from the user about that screen. Do what it asks, post the result
(with the old screen as the before), then answer with `rounds_reply`: one or two plain
sentences on what you changed.

## Words

Plain words everywhere: in topics, captions and replies. No jargon you didn't hear from the
user, no em dashes, no marketing voice.
