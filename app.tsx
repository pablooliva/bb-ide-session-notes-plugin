// Session Notes — frontend.
//
// Two slots: a message action that captures WHICH message you clicked, and a
// thread panel that asks for the text and lists what you've written.
//
// The split exists because `messageAction.run` is a plain callback with no rpc
// client (`useRpc` is a hook), so it cannot talk to the backend directly. It
// posts the anchor to the plugin's own HTTP route instead.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  Markdown,
  useRealtime,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { BODY_MAX, PLUGIN_ID, SIGNAL_CHANNEL } from "./shared";

const PANEL_ID = "notes";

/** Trim before POSTing; the backend clamps again to its own preview length. */
const PREVIEW_SEND_MAX = 400;

interface Note {
  id: string;
  sourceSeqEnd: number;
  messageRole: string;
  anchorPreview: string;
  body: string;
  createdAt: number;
}

interface Draft {
  sourceSeqEnd: number;
  messageRole: string;
  anchorPreview: string;
}

// Realtime is a global broadcast — every client gets every plugin signal — so
// the panel filters on the threadId the payload carries.
function isSignalForThread(payload: unknown, threadId: string): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { threadId?: unknown }).threadId === threadId
  );
}

// "cli" marks a note written by `bb note` rather than by you in the panel.
// Since agents can invoke that command, provenance stays visible.
function roleLabel(role: string): string {
  if (role === "user") return "You";
  if (role === "cli") return "via bb note";
  return "Agent";
}

// Styling uses the host's own theme custom properties rather than a bundled
// CSS framework, so notes follow light/dark without a build step.
const styles = {
  page: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  intro: { fontSize: "0.75rem", color: "var(--muted-foreground)", margin: 0 },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.75rem" },
  anchor: {
    fontSize: "0.75rem",
    color: "var(--muted-foreground)",
    borderLeft: "2px solid var(--border)",
    paddingLeft: "0.5rem",
    marginBottom: "0.25rem",
  },
  role: { fontWeight: 600, marginRight: "0.375rem" },
  // Note bodies render through the host's chat markdown renderer, so they no
  // longer read as distinct from agent output typographically. The accented
  // left rule, card background, and role label carry that distinction instead.
  note: {
    borderLeft: "3px solid var(--accent-foreground, var(--foreground))",
    background: "var(--card)",
    borderRadius: "var(--radius)",
    padding: "0.5rem 0.625rem",
    cursor: "pointer",
    wordBreak: "break-word",
  },
  input: {
    width: "100%",
    minHeight: "4.5rem",
    resize: "vertical",
    background: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "0.5rem 0.625rem",
    font: "inherit",
    lineHeight: 1.5,
  },
  hint: { fontSize: "0.6875rem", color: "var(--muted-foreground)", marginTop: "0.25rem" },
  deleteRow: { marginTop: "0.375rem" },
  deleteButton: {
    font: "inherit",
    fontSize: "0.75rem",
    color: "var(--destructive)",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "0.125rem 0.5rem",
    cursor: "pointer",
  },
  empty: { fontSize: "0.8125rem", color: "var(--muted-foreground)" },
  error: { fontSize: "0.75rem", color: "var(--destructive)" },
} as const;

function NotesPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("list", { threadId });
      setNotes(result.notes);
      setDraft(result.draft);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load notes.");
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Covers the case where the panel was already open when you clicked
  // "Add note" on another message.
  useRealtime(SIGNAL_CHANNEL, (payload) => {
    if (isSignalForThread(payload, threadId)) void refresh();
  });

  useEffect(() => {
    if (!draft) return;
    inputRef.current?.focus();
    inputRef.current?.scrollIntoView({ block: "nearest" });
  }, [draft]);

  const save = async () => {
    const body = text.trim();
    if (body.length === 0) return;
    setText("");
    try {
      await rpc.call("create", { threadId, body });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the note.");
    }
  };

  const discard = async () => {
    setText("");
    try {
      await rpc.call("discardDraft", { threadId });
      await refresh();
    } catch {
      // Losing a discard is harmless — the draft is re-offered on next open.
    }
  };

  const remove = async (id: string) => {
    setSelectedId(null);
    try {
      await rpc.call("remove", { threadId, id });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the note.");
    }
  };

  const anchorLine = (role: string, preview: string) => (
    <div style={styles.anchor}>
      <span style={styles.role}>{roleLabel(role)}</span>
      {preview}
    </div>
  );

  // Notes sort by their anchor, so reading the panel top-to-bottom walks the
  // thread in order. The draft slots into the same ordering.
  const draftIndex = draft
    ? notes.filter((note) => note.sourceSeqEnd <= draft.sourceSeqEnd).length
    : -1;

  const rows = notes.map((note) => (
    <li key={note.id}>
      {anchorLine(note.messageRole, note.anchorPreview)}
      <div
        style={styles.note}
        onClick={(event) => {
          // Rendered markdown can contain links; clicking one should follow it
          // rather than also toggling the delete button.
          if ((event.target as HTMLElement).closest("a")) return;
          setSelectedId(selectedId === note.id ? null : note.id);
        }}
      >
        <Markdown content={note.body} />
      </div>
      {selectedId === note.id && (
        <div style={styles.deleteRow}>
          <button type="button" style={styles.deleteButton} onClick={() => void remove(note.id)}>
            Delete note
          </button>
        </div>
      )}
    </li>
  ));

  if (draft) {
    rows.splice(
      draftIndex,
      0,
      <li key="draft">
        {anchorLine(draft.messageRole, draft.anchorPreview)}
        <textarea
          ref={inputRef}
          style={styles.input}
          value={text}
          maxLength={BODY_MAX}
          placeholder="Your note… (markdown)"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter inserts a newline so lists and fenced code can be typed;
            // saving moves to the modifier chord.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              void discard();
            }
          }}
        />
        <div style={styles.hint}>⌘/Ctrl + Enter to save · Esc to discard</div>
      </li>,
    );
  }

  return (
    <div style={styles.page}>
      <p style={styles.intro}>
        Private to you. Notes are never sent to the agent, and are deleted with the thread.
      </p>
      {error && <div style={styles.error}>{error}</div>}
      {rows.length === 0 ? (
        <div style={styles.empty}>
          No notes yet. Use <strong>Add note</strong> on any message to annotate it.
        </div>
      ) : (
        <ul style={styles.list}>{rows}</ul>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "add-note",
    title: "Add note",
    icon: "MessageSquarePlus",
    run: ({ threadId, message, openPanel }) => {
      // Open the panel FIRST, synchronously. `openPanel` is a method on a
      // host-supplied context; calling it before any await avoids depending on
      // that context surviving a suspension. Passing no params means one Notes
      // tab per thread — distinct params would open sibling tabs.
      openPanel({ actionId: PANEL_ID, title: "Notes" });

      // `run` has no rpc client, so the anchor goes through the plugin's own
      // HTTP route. "local" auth requires the JSON content-type on non-GET.
      void fetch(`/api/v1/plugins/${PLUGIN_ID}/http/compose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          sourceSeqEnd: message.sourceSeqEnd,
          messageRole: message.role,
          anchorPreview: message.text.slice(0, PREVIEW_SEND_MAX),
        }),
      }).catch(() => {
        // The panel is already open; a failed handoff just shows no draft.
      });
    },
  });

  app.slots.threadPanelAction({
    id: PANEL_ID,
    title: "Notes",
    icon: "FileText",
    component: NotesPanel,
    layout: "padded",
  });
});
