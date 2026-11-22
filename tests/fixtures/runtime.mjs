import assert from "node:assert/strict";
import { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Load the real TypeScript modules without starting a dev server, watching
// files, or reading a developer's env files. A suite shares one SSR instance.
export function loadSources(paths) {
  const modules = {};
  let vite;
  before(async () => {
    vite = await createServer({
      root: fileURLToPath(new URL("../../", import.meta.url)),
      configFile: false,
      envFile: false,
      logLevel: "silent",
      appType: "custom",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null, ws: false },
    });
    // Keep a single module identity for TauriBridge and its consumers.
    for (const [name, path] of Object.entries(paths)) {
      modules[name] = await vite.ssrLoadModule(path);
    }
  });
  after(async () => { await vite?.close(); });
  return modules;
}

// Fail the test even if a production error handler catches an unexpected call.
// No test can fall through to a real fetch, CLI launch, or native tool.
export function stubIO(t, bridge, { fetch, native = {} } = {}) {
  const unexpected = [];
  const blocked = (name) => async () => {
    unexpected.push(name);
    throw new Error(`Unexpected fixture I/O: ${name}`);
  };

  t.mock.method(globalThis, "fetch", fetch ?? blocked("fetch"));
  const mocks = Object.fromEntries(Object.keys(bridge).map((name) => [
    name,
    t.mock.method(bridge, name, native[name] ?? blocked(`TauriBridge.${name}`)),
  ]));
  t.after(() => assert.deepEqual(unexpected, [], "All I/O must be covered by fixtures"));
  return mocks;
}
