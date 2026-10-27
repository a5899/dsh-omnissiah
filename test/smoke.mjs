/**
 * Offline harness for the omnissiah plugin: drives `apply()` against a mock
 * cordis context and asserts the opt-in contract.
 *
 * The single most important property: **no injection unless activated.**
 *
 * The mock also simulates the harness' slash-command lifecycle: `command/run`
 * is committed before the handler and `command/done` after it. The plugin's
 * per-session state is folded from those released event types, so the tests
 * call {@link mockCtx}'s `run()` helper instead of invoking the handler alone.
 *
 * Run: node test/smoke.mjs
 */
import { apply, SECTION_NAME, COMMAND_NAME, PROJECTION_KEY } from "../lib/index.js";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/**
 * Mock host context.
 *
 * `sessionProjections` simulates the real registry: it keeps the registered
 * definition and folds that definition over the events committed to each fake
 * session. `run()` wraps one handler call in the real command lifecycle.
 */
function mockCtx() {
  const sections = [];
  const commands = [];
  const sessions = new WeakMap();
  let definition = null;

  const eventsOf = (session) => sessions.get(session) ?? [];

  const fold = (session) => {
    let state = definition.init();
    for (const event of eventsOf(session)) state = definition.apply(state, event);
    return state;
  };

  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    systemPrompt: {
      getSectionOrder: (name) => (name === "DEPLOYMENT_PERSONA_PREFIX" ? 0 : 1000),
      section: (s) => {
        sections.push(s);
        return () => {};
      }
    },
    sessionProjections: {
      register: (candidate) => {
        definition = candidate;
        return () => {};
      },
      stateOf: (session, key) => (key === PROJECTION_KEY ? fold(session) : undefined)
    },
    inject: (deps, cb) => cb(ctx),
    commands: {
      register: (c) => {
        commands.push(c);
        return () => {};
      }
    }
  };

  const makeSession = (messages = []) => {
    const session = {
      messages,
      // The plugin is forbidden from appending private event types: any such
      // attempt must fail the test loudly instead of corrupting a session log.
      append: () => {
        throw new Error("plugin must not append session events");
      }
    };
    sessions.set(session, []);
    return session;
  };

  /** Commit one event straight to the fake log, like the harness would. */
  const commit = (session, event) => {
    eventsOf(session).push(event);
  };

  /** Simulate the commands service lifecycle around one handler call. */
  const run = (session, raw, handler = commands[0].handler) => {
    const commandId = `cmd-${eventsOf(session).length}`;
    commit(session, {
      type: "command/run",
      data: { commandId, name: COMMAND_NAME, args: raw, source: { kind: "user" } }
    });
    const result = handler({ rawInput: raw, agent: { session } });
    commit(session, {
      type: "command/done",
      data: {
        commandId,
        kind: result.kind,
        ...(result.text === undefined ? {} : { text: result.text })
      }
    });
    return result;
  };

  /** Commit one repaired v1.0.0 event, as it appears after the log repair. */
  const pushLegacy = (session, data) => {
    commit(session, { type: "omnissiah/state", ignorable: true, data });
  };

  return { ctx, sections, commands, makeSession, fold, eventsOf, commit, run, pushLegacy, definition: () => definition };
}

const USER_MSG = { role: "user", content: "把 CI 构建时间从 8 分钟压到 2 分钟" };
const invoke = (raw, session) => ({ rawInput: raw, agent: { session } });
const textFor = (sections, session) => sections[0].text({ agent: { session } });

console.log("\n[1] registration and default-inactive contract");
const M = mockCtx();
apply(M.ctx, {});
check("exactly one prompt section registered", M.sections.length === 1, String(M.sections.length));
check("section name is stable", M.sections[0].name === SECTION_NAME, M.sections[0].name);
check("section sits at the persona slot", M.sections[0].order === 0, String(M.sections[0].order));
check("section opts out of interpolation", M.sections[0].interpolate === false);
check("text is a resolver function", typeof M.sections[0].text === "function");
check("one command registered", M.commands.length === 1, String(M.commands.length));
check("command is named omnissiah", M.commands[0].name === COMMAND_NAME, M.commands[0].name);
check("projection registered", M.definition() !== null);
check("projection stateVersion bumped for the new fold", M.definition().stateVersion === 2, String(M.definition().stateVersion));
check("projection provides a state schema", typeof M.definition().stateSchema?.parse === "function");

{
  const s = M.makeSession([USER_MSG]);
  check("INACTIVE by default -> empty text", textFor(M.sections, s) === "", JSON.stringify(textFor(M.sections, s)));
}

