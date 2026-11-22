import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadSources, stubIO } from "./fixtures/runtime.mjs";

const sources = loadSources({
  audit: "/src/components/Workspace/AuditReport.tsx",
  bridge: "/src/services/tauri/bridge.ts",
});

function renderReport(status, fields = {}) {
  const report = { status, total_rows: 0, hashed_rows: 0, legacy_rows: 0, first_break: null, recent: [], ...fields };
  return renderToStaticMarkup(createElement(sources.audit.AuditReport, { report }));
}

function assertStatus(html, toneClass, title, detail) {
  assert.match(html, new RegExp(`class="audit-result ${toneClass}"`));
  assert.match(html, /role="status"/);
  assert.match(html, title);
  assert.match(html, detail);
}

function tableRows(html) {
  const rows = [];
  for (const [, body] of html.matchAll(/<tbody\b[^>]*>(.*?)<\/tbody>/gs)) {
    for (const [, row] of body.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs)) {
      rows.push([...row.matchAll(/<td\b[^>]*>(.*?)<\/td>/gs)].map(([, cell]) => cell.replace(/<[^>]*>/g, "")));
    }
  }
  return rows;
}

test("missing, empty, and unreadable logs explain why nothing was verified without showing success", () => {
  for (const [status, tone, title, detail] of [
    ["missing", "neutral", /no audit log found/i, /no log file to verify/i],
    ["empty", "neutral", /the audit log is empty/i, /file exists, but it has no entries to check/i],
    ["unreadable", "invalid", /audit verification unavailable/i, /couldn’t read the log for verification/i],
  ]) {
    const html = renderReport(status);
    assertStatus(html, tone, title, detail);
    assert.doesNotMatch(html, /is consistent|verification summary|recent activity|none found/i, status);
  }
});

test("legacy-only entries are counted but not presented as verified activity", () => {
  const html = renderReport("legacy_only", { total_rows: 4, legacy_rows: 4 });
  assertStatus(html, "neutral", /no chained entries to verify/i, /older entries without hashes can’t be verified/i);
  const [summary, ...activity] = tableRows(html);
  assert.deepEqual(summary?.slice(0, 3), ["4", "0", "4"]);
  assert.deepEqual(activity, []);
  assert.doesNotMatch(html, /is consistent|recent activity/i);
});

test("a broken chain names the first corrupt record and suppresses supplied recent activity", () => {
  const html = renderReport("broken", {
    total_rows: 19, hashed_rows: 15, legacy_rows: 2, first_break: 17,
    recent: [{ record: 16, tool: "read_file", outcome: "completed", timestamp: null }],
  });
  assertStatus(html, "invalid", /audit chain check failed/i, /first break is at record 17\./i);
  assert.deepEqual(tableRows(html), [["19", "15", "2", "17"]]);
  assert.doesNotMatch(html, /recent activity|read file|is consistent|none found/i);
});

test("a consistent chain renders only the allowed activity columns in the supplied order", () => {
  const html = renderReport("consistent", {
    total_rows: 12, hashed_rows: 9, legacy_rows: 3,
    // Deliberately out of record and timestamp order to catch re-sorting in the renderer.
    recent: [
      {
        record: 8, tool: "execute_shell", outcome: "timeout", timestamp: "2026-02-03T04:05:06Z",
        command: "FIXTURE_PRIVATE_COMMAND", path: "/fixture/FIXTURE_PRIVATE_PATH", cwd: "/fixture/FIXTURE_PRIVATE_CWD",
        content: "FIXTURE_PRIVATE_CONTENT", stdout: "FIXTURE_PRIVATE_STDOUT", error: "FIXTURE_PRIVATE_ERROR",
        hash: "FIXTURE_PRIVATE_HASH",
      },
      { record: 11, tool: "write_file", outcome: "rejected", timestamp: null },
      { record: 4, tool: "delegate_task", outcome: "completed", timestamp: "2026-02-03T05:06:07Z" },
    ],
  });
  assertStatus(html, "consistent", /local hash chain is consistent/i, /9 chained entries checked with SHA-256.*older entries without hashes aren’t verified/i);
  assert.match(html, /Recent activity/);
  assert.deepEqual(tableRows(html), [
    ["12", "9", "3", "None found"],
    ["8", "Run command", "Timed out", "2026-02-03 04:05:06"],
    ["11", "Write file", "Declined", "—"],
    ["4", "Delegate task", "Completed", "2026-02-03 05:06:07"],
  ]);
  assert.doesNotMatch(html, /FIXTURE_PRIVATE_/);
});

