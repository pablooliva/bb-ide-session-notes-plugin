// Unit tests for the Session Notes backend.
//
// These run against `createFakePluginHost`, an in-process stand-in for BB's
// plugin runtime — no server, no bb.db. It gives us the two things that are
// awkward to check by hand against a live bb: the retention schedule (normally
// hourly cron) and thread lifecycle events (normally requires archiving a real
// thread).
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const THREAD = "thr_test";
const OTHER = "thr_other";
const DAY_MS = 86_400_000;

interface ListResult {
  notes: Array<{
    id: string;
    sourceSeqEnd: number;
    messageRole: string;
    anchorPreview: string;
    body: string;
  }>;
  draft: { sourceSeqEnd: number; messageRole: string; anchorPreview: string } | null;
}

// A couple of timeline rows for `bb note add` to anchor against. Only
// sourceSeqEnd and text are read by the plugin.
const TIMELINE_ROWS = [
  { id: "row-1", threadId: THREAD, sourceSeqEnd: 10, text: "an early message" },
  { id: "row-2", threadId: THREAD, sourceSeqEnd: 40, text: "the latest message" },
];

function load(options: CreateFakePluginHostOptions = {}) {
  const host = createFakePluginHost({
    pluginId: "session-notes",
    sdk: { threads: { timeline: async () => ({ rows: TIMELINE_ROWS }) } },
    ...options,
  });
  plugin(host.bb);
  return host;
}

/** Drive the real capture path: message action posts an anchor, panel saves. */
async function addViaPanel(
  harness: ReturnType<typeof load>["harness"],
  anchor: { threadId?: string; sourceSeqEnd: number; messageRole: string; anchorPreview: string },
  body: string,
) {
  const threadId = anchor.threadId ?? THREAD;
  await harness.fetchHttp("POST", "/compose", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...anchor, threadId }),
  });
  return harness.callRpc("create", { threadId, body });
}

const list = (harness: ReturnType<typeof load>["harness"], threadId = THREAD) =>
  harness.callRpc("list", { threadId }) as Promise<ListResult>;

describe("capture", () => {
  it("stores a note against the anchor the compose route recorded", async () => {
    const { harness } = load();
    await addViaPanel(
      harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "the latest message" },
      "my note",
    );

    const { notes, draft } = await list(harness);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ sourceSeqEnd: 40, messageRole: "assistant", body: "my note" });
    // Saving consumes the draft, so the panel stops showing an input.
    expect(draft).toBeNull();
  });

  it("collapses whitespace and clamps the anchor preview", async () => {
    const { harness } = load();
    await harness.fetchHttp("POST", "/compose", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: THREAD,
        sourceSeqEnd: 40,
        messageRole: "assistant",
        anchorPreview: `  lots\n\n of   ${"x".repeat(400)}  `,
      }),
    });

    const { draft } = await list(harness);
    expect(draft?.anchorPreview.startsWith("lots of ")).toBe(true);
    expect(draft?.anchorPreview.length).toBeLessThanOrEqual(140);
  });

  it("refuses to create without a draft, so a note cannot land on an unclicked message", async () => {
    const { harness } = load();
    await expect(harness.callRpc("create", { threadId: THREAD, body: "orphan" })).resolves.toEqual({
      created: false,
    });
    expect((await list(harness)).notes).toHaveLength(0);
  });

  it("refuses an empty body and keeps the draft for another try", async () => {
    const { harness } = load();
    const anchor = { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" };
    await expect(addViaPanel(harness, anchor, "   ")).resolves.toEqual({ created: false });

    const { notes, draft } = await list(harness);
    expect(notes).toHaveLength(0);
    expect(draft).not.toBeNull();
  });

  it("rejects a malformed compose body with 400", async () => {
    const { harness } = load();
    const response = await harness.fetchHttp("POST", "/compose", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: THREAD }),
    });
    expect(response.status).toBe(400);
  });

  it("allows several notes on one message", async () => {
    const { harness } = load();
    const anchor = { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "same message" };
    await addViaPanel(harness, anchor, "first thought");
    await addViaPanel(harness, anchor, "second thought");

    expect((await list(harness)).notes.map((note) => note.body)).toEqual([
      "first thought",
      "second thought",
    ]);
  });

  it("orders notes by anchor so the panel reads in timeline order", async () => {
    const { harness } = load();
    await addViaPanel(
      harness,
      { sourceSeqEnd: 90, messageRole: "assistant", anchorPreview: "late" },
      "late note",
    );
    await addViaPanel(
      harness,
      { sourceSeqEnd: 10, messageRole: "user", anchorPreview: "early" },
      "early note",
    );

    expect((await list(harness)).notes.map((note) => note.body)).toEqual([
      "early note",
      "late note",
    ]);
  });
});

