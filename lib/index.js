/**
 * dsh-plugin-omnissiah — host half.
 *
 * Brings the "万机之神" (Omnissiah) prompting technique from the Bilibili video
 * 「ds：好的，我现在是万机之神了（」 (BV1Ata26pE92) into DeepSeek Harness as an
 * **opt-in** persona.
 *
 * Design contract — the plugin is completely inert until asked:
 *
 *   - Nothing is injected at load time. `apply()` registers a prompt section
 *     whose resolver returns `""` for every session, and an empty section
 *     contributes zero bytes to the assembled prompt (verified against the
 *     system-prompt assembly pipeline, which filters empty sections out).
 *   - The persona becomes active for one session only after the user runs
 *     `/omnissiah on` (or `/omnissiah <persona-id>`) *in that session*.
 *   - `/omnissiah off` deactivates it again. Other sessions are never affected.
 *
 * Activation is **not** a private log event. An out-of-repo plugin has no
 * sanctioned way to mark its own event `ignorable`, and DSH refuses a stored
 * log containing an unknown event that is not marked ignorable — one private
 * event type would make the entire conversation unreadable. State is therefore
 * folded from the harness' own `/omnissiah` lifecycle events (`command/run` and
 * `command/done`, both in the released vocabulary), so it survives checkpoint,
 * resume, and fork exactly like plan mode does while every log stays readable.
 *
 * The user's request is woven into the liturgy at assembly time: the latest
 * real user message fills the `{{task}}` slot and is restated under a
 * "本次祷告所指的具体事务" heading, so "these prompts + the user's request"
 * arrive as one coherent petition (`followUserRequest`, default on).
 *
 * Prompt placement: `DEPLOYMENT_PERSONA_PREFIX` (order 0), i.e. immediately
 * after the harness identity and before all first-party tool guidance. A
 * persona is a stance taken before the work is described, not a note appended
 * after it.
 *
 * Interpolation is disabled (`interpolate: false`) because our `{{task}}` /
 * `{{artifact}}` slots are resolved here in JavaScript; the prompt renderer
 * would otherwise reject them as unknown variables and fail the model step.
 */
import { PERSONAS, PERSONA_IDS, resolvePersona } from "./personas.js";

/**
 * Services this plugin reaches through the host cordis context.
 *
 * ⚠️ `sessionProjections` MUST be declared here, not merely read.
 * Cordis installs a getter trap on the plugin context: touching a service that
 * is absent from this list throws
 *   `cannot get required service "<name>" in inactive context`
 * from `apply()` — which aborts registration entirely. That is exactly how the
 * first release failed on the desktop profile: it read `ctx.sessionProjections`
 * while declaring only `systemPrompt`, so `apply()` threw before the
 * `/omnissiah` command was ever registered (no completion entry, command fell
 * through to the model as a plain message).
 *
 * Declaring a name here is safe: cordis simply defers `apply()` until that
 * service is provided, and `sessionProjections` ships with dsh-base.
 */
const inject = ["systemPrompt", "sessionProjections"];

/** Stable section name — a deployment can shadow it to replace the persona. */
const SECTION_NAME = "persona:omnissiah";

/** Stable projection key holding the per-session activation state. */
const PROJECTION_KEY = "omnissiah";

/** Default persona id. */
const DEFAULT_PERSONA = "omnissiah";

/** Command name (invoked as `/omnissiah …`). */
const COMMAND_NAME = "omnissiah";

/** One-line usage shown for bad arguments. */
const USAGE =
  "Usage: /omnissiah [on|off|status|<persona>] — " +
  `personas: ${PERSONA_IDS.join(", ")}`;

/**
 * Parse the raw text after `/omnissiah` into the action it selects.
 *
 * Deliberately shared by the live command handler and the log projection: the
 * handler's decision and the replayed `command/run.args` must never disagree,
 * or a resumed session would show a different state than the live one. The
 * command grammar is `[on|off|status|<persona>]`, where a missing argument
 * activates with the session's current persona.
 *
 * @param {unknown} rawInput - text following the command name, verbatim.
 * @param {string} currentPersona - persona to keep for `on` / bare invocations.
 * @returns {{kind: "status"} | {kind: "off"} | {kind: "on", persona: string} | {kind: "invalid", name: string}}
 */
function parseArguments(rawInput, currentPersona) {
  const raw = typeof rawInput === "string" ? rawInput.trim() : "";
  const first = raw.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first === "status") return { kind: "status" };
  if (first === "off") return { kind: "off" };

  let persona = currentPersona;
  if (first !== "" && first !== "on") {
    const resolved = resolvePersona(first);
    if (resolved.fellBack) return { kind: "invalid", name: first };
    persona = resolved.id;
  }
  return { kind: "on", persona };
}

