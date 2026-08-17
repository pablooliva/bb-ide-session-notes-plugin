// Constants used by BOTH server.ts and app.tsx.
//
// Keep this module free of imports. app.tsx may only import *types* from
// server.ts (the backend and its dependencies are erased from the frontend
// bundle), so any runtime value both sides need lives here instead.

/** Matches the installed plugin id — `bb-plugin-session-notes` minus the prefix. */
export const PLUGIN_ID = "session-notes";

/** Realtime channel for "this thread's notes changed" signals. */
export const SIGNAL_CHANNEL = "notes";

/**
 * Longest note body we store. Roomy enough for a short list or a fenced code
 * block now that notes accept multi-line markdown, while still keeping a note
 * a note rather than a document.
 */
export const BODY_MAX = 2000;