function fixtureWindow(t, { desktop = true } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const win = new EventTarget();
  if (desktop) win.__TAURI_INTERNALS__ = {};
  Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  });
  return win;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("desktop subscribes before checking for a sticky startup recording failure", async (t) => {
  fixtureWindow(t);
  const registration = deferred();
  const bridge = stubIO(t, sources.bridge.TauriBridge, { native: {
    onAuditRecordingFailed: () => registration.promise,
    hasAuditRecordingFailure: async () => true,
  } });
  const onFailure = t.mock.fn();
  const stop = sources.bridge.observeAuditRecordingFailure(onFailure);
  try {
    await settle();
    assert.equal(bridge.onAuditRecordingFailed.mock.callCount(), 1);
    assert.equal(bridge.hasAuditRecordingFailure.mock.callCount(), 0, "Do not read before the listener is attached");
    assert.equal(onFailure.mock.callCount(), 0);

    registration.resolve(() => {});
    await settle();
    assert.equal(bridge.hasAuditRecordingFailure.mock.callCount(), 1);
    assert.equal(onFailure.mock.callCount(), 1, "An earlier failure still warns without a live event");
  } finally {
    stop();
  }
});

test("a live failure warns before the snapshot returns and repeated signals only warn once", async (t) => {
  fixtureWindow(t);
  const snapshot = deferred();
  const unlisten = t.mock.fn();
  let deliverFailure;
  const bridge = stubIO(t, sources.bridge.TauriBridge, { native: {
    onAuditRecordingFailed: async (handler) => { deliverFailure = handler; return unlisten; },
    hasAuditRecordingFailure: () => snapshot.promise,
  } });
  const onFailure = t.mock.fn();
  const stop = sources.bridge.observeAuditRecordingFailure(onFailure);
  try {
    await settle();
    assert.equal(bridge.hasAuditRecordingFailure.mock.callCount(), 1, "The snapshot is in flight");
    assert.equal(onFailure.mock.callCount(), 0);
    deliverFailure();
    assert.equal(onFailure.mock.callCount(), 1);

    deliverFailure();
    snapshot.resolve(true);
    await settle();
    assert.equal(onFailure.mock.callCount(), 1);
  } finally {
    stop();
  }
  assert.equal(unlisten.mock.callCount(), 1);
});

test("cleanup before registration resolves unsubscribes the late listener without checking or warning", async (t) => {
  const win = fixtureWindow(t);
  const registration = deferred();
  const unlisten = t.mock.fn();
  let deliverFailure;
  const bridge = stubIO(t, sources.bridge.TauriBridge, { native: {
    onAuditRecordingFailed: (handler) => { deliverFailure = handler; return registration.promise; },
  } });
  const onFailure = t.mock.fn();
  const stop = sources.bridge.observeAuditRecordingFailure(onFailure);
  stop();
  registration.resolve(unlisten);
  await settle();

  assert.equal(unlisten.mock.callCount(), 1);
  deliverFailure(); // Simulate a callback that was already queued at teardown.
  win.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(bridge.hasAuditRecordingFailure.mock.callCount(), 0);
  assert.equal(onFailure.mock.callCount(), 0);
});

test("browser preview never calls the native bridge, even on focus", async (t) => {
  const win = fixtureWindow(t, { desktop: false });
  stubIO(t, sources.bridge.TauriBridge);
  const onFailure = t.mock.fn();
  const stop = sources.bridge.observeAuditRecordingFailure(onFailure);
  try {
    win.dispatchEvent(new Event("focus"));
    await settle();
    assert.equal(onFailure.mock.callCount(), 0);
  } finally {
    stop();
  }
});

test("a rejected listener registration still permits snapshot checks at startup and on focus", async (t) => {
  const win = fixtureWindow(t);
  let failed = false;
  const bridge = stubIO(t, sources.bridge.TauriBridge, { native: {
    onAuditRecordingFailed: async () => { throw new Error("Fixture listener unavailable"); },
    hasAuditRecordingFailure: async () => failed,
  } });
  const onFailure = t.mock.fn();
  const stop = sources.bridge.observeAuditRecordingFailure(onFailure);
  try {
    await settle();
    assert.equal(bridge.hasAuditRecordingFailure.mock.callCount(), 1);
    assert.equal(onFailure.mock.callCount(), 0, "A healthy snapshot does not warn");

    failed = true;
    win.dispatchEvent(new Event("focus"));
    await settle();
    assert.equal(bridge.hasAuditRecordingFailure.mock.callCount(), 2);
    assert.equal(onFailure.mock.callCount(), 1);
  } finally {
    stop();
  }
});