describe("edit", () => {
  async function seed() {
    const { harness } = load();
    await addViaPanel(
      harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" },
      "original",
    );
    const [note] = (await list(harness)).notes;
    return { harness, note };
  }

  it("rewrites the body and leaves the anchor alone", async () => {
    const { harness, note } = await seed();
    await expect(
      harness.callRpc("update", { threadId: THREAD, id: note.id, body: "revised" }),
    ).resolves.toEqual({ updated: true });

    const { notes } = await list(harness);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: note.id,
      body: "revised",
      sourceSeqEnd: 40,
      messageRole: "assistant",
      anchorPreview: "x",
    });
  });

  it("refuses an edit addressed to the wrong thread", async () => {
    const { harness, note } = await seed();
    await expect(
      harness.callRpc("update", { threadId: OTHER, id: note.id, body: "hijacked" }),
    ).resolves.toEqual({ updated: false });
    expect((await list(harness)).notes[0].body).toBe("original");
  });

  it("refuses an empty body rather than blanking the note", async () => {
    const { harness, note } = await seed();
    await expect(
      harness.callRpc("update", { threadId: THREAD, id: note.id, body: "   " }),
    ).resolves.toEqual({ updated: false });
    expect((await list(harness)).notes[0].body).toBe("original");
  });

  it("reports a missing id instead of silently succeeding", async () => {
    const { harness } = await seed();
    await expect(
      harness.callRpc("update", { threadId: THREAD, id: "nope", body: "x" }),
    ).resolves.toEqual({ updated: false });
  });

  it("signals so other open panels refresh", async () => {
    const { harness, note } = await seed();
    const before = harness.inspection.realtimeSignals.length;
    await harness.callRpc("update", { threadId: THREAD, id: note.id, body: "revised" });
    expect(harness.inspection.realtimeSignals.length).toBe(before + 1);
  });

  it("keeps markdown intact through a round trip", async () => {
    const { harness, note } = await seed();
    const body = "- one\n- two\n\n```ts\nconst x = 1;\n```";
    await harness.callRpc("update", { threadId: THREAD, id: note.id, body });
    expect((await list(harness)).notes[0].body).toBe(body);
  });
});

describe("delete", () => {
  it("removes a note and refuses a delete addressed to the wrong thread", async () => {
    const { harness } = load();
    await addViaPanel(
      harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" },
      "note",
    );
    const [note] = (await list(harness)).notes;

    await expect(harness.callRpc("remove", { threadId: OTHER, id: note.id })).resolves.toEqual({
      removed: false,
    });
    await expect(harness.callRpc("remove", { threadId: THREAD, id: note.id })).resolves.toEqual({
      removed: true,
    });
    expect((await list(harness)).notes).toHaveLength(0);
  });
});