/** Initial (inactive) projection state. */
const INITIAL_STATE = Object.freeze({ active: false, persona: DEFAULT_PERSONA, pending: null });

/**
 * Validate one persisted projection state before it seeds a fold.
 *
 * The registry contract requires a `stateSchema`; `session-projection-cache`
 * parses the stored checkpoint with it on a cold read. This is a tiny
 * dependency-free implementation of the one method the registry calls; keeping
 * the plugin dependency-free is deliberate.
 */
const projectionStateSchema = {
  parse(value) {
    const fail = () => new TypeError(
      "omnissiah projection state must be { active: boolean, persona: string, pending: null | { commandId, active, persona } }"
    );
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw fail();
    if (typeof value.active !== "boolean") throw fail();
    if (typeof value.persona !== "string" || value.persona.length === 0) throw fail();
    const pending = value.pending;
    if (pending !== null) {
      if (pending === undefined
        || typeof pending !== "object"
        || Array.isArray(pending)
        || typeof pending.commandId !== "string"
        || pending.commandId.length === 0
        || typeof pending.active !== "boolean"
        || typeof pending.persona !== "string"
        || pending.persona.length === 0) {
        throw fail();
      }
    }
    return value;
  }
};

/**
 * Apply one legacy `omnissiah/state` event.
 *
 * v1.0.0 wrote these events without the `ignorable` marker. The repair tool
 * (`scripts/repair-session-log.mjs`) adds the marker so the log loads again;
 * the payload is still the current session state and must keep working, or
 * every pre-fix session would silently start inactive after the upgrade.
 */
function applyLegacyState(state, data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return state;
  const active = data.active === true;
  const persona = typeof data.persona === "string" && PERSONA_IDS.includes(data.persona)
    ? data.persona
    : state.persona;
  // A v1.0.0 event is the old handler's committed state, so it supersedes the
  // pending command half-pair; the following command/done must not overwrite it.
  if (state.active === active && state.persona === persona && state.pending === null) return state;
  return { active, persona, pending: null };
}

/**
 * Per-session state, folded from the session log.
 *
 * Two-phase fold over the harness' command lifecycle, mirroring plan mode:
 * `command/run` records what the invocation *wants*, and the matching
 * `command/done` commits it only when the handler settled successfully. A
 * failed invocation (unknown persona today) therefore never changes state.
 *
 * `pending` carries the in-flight command across the pair. It is plain JSON
 * and part of the persisted checkpoint state. Legacy v1.0.0 events are folded
 * too so a repaired old log keeps its activation.
 */
const projectionDefinition = {
  key: PROJECTION_KEY,
  // v2: v1 persisted {active, persona} only, and this fold is different.
  stateVersion: 2,
  stateSchema: projectionStateSchema,
  init: () => INITIAL_STATE,
  apply: (state, event) => {
    try {
      switch (event?.type) {
        case "omnissiah/state":
        // A repaired v3 log is migrated into the `plugin:` namespace on read.
        case "plugin:omnissiah/state":
          return applyLegacyState(state, event.data);

        case "command/run": {
          const data = event.data ?? {};
          // A command definition may opt out of recording `rawInput`; absent
          // args cannot reconstruct the user's intent, so never guess "on"
          // (plan mode ignores absent args for the same reason).
          if (data.name !== COMMAND_NAME
            || typeof data.commandId !== "string"
            || typeof data.args !== "string") {
            return state;
          }
          const parsed = parseArguments(data.args, state.persona);
          // `status` and a usage error change nothing; no pending command.
          if (parsed.kind === "status" || parsed.kind === "invalid") return state;
          // One in-flight invocation per session: the commands service settles
          // them sequentially, and a dangling slot (crash between the pair) is
          // superseded by the next invocation.
          return {
            active: state.active,
            persona: state.persona,
            pending: {
              commandId: data.commandId,
              active: parsed.kind === "on",
              persona: parsed.kind === "on" ? parsed.persona : state.persona
            }
          };
        }

        case "command/done": {
          const pending = state.pending;
          if (pending === null) return state;
          const data = event.data ?? {};
          if (data.commandId !== pending.commandId) return state;
          // A failed command settles without changing state; either way the pair is done.
          if (data.kind !== "success") {
            return { active: state.active, persona: state.persona, pending: null };
          }
          if (pending.active === state.active && pending.persona === state.persona) {
            return { active: state.active, persona: state.persona, pending: null };
          }
          return { active: pending.active, persona: pending.persona, pending: null };
        }

        default:
          // Object.is gate: returning the same reference means zero downstream work.
          return state;
      }
    } catch {
      // The registry contains a throwing unit, but a throw would permanently
      // stall this session's cell and every later stateOf() read. Degrade.
      return state;
    }
  }
};

