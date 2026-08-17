# Session Notes

Attach short, private notes to messages in a bb thread, so that when you scroll
back through a transcript you see your own annotations next to the output they
refer to.

**Notes are for you, not for the agent.** They are never injected into a model's
context, never sent to a provider, and never influence a turn. They are also
deliberately ephemeral: scoped to one thread, not synced, not exported, and
swept when the thread ends.

## Using it

**In the app.** Hover any user or assistant message and click **Add note**
(speech-bubble icon). A **Notes** tab opens in the thread's right panel with a
box already anchored to that message. **Cmd/Ctrl + Enter saves, Esc discards**
— plain Enter inserts a newline, so lists and fenced code can be typed. Click a
saved note to reveal its **Delete note** button. Notes are listed in timeline
order, so reading the panel top to bottom walks the thread.

Note bodies are **markdown**, rendered through bb's own chat renderer. Bodies
are stored raw, so this is a display concern only — nothing to migrate, and
turning it off is a one-line revert. The anchor excerpt above each note stays
plain text on purpose (see *Storage*).

The trade-off: rendering through the chat renderer means notes no longer read as
typographically distinct from agent output. The distinction is carried
structurally instead — accented left rule, card background, and the role label
("You" / "via bb note").

**From a script or hook.**

```
bb note add <text> [--seq <n>]   # default anchor: the end of the thread
bb note list
bb note rm <id>
```

## Settings

`bb plugin config session-notes`

| Setting | Default | Effect |
| --- | --- | --- |
| `sweepOnArchive` | `true` | Archiving a thread deletes its notes |
| `retentionDays` | `"off"` | Hourly age sweep; `off / 1 / 7 / 30 / 90` |

Retention is off by default because deleting notes you never asked to expire is
worse than keeping them. Archive-sweep is on because archiving is the normal way
a thread stops being live. Notes are always deleted when a thread is deleted.

## How notes stay out of the agent's context

This is the plugin's main invariant, so it is enforced by omission rather than
by filtering:

- No `bb.agents` tool and no `contributeInstructions` — the only two APIs that
  put plugin content into a turn.
- No `skills/` directory. `bb plugin new` scaffolds one; it was deleted,
  because a shipped skill *is* agent context.
- Note bodies live only in this plugin's own `data.db`, never in bb.db's event
  log.

One deliberate exception: registering the `bb note` CLI command makes
*note-taking* discoverable to agents through bb's generated `plugin-commands`
skill. Note contents still never enter a model's context, but an agent can write
notes. To keep that visible, CLI-created notes are stored with role `cli` and
the panel labels them **"via bb note"** instead of "You".

`server.test.ts` asserts all of this (`describe("agent isolation")`).

## Architecture

Four extension points:

| Point | Purpose |
| --- | --- |
| `app.slots.messageAction` | The "Add note" button; captures *which* message |
| `app.slots.threadPanelAction` | The Notes tab; captures the text and lists notes |
| `bb.rpc` | Panel reads and writes |
| `bb.http.route("POST", "/compose")` | The message action's only route to the backend |

### Why there is an HTTP route

`messageAction.run` is a plain callback, not a React component, and the only rpc
client is the `useRpc` **hook**. So `run` cannot call rpc. It posts the anchor to
`/compose` instead, which stores it as a pending draft; the panel then reads that
draft and asks for the text.

If bb ever gives registration callbacks an rpc client, this route can be deleted
and nothing else changes.

### Why `openPanel` is called before the `await`

`openPanel` is a synchronous method on a host-supplied context object. Calling it
first avoids depending on that context still being valid after a suspension.

It is deliberately called with **no params**: bb refocuses an existing tab for
identical `actionId` + `params`, but opens *sibling* tabs for different params.
Passing the anchor through params would open a new Notes tab per annotated
message. The anchor travels through `/compose` for exactly this reason.

### Why both a fetch and a realtime signal

They cover opposite races. A freshly mounted panel may call `list` before
`/compose` finishes writing the draft — the realtime signal arrives after and
reconciles it. An already-open panel would never re-read on its own — the signal
is the only thing that tells it.

`bb.realtime.publish` broadcasts to *every* connected client with no thread
scoping, so each payload carries `threadId` and the panel filters on it.

