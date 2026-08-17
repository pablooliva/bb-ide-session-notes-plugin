// Session Notes — private, thread-scoped annotations on timeline messages.
//
// These notes are a reading aid for the user, not input for the agent. That is
// enforced by what this plugin deliberately does NOT register:
//   - no `bb.agents` tool and no `contributeInstructions` (the only two APIs
//     that put plugin content into a model's context);
//   - no `skills/` directory (a shipped skill IS agent context);
//   - no `bb.cli` command (plugin commands are advertised to agents through
//     the generated `plugin-commands` skill).
// Note bodies live only in this plugin's own data.db, never in bb.db's events.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BODY_MAX, SIGNAL_CHANNEL } from "./shared";

// Append-only: the array index IS the migration id. Never reorder or edit a
// statement that has already shipped — only push new ones onto the end.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS notes (
     id             TEXT PRIMARY KEY,
     thread_id      TEXT NOT NULL,
     source_seq_end INTEGER NOT NULL,
     message_role   TEXT NOT NULL,
     anchor_preview TEXT NOT NULL,
     body           TEXT NOT NULL,
     created_at     INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS notes_thread_seq_idx ON notes (thread_id, source_seq_end)`,
];

const PREVIEW_MAX = 140;

const noteSchema = z.object({
  id: z.string(),
  sourceSeqEnd: z.number().int(),
  messageRole: z.string(),
  anchorPreview: z.string(),
  body: z.string(),
  createdAt: z.number().int(),
});

// The anchor captured by the message action, waiting for the user to type.
const draftSchema = z.object({
  sourceSeqEnd: z.number().int(),
  messageRole: z.string(),
  anchorPreview: z.string(),
});

type Draft = z.infer<typeof draftSchema>;

interface NoteRow {
  id: string;
  source_seq_end: number;
  message_role: string;
  anchor_preview: string;
  body: string;
  created_at: number;
}

export const rpcContract = defineRpcContract({
  list: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      notes: z.array(noteSchema),
      draft: draftSchema.nullable(),
    }),
  },
  create: {
    input: z.object({ threadId: z.string(), body: z.string() }).strict(),
    output: z.object({ created: z.boolean() }),
  },
  update: {
    input: z.object({ threadId: z.string(), id: z.string(), body: z.string() }).strict(),
    output: z.object({ updated: z.boolean() }),
  },
  remove: {
    input: z.object({ threadId: z.string(), id: z.string() }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  discardDraft: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ discarded: z.boolean() }),
  },
});

const composeBodySchema = z.object({
  threadId: z.string().min(1),
  sourceSeqEnd: z.number().int(),
  messageRole: z.string().min(1),
  anchorPreview: z.string(),
});

function clamp(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function toNote(row: NoteRow) {
  return {
    id: row.id,
    sourceSeqEnd: row.source_seq_end,
    messageRole: row.message_role,
    anchorPreview: row.anchor_preview,
    body: row.body,
    createdAt: row.created_at,
  };
}

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  // Settings have no numeric type, so retention is a select of day counts.
  // Read inside handlers rather than at load, so changes take effect without
  // a reload.
  const settings = bb.settings.define({
    sweepOnArchive: {
      type: "boolean",
      label: "Delete notes when a thread is archived",
      description: "Notes are a scratch reading aid, not a record. On by default.",
      default: true,
    },
    retentionDays: {
      type: "select",
      label: "Also delete notes older than (days)",
      description:
        "Age sweep, checked hourly. 'off' keeps a thread's notes for as long as the thread lives.",
      options: ["off", "1", "7", "30", "90"],
      default: "off",
    },
  });

  const draftKey = (threadId: string) => `pending:${threadId}`;

  const selectNotes = db.prepare(
    `SELECT id, source_seq_end, message_role, anchor_preview, body, created_at
       FROM notes WHERE thread_id = ? ORDER BY source_seq_end ASC, created_at ASC`,
  );
  const insertNote = db.prepare(
    `INSERT INTO notes
       (id, thread_id, source_seq_end, message_role, anchor_preview, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateNote = db.prepare(`UPDATE notes SET body = ? WHERE id = ? AND thread_id = ?`);
  const deleteNote = db.prepare(`DELETE FROM notes WHERE id = ? AND thread_id = ?`);
  const deleteThreadNotes = db.prepare(`DELETE FROM notes WHERE thread_id = ?`);
  const deleteOlderThan = db.prepare(`DELETE FROM notes WHERE created_at < ?`);

  const signal = (threadId: string) => {
    bb.realtime.publish(SIGNAL_CHANNEL, { threadId });
  };

  // The message action's `run` is a plain callback with no rpc client, so this
  // route is its only way to reach the backend. It records the anchor the user
  // clicked; the panel picks it up and asks for the text.
  // The leading slash is required by the host, even though the authoring doc's
  // example omits it.
  bb.http.route("POST", "/compose", async (context) => {
    const parsed = composeBodySchema.safeParse(await context.req.json());
    if (!parsed.success) {
      return context.json({ error: "invalid_compose_body" }, 400);
    }
    const { threadId, sourceSeqEnd, messageRole, anchorPreview } = parsed.data;
    const draft: Draft = {
      sourceSeqEnd,
      messageRole,
      anchorPreview: clamp(anchorPreview, PREVIEW_MAX),
    };
    await bb.storage.kv.set(draftKey(threadId), draft);
    signal(threadId);
    return context.json({ ok: true });
  });

  bb.rpc.register(rpcContract, {
    async list({ threadId }) {
      const rows = selectNotes.all(threadId) as NoteRow[];
      const draft = await bb.storage.kv.get<Draft>(draftKey(threadId));
      return { notes: rows.map(toNote), draft: draft ?? null };
    },

    // The anchor comes from the stored draft rather than the client, so a note
    // can only ever land on the message the user actually clicked.
    async create({ threadId, body }) {
      const text = body.trim();
      const draft = await bb.storage.kv.get<Draft>(draftKey(threadId));
      if (!draft || text.length === 0) return { created: false };

      insertNote.run(
        crypto.randomUUID(),
        threadId,
        draft.sourceSeqEnd,
        draft.messageRole,
        draft.anchorPreview,
        text.slice(0, BODY_MAX),
        Date.now(),
      );
      await bb.storage.kv.delete(draftKey(threadId));
      signal(threadId);
      return { created: true };
    },

    // Editing is panel-only by design; `bb note` has no edit subcommand, so a
    // script cannot rewrite a marker it dropped earlier.
    update({ threadId, id, body }) {
      const text = body.trim();
      if (text.length === 0) return { updated: false };
      // The thread_id predicate is the same guard as remove: a note can only be
      // changed from the thread that owns it.
      const updated = updateNote.run(text.slice(0, BODY_MAX), id, threadId).changes > 0;
      if (updated) signal(threadId);
      return { updated };
    },

    remove({ threadId, id }) {
      const removed = deleteNote.run(id, threadId).changes > 0;
      if (removed) signal(threadId);
      return { removed };
    },

    async discardDraft({ threadId }) {
      await bb.storage.kv.delete(draftKey(threadId));
      signal(threadId);
      return { discarded: true };
    },
  });

  const sweepThread = (threadId: string, reason: string) => {
    const removed = deleteThreadNotes.run(threadId).changes;
    void bb.storage.kv.delete(draftKey(threadId));
    if (removed > 0) bb.log.info(`swept ${removed} note(s): ${reason} ${threadId}`);
  };

  // Notes are scoped to the thread and must not outlive it.
  bb.events.on("thread.deleted", ({ thread }) => {
    sweepThread(thread.id, "deleted thread");
  });

  // Archiving is the usual way a thread stops being live, so it clears notes
  // too — opt out in settings if you archive threads you still read back.
  bb.events.on("thread.archived", async ({ thread }) => {
    const { sweepOnArchive } = await settings.get();
    if (sweepOnArchive) sweepThread(thread.id, "archived thread");
  });

  // Age-based sweep. Off by default: deleting notes the user never asked to
  // expire would be worse than keeping them.
  bb.background.schedule("retention-sweep", "17 * * * *", async () => {
    const { retentionDays } = await settings.get();
    if (retentionDays === "off") return;
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) return;
    const removed = deleteOlderThan.run(Date.now() - days * 86_400_000).changes;
    if (removed > 0) bb.log.info(`retention sweep removed ${removed} note(s) older than ${days}d`);
  });

  // ---------------------------------------------------------------------
  // `bb note` — lets scripts and hooks drop markers.
  //
  // NOTE ON VISIBILITY: registering a CLI command makes it discoverable to
  // agents through the generated `plugin-commands` skill. Note *bodies* still
  // never enter a model's context, but an agent can now write notes. Anything
  // created this way is stored with role "cli" so the panel labels its
  // provenance instead of it passing as one of your own notes.
  // ---------------------------------------------------------------------

  const resolveAnchor = async (threadId: string, seq: number | null) => {
    const { rows } = await bb.sdk.threads.timeline({ threadId });
    if (rows.length === 0) return { sourceSeqEnd: seq ?? 0, anchorPreview: "" };

    // Default anchor is the end of the thread: "a marker here, now".
    const target = seq ?? Math.max(...rows.map((row) => row.sourceSeqEnd));
    // The row the marker lands on is the last one at or before the anchor.
    const candidates = rows.filter((row) => row.sourceSeqEnd <= target);
    const row = candidates.length > 0 ? candidates[candidates.length - 1] : rows[0];
    const text = (row as { text?: unknown }).text;
    return {
      sourceSeqEnd: target,
      anchorPreview: typeof text === "string" ? text : "",
    };
  };

  const usage = [
    "Usage:",
    "  bb note add <text> [--seq <n>]   Attach a note (default anchor: end of thread)",
    "  bb note list                     List this thread's notes",
    "  bb note rm <id>                  Delete a note",
  ].join("\n");

  bb.cli.register({
    name: "note",
    summary: "Attach private, thread-scoped notes to the timeline (never sent to the model)",
    commands: [
      {
        name: "add",
        summary: "Attach a note to this thread, optionally at a specific timeline sequence",
        usage: "bb note add <text> [--seq <n>]",
      },
      { name: "list", summary: "List this thread's notes", usage: "bb note list" },
      { name: "rm", summary: "Delete a note by id", usage: "bb note rm <id>" },
    ],
    async run(argv, ctx) {
      const [subcommand, ...rest] = argv;
      if (!subcommand) return { exitCode: 2, stderr: usage };

      const threadId = ctx.threadId;
      if (!threadId) {
        return { exitCode: 2, stderr: "bb note needs a thread; run it inside one." };
      }

      if (subcommand === "add") {
        let seq: number | null = null;
        const words: string[] = [];
        for (let i = 0; i < rest.length; i += 1) {
          if (rest[i] === "--seq") {
            const raw = Number(rest[i + 1]);
            if (!Number.isInteger(raw)) {
              return { exitCode: 2, stderr: "--seq needs an integer timeline sequence." };
            }
            seq = raw;
            i += 1;
          } else {
            words.push(rest[i]);
          }
        }

        const body = words.join(" ").trim();
        if (body.length === 0) return { exitCode: 2, stderr: usage };

        const anchor = await resolveAnchor(threadId, seq);
        const id = crypto.randomUUID();
        insertNote.run(
          id,
          threadId,
          anchor.sourceSeqEnd,
          "cli",
          clamp(anchor.anchorPreview, PREVIEW_MAX),
          body.slice(0, BODY_MAX),
          Date.now(),
        );
        signal(threadId);
        return { exitCode: 0, stdout: `${id}\tseq ${anchor.sourceSeqEnd}` };
      }

      if (subcommand === "list") {
        const rows = selectNotes.all(threadId) as NoteRow[];
        if (rows.length === 0) return { exitCode: 0, stdout: "No notes in this thread." };
        return {
          exitCode: 0,
          stdout: rows
            .map((row) => `${row.id}\tseq ${row.source_seq_end}\t${row.message_role}\t${row.body}`)
            .join("\n"),
        };
      }

      if (subcommand === "rm") {
        const id = rest[0];
        if (!id) return { exitCode: 2, stderr: "bb note rm needs a note id." };
        if (deleteNote.run(id, threadId).changes === 0) {
          return { exitCode: 1, stderr: `No note ${id} in this thread.` };
        }
        signal(threadId);
        return { exitCode: 0, stdout: `Deleted ${id}` };
      }

      return { exitCode: 2, stderr: `Unknown subcommand "${subcommand}".\n${usage}` };
    },
  });
}