describe("bb note CLI", () => {
  it("anchors to the end of the thread by default", async () => {
    const { harness } = load();
    const result = await harness.runCli(["add", "a", "marker"], { threadId: THREAD });

    expect(result.exitCode).toBe(0);
    const { notes } = await list(harness);
    expect(notes[0]).toMatchObject({
      sourceSeqEnd: 40,
      anchorPreview: "the latest message",
      body: "a marker",
    });
  });

  it("tags CLI notes as 'cli' so agent-written markers stay distinguishable", async () => {
    const { harness } = load();
    await harness.runCli(["add", "written by a script"], { threadId: THREAD });
    expect((await list(harness)).notes[0].messageRole).toBe("cli");
  });

  it("honors an explicit --seq and previews the row it lands on", async () => {
    const { harness } = load();
    await harness.runCli(["add", "early", "marker", "--seq", "10"], { threadId: THREAD });

    expect((await list(harness)).notes[0]).toMatchObject({
      sourceSeqEnd: 10,
      anchorPreview: "an early message",
      body: "early marker",
    });
  });

  it("rejects a non-integer --seq", async () => {
    const { harness } = load();
    const result = await harness.runCli(["add", "x", "--seq", "abc"], { threadId: THREAD });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("integer");
  });

  it("needs a thread", async () => {
    const { harness } = load();
    const result = await harness.runCli(["add", "x"], {});
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("needs a thread");
  });

  it("prints usage for no subcommand, and errors on an unknown one", async () => {
    const { harness } = load();
    await expect(harness.runCli([], { threadId: THREAD })).resolves.toMatchObject({ exitCode: 2 });
    const unknown = await harness.runCli(["frobnicate"], { threadId: THREAD });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("Unknown subcommand");
  });

  it("lists and removes, and reports a missing id with exit 1", async () => {
    const { harness } = load();
    await harness.runCli(["add", "hello"], { threadId: THREAD });
    const [note] = (await list(harness)).notes;

    const listed = await harness.runCli(["list"], { threadId: THREAD });
    expect(listed.stdout).toContain(note.id);
    expect(listed.stdout).toContain("hello");

    await expect(harness.runCli(["rm", "nope"], { threadId: THREAD })).resolves.toMatchObject({
      exitCode: 1,
    });
    await expect(harness.runCli(["rm", note.id], { threadId: THREAD })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect((await list(harness)).notes).toHaveLength(0);
  });

  it("reports an empty thread rather than failing", async () => {
    const { harness } = load();
    const result = await harness.runCli(["list"], { threadId: THREAD });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No notes");
  });
});

describe("ephemerality", () => {
  /** Age every stored note by writing created_at directly. */
  function backdate(host: ReturnType<typeof load>, days: number) {
    host.bb.storage
      .database()
      .prepare(`UPDATE notes SET created_at = ?`)
      .run(Date.now() - days * DAY_MS);
  }

  it("clears a thread's notes when the thread is deleted", async () => {
    const host = load();
    await addViaPanel(
      host.harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" },
      "note",
    );

    await host.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: THREAD }),
    });
    expect((await list(host.harness)).notes).toHaveLength(0);
  });

  it("clears notes on archive by default", async () => {
    const host = load();
    await addViaPanel(
      host.harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" },
      "note",
    );

    const { errors } = await host.harness.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: THREAD }),
    });
    expect(errors).toHaveLength(0);
    expect((await list(host.harness)).notes).toHaveLength(0);
  });

  it("keeps notes on archive when sweepOnArchive is off", async () => {
    const host = load({ settings: { sweepOnArchive: false } });
    await addViaPanel(
      host.harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" },
      "note",
    );

    await host.harness.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: THREAD }),
    });
    expect((await list(host.harness)).notes).toHaveLength(1);
  });

  it("only sweeps the thread that ended", async () => {
    const host = load();
    await addViaPanel(
      host.harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" },
      "keep me",
    );
    await addViaPanel(
      host.harness,
      { threadId: OTHER, sourceSeqEnd: 5, messageRole: "user", anchorPreview: "y" },
      "delete me",
    );

    await host.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: OTHER }),
    });
    expect((await list(host.harness)).notes.map((note) => note.body)).toEqual(["keep me"]);
    expect((await list(host.harness, OTHER)).notes).toHaveLength(0);
  });

  it("keeps everything while retention is off, however old", async () => {
    const host = load();
    await addViaPanel(
      host.harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" },
      "ancient",
    );
    backdate(host, 400);

    await host.harness.runSchedule("retention-sweep");
    expect((await list(host.harness)).notes).toHaveLength(1);
  });

  it("deletes only notes past the retention window", async () => {
    const host = load({ settings: { retentionDays: "7" } });
    await addViaPanel(
      host.harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" },
      "old",
    );
    backdate(host, 10);
    await addViaPanel(
      host.harness,
      { sourceSeqEnd: 10, messageRole: "user", anchorPreview: "y" },
      "recent",
    );

    await host.harness.runSchedule("retention-sweep");
    expect((await list(host.harness)).notes.map((note) => note.body)).toEqual(["recent"]);
  });
});

describe("agent isolation", () => {
  it("registers nothing that puts note content into a model's context", () => {
    const { harness } = load();
    const { registrations } = harness.inspection;

    // The two APIs that inject plugin content into a turn.
    expect(registrations.agentTools).toHaveLength(0);
    expect(registrations.instructionProvider).toBeNull();
    expect(registrations.agentConfigurationProvider).toBeNull();
  });

  it("exposes exactly one CLI command, whose subcommands are the documented three", () => {
    const { harness } = load();
    const cli = harness.inspection.registrations.cli;

    expect(cli?.name).toBe("note");
    expect(cli?.commands.map((command) => command.name)).toEqual(["add", "list", "rm"]);
  });
});

describe("realtime", () => {
  it("signals the owning thread on every mutation so an open panel refreshes", async () => {
    const { harness } = load();
    await addViaPanel(
      harness,
      { sourceSeqEnd: 40, messageRole: "assistant", anchorPreview: "x" },
      "note",
    );

    const signals = harness.inspection.realtimeSignals;
    expect(signals.length).toBeGreaterThanOrEqual(2); // compose + create
    expect(signals.every((entry) => entry.channel === "notes")).toBe(true);
    expect(signals.every((entry) => (entry.payload as { threadId: string }).threadId === THREAD)).toBe(
      true,
    );
  });
});