## The anchor: `sourceSeqEnd`, not `message.id`

Notes are keyed on `(threadId, sourceSeqEnd)`. This matters, and the obvious
alternative is a trap.

`message.id` maps to the event store's `item_id`, which looks like
`claude-assistant-1`. **That counter resets every turn.** Observed in a live
`bb.db`, same thread, same provider session:

```
sequence  turn_id                  item_id
13        turn_377ea9406b0348d8_1  claude-assistant-1
...
176       turn_50a0f3d777d44e7f_1  claude-assistant-1   <-- reused
```

Keying on `message.id` would make a note silently reappear on an unrelated
message a few turns later.

`sourceSeqEnd` is backed by a unique index on `(thread_id, sequence)`, assigned
server-side, append-only, and already trusted by bb itself as the anchor for
provider-history forks. It survives reload, resume, and restore.

It is also on `TimelineRowBase`, the base of *every* timeline row kind including
tool rows — so if bb ever extends message actions to tool output, or ships a
per-item render slot, those are read-path changes with **no migration**.

## Storage

Plugin-owned SQLite at `~/.bb/plugins/session-notes/data.db`.

```sql
CREATE TABLE notes (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL,
  source_seq_end INTEGER NOT NULL,
  message_role   TEXT NOT NULL,   -- "user" | "assistant" | "cli"
  anchor_preview TEXT NOT NULL,
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX notes_thread_seq_idx ON notes (thread_id, source_seq_end);
```

`bb.storage.migrate` uses **array index as migration id**. The `MIGRATIONS` array
in `server.ts` is append-only: never reorder or edit a statement that has
shipped, only push new ones.

Two deliberate choices:

- **No unique constraint on `(thread_id, source_seq_end)`.** Several notes per
  message are allowed. Editing is a non-goal, so enforcing one note per message
  would mean silently destroying the first one.
- **`anchor_preview` and `message_role` are denormalized snapshots.** They
  duplicate timeline data on purpose: the panel renders without a second read,
  and if bb's completed-item truncation ever removes an event, the note still
  displays the text it was attached to instead of a bare integer.
- **The anchor preview is rendered as plain text, not markdown**, even though
  note bodies are markdown. It is a whitespace-collapsed 140-character
  *fragment* of someone else's message, so a stray leading `#` or `-` would
  render as a heading or list item. That reasoning applies to fragments only,
  not to a note body you authored deliberately.

## Known limits

- **Notes are not inline.** They render in a side panel, not attached to the
  message in the timeline. `PluginAppSlots` has no per-item render slot;
  `messageDirective` only activates on `::directive{}` text the *model* emitted,
  and there is no API to modify timeline content. The only way to do it anyway is
  DOM injection from a content script, which was rejected as unmaintainable
  against a pre-1.0 UI.
- **User and assistant messages only.** `messageAction`'s context types `role` as
  `"user" | "assistant"` and documents its payload as "NOT an internal timeline
  row", so tool calls and tool results cannot carry a note. `bb note add --seq`
  is the manual escape hatch.
- **No sub-item anchoring.** `selectedText` on the action context would make
  character-range notes plausible for assistant text later, but not for tool
  output.

## API notes (bb 0.38 / plugin SDK 0.4.6)

Things that cost a build cycle and are not in the authoring skill:

- `bb.http.route` paths **require a leading slash** (`"/compose"`), though the
  skill's example omits it. Without it the plugin fails to load.
- Route handlers must return via the Hono context (`context.json(...)`). A bare
  `Response.json(...)` is rejected with "http route handler must return a
  Response".
- Plugin settings have **no numeric type** — only `string`, `boolean`, `select`,
  `project`. Hence `retentionDays` is a select of day counts.
- `@get-bb/plugin-sdk/testing` needs `cron-parser` installed alongside it; it is
  not declared as a dependency.

## Development

```
npm install --include=dev
npm test          # vitest against createFakePluginHost — no server needed
npm run typecheck
npm run build     # bb plugin build .
bb plugin reload session-notes
```

The test suite drives the two paths that are awkward to check by hand against a
live bb: the retention schedule (normally hourly cron) via `harness.runSchedule`,
and archive/delete sweeps via `harness.emitThreadEvent`.

`bb plugin dev .` watches sources and reloads on change.