console.log("\n[2] /omnissiah on activates, off deactivates (per session)");
{
  const alice = M.makeSession([USER_MSG]);
  const bob = M.makeSession([USER_MSG]);

  const on = M.run(alice, "on");
  check("`on` reports success", on.kind === "success", on.kind);
  const active = textFor(M.sections, alice);
  check("activated session now injects", active.length > 0);
  check("liturgy present", active.includes("万机之神欧姆弥赛亚"));
  check("covenant present", active.includes("知识先于行动"));
  check("no unresolved {{task}}", !active.includes("{{task}}"));
  check("no unresolved {{artifact}}", !active.includes("{{artifact}}"));
  check("artifact clause folded to the request", active.includes("根据我本次向你提出的请求"));
  check("user request woven in", active.includes("CI 构建时间从 8 分钟"), "request missing");
  check("addendum heading present", active.includes("本次祷告所指的具体事务"));

  check("OTHER session stays silent", textFor(M.sections, bob) === "", JSON.stringify(textFor(M.sections, bob)));
  check("other session status is inactive", M.fold(bob).active === false);

  const off = M.run(alice, "off");
  check("`off` reports success", off.kind === "success", off.kind);
  check("deactivated session injects nothing", textFor(M.sections, alice) === "");
  check("bob still unaffected", textFor(M.sections, bob) === "");
  check("no private event type was written", M.eventsOf(alice).every((e) => e.type !== "omnissiah/state"));
}

console.log("\n[3] status and idempotence");
{
  const M2 = mockCtx();
  apply(M2.ctx, {});
  const s = M2.makeSession([USER_MSG]);

  check("status before activation", M2.run(s, "status").text.includes("未激活"));
  check("off when already off is not an error", M2.run(s, "off").kind === "success");

  M2.run(s, "on");
  const again = M2.run(s, "on");
  check("re-activating is idempotent", again.kind === "success" && again.text.includes("已处于激活状态"));
  check("still exactly one activation state", M2.fold(s).active === true);
  check("status when on", M2.run(s, "status").text.includes("已激活"));

  M2.run(s, "off");
  check("activation can be toggled repeatedly", textFor(M2.sections, s) === "");
  M2.run(s, "on");
  check("re-activation works after off", textFor(M2.sections, s).includes("欧姆弥赛亚"));
}

console.log("\n[4] persona selection by argument");
{
  const M3 = mockCtx();
  apply(M3.ctx, {});
  const s = M3.makeSession([USER_MSG]);

  M3.run(s, "omnissiah-pure");
  let t = textFor(M3.sections, s);
  check("pure persona drops the covenant", !t.includes("知识先于行动"));
  check("pure persona keeps the liturgy", t.includes("万机之神欧姆弥赛亚"));

  M3.run(s, "covenant");
  t = textFor(M3.sections, s);
  check("covenant persona has no liturgy", !t.includes("万机之神欧姆弥赛亚"));
  check("covenant persona keeps the contract", t.includes("知识先于行动"));

  const bad = M3.run(s, "nope");
  check("unknown persona is a usage error", bad.kind === "error", bad.kind);
  check("unknown persona does not deactivate", textFor(M3.sections, s).length > 0);
  check("unknown persona keeps the selected persona", M3.fold(s).persona === "covenant", M3.fold(s).persona);

  M3.run(s, "on");
  t = textFor(M3.sections, s);
  check("bare `on` keeps the selected persona", t.includes("知识先于行动"));
}

console.log("\n[5] robustness: never break prompt assembly");
{
  const M4 = mockCtx();
  apply(M4.ctx, {});
  const s = M4.makeSession([USER_MSG]);
  M4.run(s, "on");

  let threw = null;
  let out;
  try {
    out = M4.sections[0].text({}); // no agent at all
  } catch (e) {
    threw = e;
  }
  check("no throw when assembly context has no agent", threw === null, String(threw));
  check("renders empty without a session", out === "", JSON.stringify(out));

  threw = null;
  try {
    out = M4.sections[0].text({ agent: { session: { messages: "not-an-array" } } });
  } catch (e) {
    threw = e;
  }
  check("no throw on malformed session", threw === null, String(threw));

  // A session with only an injected reminder must not quote it as the request.
  const reminderOnly = M4.makeSession([
    { role: "user", content: "<system-reminder>injected scaffolding</system-reminder>" }
  ]);
  M4.run(reminderOnly, "on");
  const t = textFor(M4.sections, reminderOnly);
  check("system reminders are not quoted as the request", !t.includes("injected scaffolding"));

  // A session with no user message at all still renders the liturgy.
  const empty = M4.makeSession([]);
  M4.run(empty, "on");
  const et = textFor(M4.sections, empty);
  check("empty session still renders the liturgy", et.includes("欧姆弥赛亚"));
  check("empty session adds no addendum", !et.includes("本次祷告所指的具体事务"));
}

