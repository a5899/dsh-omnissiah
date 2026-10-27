/**
 * Contract test against the REAL `@deepseek-ai/dsh-session` and
 * `@deepseek-ai/dsh-session-projection` packages: the plugin's projection must
 * fold command-derived state, validate a persisted checkpoint, and restore it.
 *
 * This is the regression guard for the v1.0.1 crash: v1.0.0 wrote a private
 * `omnissiah/state` event that newer harnesses refuse on log read. The plugin
 * now folds the released `command/run` + `command/done` lifecycle instead.
 *
 * The harness core packages are machine specific, so this test SKIPS unless
 * `DSH_CORE_DIR` points at an unpacked core package root (the same fixture
 * `test/integration.mjs` uses):
 *
 *     DSH_CORE_DIR=/path/to/coresvc node test/projection-contract.mjs
 *
 * Run: node test/projection-contract.mjs
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apply, PROJECTION_KEY } from "../lib/index.js";

const CORE = process.env.DSH_CORE_DIR ?? "";

if (CORE === "" || !existsSync(join(CORE, "@deepseek-ai", "cordis", "package.json"))) {
  console.log("\nSKIP: set DSH_CORE_DIR to an unpacked DSH core copy to run this test.");
  console.log("      The offline contract is covered by test/smoke.mjs.\n");
  process.exit(0);
}

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const load = (rel) => import(pathToFileURL(`${CORE}/${rel}`).href);
const { Context } = await load("@deepseek-ai/cordis/lib/index.js");
const { Session, SessionId, SessionLogOffset } = await load("@deepseek-ai/dsh-session/lib/index.js");
const { SessionProjectionRegistry } = await load("@deepseek-ai/dsh-session-projection/lib/index.js");

// Capture the definition exactly as `apply()` registers it, then mount it on
// the real registry. The command/section surfaces are irrelevant here.
let definition = null;
const noop = () => {};
apply({
  logger: { info: noop, warn: noop },
  systemPrompt: { getSectionOrder: () => 0, section: () => noop },
  sessionProjections: {
    register: (candidate) => { definition = candidate; return noop; },
    stateOf: () => undefined
  },
  inject: (deps, cb) => cb({ commands: { register: () => noop } }),
  commands: { register: () => noop }
}, {});

if (definition === null) {
  console.log("FAIL: plugin did not register its projection");
  process.exit(1);
}

const ctx = new Context();
await ctx.plugin(SessionProjectionRegistry);
ctx.sessionProjections.register(definition);

let clock = 1_000;
const event = (seq, type, data, extra = {}) => ({ type, seq, time: clock++, data, ...extra });
const command = (seq, commandId, args) => event(seq, "command/run", {
  commandId, name: "omnissiah", args, source: { kind: "user" }
});
const settled = (seq, commandId, kind = "success") => event(seq, "command/done", { commandId, kind });
const stateOf = (session) => ctx.sessionProjections.stateOf(session, PROJECTION_KEY);

const sessionFor = (name, events) => Session.create(SessionId(name), events);

console.log("\n[1] live fold over the released command lifecycle");
{
  const session = sessionFor("on-off", [
    command(0, "c1", " on"),
    settled(1, "c1"),
    command(2, "c2", " off"),
    settled(3, "c2"),
    command(4, "c3", " omnissiah-pure"),
    settled(5, "c3")
  ]);
  const state = stateOf(session);
  check("activates, deactivates, then selects a persona", state.active === true && state.persona === "omnissiah-pure", JSON.stringify(state));
  check("no pending command remains", state.pending === null, JSON.stringify(state));
}

console.log("\n[2] real-log arg shapes (leading space / newline / extra text)");
{
  const session = sessionFor("real-args", [
    // Observed in the user's broken log: rawInput carries separator whitespace
    // and the rest of the composer text on following lines.
    command(0, "c1", " on\n按照 PLAN.md 先写出来一个启动器的版本雏形。"),
    settled(1, "c1"),
    command(2, "c2", " "),
    settled(3, "c2")
  ]);
  const state = stateOf(session);
  check("first token decides the action", state.active === true && state.persona === "omnissiah", JSON.stringify(state));
}

console.log("\n[3] failed commands never change state");
{
  const session = sessionFor("failed", [
    command(0, "c1", " not-a-persona"),
    settled(1, "c1", "error")
  ]);
  const state = stateOf(session);
  check("usage error leaves the session inactive", state.active === false, JSON.stringify(state));
  check("usage error leaves no pending state", state.pending === null, JSON.stringify(state));

  const active = sessionFor("failed-after-on", [
    command(0, "c1", " on"),
    settled(1, "c1"),
    command(2, "c2", " not-a-persona"),
    settled(3, "c2", "error")
  ]);
  const after = stateOf(active);
  check("a later failed command keeps the earlier activation", after.active === true && after.persona === "omnissiah", JSON.stringify(after));

  // A command definition that sets `recordInput: false` stores no args; the
  // projection must not guess that the user asked for "on".
  const noArgs = sessionFor("no-args", [
    event(0, "command/run", { commandId: "c1", name: "omnissiah", source: { kind: "user" } }),
    settled(1, "c1")
  ]);
  const unguessable = stateOf(noArgs);
  check("absent args do not activate", unguessable.active === false, JSON.stringify(unguessable));
  check("absent args leave no pending state", unguessable.pending === null, JSON.stringify(unguessable));
}

console.log("\n[4] repaired v1.0.0 events still restore activation");
{
  const session = sessionFor("legacy", [
    event(0, "command/run", { commandId: "c1", name: "omnissiah", args: " on", source: { kind: "user" } }),
    event(1, "omnissiah/state", { active: true, persona: "covenant" }, { ignorable: true }),
    settled(2, "c1")
  ]);
  const state = stateOf(session);
  check("legacy event is folded", state.active === true && state.persona === "covenant", JSON.stringify(state));

  // A v3 session migrated to v4 renames unknown ignorable events into the
  // `plugin:` namespace; the same legacy payload must still restore state.
  const migrated = sessionFor("legacy-plugin-ns", [
    event(0, "plugin:omnissiah/state", { active: true, persona: "omnissiah-pure" }, { ignorable: true })
  ]);
  const migratedState = stateOf(migrated);
  check("plugin:-namespaced legacy event is folded", migratedState.active === true && migratedState.persona === "omnissiah-pure", JSON.stringify(migratedState));
}

console.log("\n[5] persisted checkpoint round trip uses the state schema");
{
  const session = sessionFor("checkpoint", [
    command(0, "c1", " covenant"),
    settled(1, "c1")
  ]);
  const live = stateOf(session);
  const checkpoint = ctx.sessionProjections.checkpoint(session);
  const row = checkpoint[PROJECTION_KEY];
  check("checkpoint stores version 2", row?.ver === 2, String(row?.ver));
  check("checkpoint stores the projected state", JSON.stringify(row?.val) === JSON.stringify(live), JSON.stringify(row?.val));
  check("checkpoint is plain JSON", JSON.parse(JSON.stringify(checkpoint)) !== null);

  const floor = ctx.sessionProjections.restoreFloor(checkpoint);
  const restored = ctx.sessionProjections.restore(
    checkpoint,
    session.snapshotEvents(floor),
    floor,
    session.header,
    SessionLogOffset(0)
  );
  check("restore consumes the checkpoint row", restored.checkpoint[PROJECTION_KEY]?.ver === 2);
  check("restored state matches the live fold", JSON.stringify(restored.checkpoint[PROJECTION_KEY]?.val) === JSON.stringify(live), JSON.stringify(restored.checkpoint[PROJECTION_KEY]?.val));

  let rejected = false;
  try {
    ctx.sessionProjections.restore(
      { [PROJECTION_KEY]: { ver: 2, seq: 1, val: { active: true, persona: "omnissiah" } } },
      session.snapshotEvents(1),
      SessionLogOffset(1),
      session.header,
      SessionLogOffset(0)
    );
  } catch {
    rejected = true;
  }
  check("the v1 checkpoint shape is rejected by the schema", rejected);
}

console.log("\n[6] apply is a pure, reference-stable fold");
{
  const initial = definition.init();
  const frozen = Object.freeze({ ...initial });
  let threw = null;
  try {
    definition.apply(frozen, event(0, "user/message", {}));
    definition.apply(frozen, event(1, "command/run", { commandId: "x", name: "other", args: "", source: { kind: "user" } }));
  } catch (error) {
    threw = error;
  }
  check("unrelated events do not throw on frozen state", threw === null, String(threw));
  check("unrelated event returns the same reference", definition.apply(frozen, event(2, "user/message", {})) === frozen);
  const next = definition.apply(frozen, command(3, "c1", " on"));
  check("our command/run returns a new state", next !== frozen && next.pending?.commandId === "c1", JSON.stringify(next));
  check("fold does not mutate the input", frozen.pending === null && frozen.active === false, JSON.stringify(frozen));

  // A throwing fold would permanently stall the session's projection cell, so
  // every malformed shape must degrade to "unchanged" instead.
  const hostile = [
    undefined,
    null,
    {},
    { type: "command/run", data: null },
    { type: "command/run", data: { name: "omnissiah" } },
    { type: "command/run", data: { name: "omnissiah", commandId: 7, args: " on" } },
    { type: "command/done", data: null },
    { type: "command/done", data: { commandId: "c1" } },
    { type: "omnissiah/state", data: null },
    { type: "plugin:omnissiah/state", data: "nope" }
  ];
  let hostileThrew = null;
  let hostileChanged = false;
  try {
    for (const candidate of hostile) {
      if (definition.apply(frozen, candidate) !== frozen) hostileChanged = true;
    }
  } catch (error) {
    hostileThrew = error;
  }
  check("malformed events never throw", hostileThrew === null, String(hostileThrew));
  check("malformed events return the unchanged state", !hostileChanged);
}

console.log(failures === 0 ? "\nALL PROJECTION CONTRACT CHECKS PASSED" : `\n${failures} PROJECTION CONTRACT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