/** Initial (inactive) state used whenever the registry is unavailable. */
const INACTIVE = Object.freeze({ active: false, persona: DEFAULT_PERSONA });

/**
 * Read one session's activation state.
 *
 * Never throws: prompt assembly must not fail because a projection lookup went
 * wrong, and an unknown session is simply inactive. The optional-chain guard
 * matters because the resolver also runs for sessions that predate the plugin.
 */
function stateOf(sessionProjections, session) {
  if (session === null || session === undefined) return INACTIVE;
  try {
    const state = sessionProjections?.stateOf?.(session, PROJECTION_KEY);
    if (state === null || state === undefined) return INACTIVE;
    return {
      active: state.active === true,
      persona: typeof state.persona === "string" && state.persona.length > 0
        ? state.persona
        : DEFAULT_PERSONA
    };
  } catch {
    return INACTIVE;
  }
}

/**
 * Build the final section text for one session.
 *
 * Returns `""` when the persona is inactive — that is the entire opt-in
 * mechanism, so this must stay the first check.
 */
function renderSection(state, options) {
  if (!state.active) return "";

  const { persona } = resolvePersona(state.persona);
  let text = persona.text;

  // The liturgy reads "对项目进行 {{task}}。" — a verb phrase, not a sentence.
  // A raw user request is a full sentence and would not parse there, so the
  // slot keeps the generic noun phrase and the concrete request is carried by
  // the addendum below, phrased as an explicit restatement.
  if (text.includes("{{task}}")) text = text.replaceAll("{{task}}", "本次任务");

  if (text.includes("{{artifact}}")) {
    text = options.artifact !== null
      ? text.replaceAll("{{artifact}}", options.artifact)
      // No document was named: fold the reference back onto the live request
      // so the sentence still parses and still means "the thing asked for".
      : text.replaceAll("根据 {{artifact}} 这份文档，", "根据我本次向你提出的请求，");
  }

  const addendum = options.request !== null
    ? `\n\n**本次祷告所指的具体事务：**\n\n${options.request}`
    : "";

  return `${text}${addendum}`;
}

/**
 * Resolve the section text for the current assembly.
 *
 * Any unexpected failure degrades to "inactive" rather than throwing, because
 * a throw here aborts the whole model step.
 */
function buildText(settings, sessionProjections, assemblyContext) {
  const session = assemblyContext?.agent?.session;
  const state = stateOf(sessionProjections, session);
  if (!state.active) return "";

  let request = null;
  try {
    request = settings.followUserRequest ? lastUserRequest(session) : null;
  } catch {
    request = null;
  }

  try {
    return renderSection(state, {
      request,
      artifact: settings.artifact ?? null
    });
  } catch {
    return resolvePersona(state.persona).persona.text;
  }
}

/**
 * Extract the most recent real user message from a session.
 *
 * Best-effort by design: the session internals are not this plugin's contract,
 * so an unrecognised shape yields null ("nothing to restate") rather than an
 * error. Assistant turns, tool results, and injected system reminders are all
 * skipped, because the liturgy must quote what the *human* asked for.
 */
function lastUserRequest(session) {
  if (session === null || session === undefined) return null;

  const candidates = [];
  if (Array.isArray(session)) candidates.push(session);
  else {
    for (const key of ["messages", "events", "history", "log"]) {
      if (Array.isArray(session[key])) candidates.push(session[key]);
    }
  }

  for (const list of candidates) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      if (entry === null || typeof entry !== "object") continue;

      // Session logs carry `{ type }`; message arrays carry `{ role }`.
      const kind = entry.type ?? entry.role ?? entry.kind;
      if (kind !== "user" && kind !== "user/message") continue;

      const text = extractText(entry.content ?? entry.text ?? entry.message);
      if (typeof text === "string" && text.trim().length > 0) {
        const trimmed = text.trim();
        // Skip injected scaffolding: those are not the human's words.
        if (trimmed.startsWith("<system-reminder>")) continue;
        return trimmed;
      }
    }
  }
  return null;
}

/** Flatten the common content-part shapes into plain text. */
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part !== null && typeof part === "object" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (content !== null && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return null;
}

/**
 * Apply one `/omnissiah` invocation.
 *
 * Argument grammar (everything after the command name is `rawInput`):
 *   (none) | on | <persona-id>  -> activate
 *   off                         -> deactivate
 *   status                      -> report, change nothing
 *   anything else               -> usage error
 */
