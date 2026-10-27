/**
 * Integration test: load the REAL @deepseek-ai/dsh-system-prompt service from
 * the shipped DeepSeek Harness and confirm the opt-in contract holds inside
 * genuine cordis services.
 *
 * The three properties that matter most here:
 *   1. Before activation the plugin contributes ZERO prompt bytes.
 *   2. After `/omnissiah on` the persona appears in the assembled prompt.
 *   3. State is reconstructed from the harness' command lifecycle
 *      (`command/run` + `command/done`), never from a private event type.
 *
 * This needs an unpacked copy of the DSH core packages, which is machine
 * specific and therefore NOT shipped with the repository. Point `DSH_CORE_DIR`
 * at one to run it:
 *
 *     DSH_CORE_DIR=/path/to/coresvc node test/integration.mjs
 *
 * The copy is the contents of `<app.asar>/dsh/node_modules`, laid out so that
 * bare specifiers resolve (`node_modules/<name>` and
 * `node_modules/@scope/<name>`). Without it the test SKIPS rather than fails,
 * because the offline contract is fully covered by smoke.mjs.
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CORE = process.env.DSH_CORE_DIR ?? "";

if (CORE === "" || !existsSync(join(CORE, "@deepseek-ai", "cordis", "package.json"))) {
  console.log("\nSKIP: set DSH_CORE_DIR to an unpacked DSH core copy to run this test.");
  console.log("      The behaviour contract is covered offline by test/smoke.mjs.\n");
  process.exit(0);
}

const load = (rel) => import(pathToFileURL(`${CORE}/${rel}`).href);

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const { Context } = await load("@deepseek-ai/cordis/lib/index.js");
const SystemPromptMod = await load("@deepseek-ai/dsh-system-prompt/lib/index.js");
const SystemPrompt = SystemPromptMod.default ?? SystemPromptMod.SystemPrompt;

console.log("\n[boot] real cordis Context + real SystemPrompt service");
const ctx = new Context();
const service = new SystemPrompt(ctx, {
  includeHarnessIdentity: true,
  includeRuntimeContext: false,
  personaPrefix: "",
  personaSuffix: ""
});
check("SystemPrompt constructed", service !== undefined);
// `ctx.systemPrompt` is cordis' tracked service accessor, not the raw instance,
// so identity comparison is the wrong assertion — assert the API surface.
check("ctx.systemPrompt exposes section()", typeof ctx.systemPrompt?.section === "function");
check("ctx.systemPrompt exposes getSectionOrder()", typeof ctx.systemPrompt?.getSectionOrder === "function");

// A stand-in for the session-projection registry with the real contract:
// register(definition) + stateOf(session, key), folding committed events.
const events = new WeakMap();
const sessionProjections = {
  register: (def) => {
    // Keep the definition so we exercise ITS apply(), not a reimplementation.
    sessionProjections.__def = def;
    return () => {};
  },
  stateOf: (session, key) => {
    const def = sessionProjections.__def;
    if (!def || key !== def.key) return undefined;
    let state = def.init();
    for (const ev of events.get(session) ?? []) state = def.apply(state, ev);
    return state;
  }
};
ctx.sessionProjections = sessionProjections;

// Minimal commands registry with the documented surface.
const registered = new Map();
ctx.commands = {
  register: (c) => {
    registered.set(c.name, c);
    return () => {};
  }
};
// `ctx.inject` is cordis' accessor; provide the callback form the plugin uses.
const baseInject = ctx.inject?.bind(ctx);
ctx.inject = (deps, cb) => {
  if (typeof cb === "function" && Array.isArray(deps) && deps.includes("commands")) return cb(ctx);
  return baseInject ? baseInject(deps, cb) : undefined;
};

const commit = (session, event) => {
  const list = events.get(session) ?? [];
  list.push(event);
  events.set(session, list);
};

const makeSession = (messages = []) => {
  const s = {
    messages,
    // The plugin must never append a private event type; this mirror of the
    // real corruption mechanism makes any such attempt fail loudly.
    append: () => {
      throw new Error("plugin must not append session events");
    }
  };
  events.set(s, []);
  return s;
};

// Resolve this plugin relative to the test file, so the test works from any
// checkout location.
const { apply, SECTION_NAME } = await import(
  new URL("../lib/index.js", import.meta.url).href
);

/** Simulate the commands service lifecycle around one `/omnissiah` invocation. */
function runCommand(session, rawInput) {
  const commandId = `cmd-${(events.get(session) ?? []).length}`;
  commit(session, {
    type: "command/run",
    data: { commandId, name: "omnissiah", args: rawInput, source: { kind: "user" } }
  });
  const result = registered.get("omnissiah").handler({ rawInput, agent: { session } });
  commit(session, {
    type: "command/done",
    data: {
      commandId,
      kind: result.kind,
      ...(result.text === undefined ? {} : { text: result.text })
    }
  });
  return result;
}