console.log("\n[6] config: followUserRequest=false and artifact");
{
  const M5 = mockCtx();
  apply(M5.ctx, { followUserRequest: false });
  const s = M5.makeSession([USER_MSG]);
  M5.run(s, "on");
  const t = textFor(M5.sections, s);
  check("followUserRequest=false omits the request", !t.includes("CI 构建时间从 8 分钟"));
  check("followUserRequest=false keeps the liturgy", t.includes("欧姆弥赛亚"));

  const M6 = mockCtx();
  apply(M6.ctx, { artifact: "PERFORMANCE_OPTIMIZATION.md" });
  const s6 = M6.makeSession([USER_MSG]);
  M6.run(s6, "on");
  const t6 = textFor(M6.sections, s6);
  check("artifact substituted into the slot", t6.includes("根据 PERFORMANCE_OPTIMIZATION.md 这份文档"));
  check("artifact slot fully consumed", !t6.includes("{{artifact}}"));
}

console.log("\n[7] missing sessionProjections degrades instead of throwing");
{
  let threw = null;
  let commands = 0;
  try {
    // A real cordis context always provides `inject`; what may be absent is the
    // optional service, and that must degrade rather than abort registration.
    const bare = {
      logger: { info: () => {}, warn: () => {} },
      systemPrompt: { getSectionOrder: () => 0, section: () => () => {} },
      inject: (deps, cb) => cb(bare),
      commands: { register: (c) => { commands += 1; return () => {}; } }
    };
    apply(bare, {});
  } catch (e) {
    threw = e;
  }
  check("no throw without sessionProjections", threw === null, String(threw));
  check("command still registers without sessionProjections", commands === 1, String(commands));
}

console.log("\n[8] REGRESSION: undeclared service must not kill registration");
{
  // The v1.0.0 bug: `apply()` read `ctx.sessionProjections` while declaring only
  // `systemPrompt` in `inject`. Cordis' getter trap then threw
  // "cannot get required service ... in inactive context", aborting apply()
  // BEFORE the command registered — so /omnissiah never appeared in the UI.
  // Guard both halves: the declaration must include it, AND a throwing access
  // must still leave the command registered.
  const mod = await import("../lib/index.js");
  check("inject declares sessionProjections", mod.inject.includes("sessionProjections"), JSON.stringify(mod.inject));
  check("inject still declares systemPrompt", mod.inject.includes("systemPrompt"), JSON.stringify(mod.inject));

  const sections = [];
  const commands = [];
  let warned = false;
  const hostile = {
    logger: { info: () => {}, warn: () => { warned = true; } },
    systemPrompt: {
      getSectionOrder: () => 0,
      section: (s) => { sections.push(s); return () => {}; }
    },
    // Simulate cordis' inactive-context getter trap.
    get sessionProjections() {
      throw new Error('cannot get required service "sessionProjections" in inactive context');
    },
    inject: (deps, cb) => cb(hostile),
    commands: { register: (c) => { commands.push(c); return () => {}; } }
  };

  let threw = null;
  try {
    mod.apply(hostile, {});
  } catch (e) {
    threw = e;
  }
  check("apply() survives a throwing service access", threw === null, String(threw));
  check("prompt section still registered", sections.length === 1, String(sections.length));
  check("COMMAND STILL REGISTERED (the v1.0.0 failure)", commands.length === 1, String(commands.length));
  check("command name is omnissiah", commands[0]?.name === COMMAND_NAME, commands[0]?.name);
  check("a warning was logged", warned === true);
}

console.log("\n[9] log compatibility: command-derived state, failed commands, repaired legacy events");
{
  const M7 = mockCtx();
  apply(M7.ctx, {});

  // A successful invocation commits through the paired command/done event; the
  // handler itself must not touch the session log (the mock `append` throws).
  const s = M7.makeSession([USER_MSG]);
  M7.run(s, "on");
  check("on commits via the command lifecycle", M7.fold(s).active === true);
  check("only released event types in the log", M7.eventsOf(s).every((e) => e.type === "command/run" || e.type === "command/done"));

  // A failed invocation must not activate the session.
  const failed = M7.makeSession([USER_MSG]);
  const bad = M7.run(failed, "definitely-not-a-persona");
  check("usage error is reported", bad.kind === "error");
  check("failed command does not activate", M7.fold(failed).active === false);
  check("failed command leaves no pending state", M7.fold(failed).pending === null);

  // A repaired v1.0.0 log still restores its activation.
  const legacy = M7.makeSession([USER_MSG]);
  M7.pushLegacy(legacy, { active: true, persona: "covenant" });
  check("repaired legacy event restores activation", textFor(M7.sections, legacy).includes("知识先于行动"));
  check("repaired legacy event restores the persona", M7.fold(legacy).persona === "covenant");

  // The persisted state schema accepts this shape and rejects the old v1 shape.
  const schema = M7.definition().stateSchema;
  check("state schema accepts a folded state", (() => {
    try { schema.parse({ active: true, persona: "omnissiah", pending: null }); return true; } catch { return false; }
  })());
  check("state schema rejects the v1 checkpoint shape", (() => {
    try { schema.parse({ active: true, persona: "omnissiah" }); return false; } catch { return true; }
  })());
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