function handleCommand(ctx, invocation, readState) {
  const raw = typeof invocation.rawInput === "string" ? invocation.rawInput.trim() : "";
  const session = invocation.agent?.session;
  if (session === null || session === undefined) {
    return { kind: "error", text: "No active session for /omnissiah." };
  }

  // The harness has already committed `command/run` for this invocation; the
  // projection records the pending transition from its `args`. State is
  // committed only when the harness appends the matching successful
  // `command/done`, so this handler must not append anything itself.
  const current = readState(session);
  const parsed = parseArguments(raw, current.persona);

  if (parsed.kind === "status") return { kind: "success", text: statusText(current) };

  if (parsed.kind === "invalid") {
    return { kind: "error", text: `未知的人格「${parsed.name}」。\n${USAGE}` };
  }

  if (parsed.kind === "off") {
    if (!current.active) return { kind: "success", text: "万机之神处于静默（本就未激活）。" };
    return { kind: "success", text: "已退出万机之神。后续对话不再注入祷文。" };
  }

  // `on` keeps the current persona; a bare persona id switches and activates;
  // an empty argument activates with the currently selected persona.
  if (current.active && current.persona === parsed.persona) {
    return { kind: "success", text: `万机之神已处于激活状态。\n${statusText(current)}` };
  }

  const { persona: chosen } = resolvePersona(parsed.persona);
  return {
    kind: "success",
    text:
      `已进入「${chosen.title}」。\n` +
      "本会话后续每一轮都会把祷文注入系统提示词，并把你的需求织入其中。\n" +
      "用 /omnissiah off 退出。"
  };
}

/** Human-readable status line for `/omnissiah status`. */
function statusText(state) {
  const { persona } = resolvePersona(state.persona);
  return state.active
    ? `万机之神：已激活（人格 ${state.persona} — ${persona.title}）`
    : `万机之神：未激活（选中人格 ${state.persona}）`;
}

/**
 * Plugin entry point.
 *
 * Registers the (initially silent) prompt section and the `/omnissiah`
 * command. Both are disposed with the plugin's effect scope.
 */
function apply(ctx, config = {}) {
  const settings = {
    artifact: typeof config.artifact === "string" && config.artifact.trim().length > 0
      ? config.artifact.trim()
      : null,
    followUserRequest: config.followUserRequest !== false
  };

  // Both of these are declared in `inject`, so cordis has already resolved
  // them before `apply()` runs. Read them defensively anyway: a throw here
  // used to abort the whole plugin, leaving the command unregistered and
  // utterly silent — the worst possible failure mode for an opt-in feature.
  let sessionProjections = null;
  try {
    sessionProjections = ctx.sessionProjections ?? null;
  } catch (error) {
    ctx.logger?.warn?.(`[omnissiah] sessionProjections unavailable: ${String(error?.message ?? error)}`);
  }
  const readState = (session) => stateOf(sessionProjections, session);

  // Per-session activation state, folded from the session log.
  if (sessionProjections !== null) {
    sessionProjections.register(projectionDefinition);
  } else {
    ctx.logger?.warn?.(
      "[omnissiah] sessionProjections service unavailable; /omnissiah cannot persist activation state."
    );
  }

  // The prompt section always exists but is empty unless activated. Registering
  // it unconditionally (rather than on activation) keeps prompt assembly stable
  // and avoids mutating the prompt registry mid-session.
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    // 0 === DEPLOYMENT_PERSONA_PREFIX: stance first, tool guidance after.
    order: ctx.systemPrompt.getSectionOrder?.("DEPLOYMENT_PERSONA_PREFIX") ?? 0,
    text: (assemblyContext) => buildText(settings, sessionProjections, assemblyContext),
    // Our `{{task}}` / `{{artifact}}` slots are already resolved above; the
    // renderer must not treat them as prompt variables.
    interpolate: false
  });

  // `/omnissiah` — register before anything that could fail, so the command
  // always exists even if a later step misbehaves.
  //
  // `ctx.inject([...], cb)` is cordis' optional-injection form: the callback
  // runs once `commands` is available and is skipped entirely when no command
  // surface is mounted (headless/ACP deployments), which keeps this plugin
  // loadable there instead of failing.
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND_NAME,
      description: "Toggle the 万机之神 (Omnissiah) persona for this session",
      input: { hint: "[on|off|status|<persona>]" },
      handler: (invocation) => handleCommand(commandCtx, invocation, readState)
    });
  });

  ctx.logger?.info?.(
    `[omnissiah] ready (inactive by default). Use /${COMMAND_NAME} on to activate. ` +
    `Personas: ${PERSONA_IDS.join(", ")}`
  );
}

export { apply, inject, SECTION_NAME, PROJECTION_KEY, COMMAND_NAME, PERSONAS, PERSONA_IDS };