let threw = null;
try {
  apply(ctx, { followUserRequest: true });
} catch (e) {
  threw = e;
}
check("apply() registers against real services", threw === null, String(threw));
check("command registered", registered.has("omnissiah"), [...registered.keys()].join(","));

/** Assemble + render, the way the agent loop does. */
async function renderFor(session) {
  const assembled = await service.assemble({ agent: { session } });
  const names = assembled.sections.map((s) => s.name);
  const rendered = typeof SystemPromptMod.renderPrompt === "function"
    ? SystemPromptMod.renderPrompt(assembled)
    : assembled.sections.map((s) => s.text).filter(Boolean).join("\n\n");
  return { names, rendered, assembled };
}

console.log("\n[1] BEFORE activation: plugin must contribute nothing");
const session = makeSession([{ role: "user", content: "把 CI 构建时间从 8 分钟压到 2 分钟" }]);
{
  const { names, rendered, assembled } = await renderFor(session);
  check("section is registered in the registry", names.includes(SECTION_NAME), names.join(", "));
  const ours = assembled.sections.find((s) => s.name === SECTION_NAME);
  check("registered section renders as empty", ours?.text === "", JSON.stringify(ours?.text));
  check("prompt has NO liturgy before activation", !rendered.includes("欧姆弥赛亚"), "liturgy leaked!");
  check("prompt has NO covenant before activation", !rendered.includes("知识先于行动"), "covenant leaked!");
  check("harness identity still present", rendered.includes("DeepSeek Harness"));
}

console.log("\n[2] AFTER /omnissiah on: persona must appear");
{
  const result = runCommand(session, " on");
  check("command returns success", result.kind === "success", result.kind);

  const { rendered, assembled } = await renderFor(session);
  const ours = assembled.sections.find((s) => s.name === SECTION_NAME);
  check("section now renders text", typeof ours?.text === "string" && ours.text.length > 0);
  check("liturgy present", rendered.includes("万机之神欧姆弥赛亚"));
  check("covenant present", rendered.includes("知识先于行动"));
  check("no unresolved {{task}}", !rendered.includes("{{task}}"));
  check("no unresolved {{artifact}}", !rendered.includes("{{artifact}}"));
  check("user request woven in", rendered.includes("CI 构建时间从 8 分钟"), "request missing");
  check("ambiguity rule present", rendered.includes("先向我确认"));
  check("log carries only released event types", (events.get(session) ?? []).every((e) => e.type === "command/run" || e.type === "command/done"));
}

console.log("\n[3] per-session isolation against the real registry");
{
  const other = makeSession([{ role: "user", content: "另一个会话的问题" }]);
  const { rendered } = await renderFor(other);
  check("a different session stays silent", !rendered.includes("欧姆弥赛亚"), "leaked into another session!");
  check("other session keeps harness identity", rendered.includes("DeepSeek Harness"));
}

console.log("\n[4] /omnissiah off restores silence");
{
  const result = runCommand(session, " off");
  check("off returns success", result.kind === "success", result.kind);
  const { rendered, assembled } = await renderFor(session);
  const ours = assembled.sections.find((s) => s.name === SECTION_NAME);
  check("section empty again", ours?.text === "", JSON.stringify(ours?.text));
  check("liturgy gone after off", !rendered.includes("欧姆弥赛亚"), "still present!");
}

console.log("\n[5] resumed session restores activation from the log");
{
  const resumed = makeSession([{ role: "user", content: "恢复后的会话" }]);
  // Repaired v1.0.0 event: the marker is what lets a newer harness read the log.
  commit(resumed, { type: "omnissiah/state", ignorable: true, data: { active: true, persona: "omnissiah" } });
  const { rendered } = await renderFor(resumed);
  check("logged activation replays on resume", rendered.includes("万机之神欧姆弥赛亚"));
}

console.log(failures === 0 ? "\nALL INTEGRATION CHECKS PASSED" : `\n${failures} INTEGRATION CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
