// @ts-check
// Codex adapter.
//
// Codex has no way to wake an idle session, so a listening Codex session waits
// *inside* its turn: the Stop hook blocks on the broker and, when events
// arrive, returns `decision: "block"` with the events as the continuation
// prompt. The session is busy while it listens. Where hooks do not run (the
// IDE extension, at the time of writing), the listener_wait MCP tool does the
// same job from inside the turn.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentIdentities, attachSession, formatEvents, sessionIdentities, waitForSession } from "../agent.mjs";
import { installSkill, readJsonFile, removeHooks, sessionContext, setHook, splitCommand, writeJsonFile } from "./common.mjs";

const HOOK_TIMEOUT_S = 86_400;
const WAIT_MARGIN_S = 60;

const toml = (value) => JSON.stringify(value);

export const codex = {
  name: "codex",
  mode: /** @type {const} */ ("poll"),
  agentId: (sessionId) => `codex:${sessionId}`,

  /** Wire Codex into `root`: a project, or the home directory for every session (~/.codex, ~/.agents). */
  async install(root, { command }) {
    const hooksPath = join(root, ".codex", "hooks.json");
    const hooks = await readJsonFile(hooksPath, {});
    setHook(hooks, "SessionStart", { type: "command", command: `${command} hook session-start --host codex`, timeout: 15 }, "startup|resume|clear|compact");
    setHook(hooks, "Stop", { type: "command", command: `${command} hook stop --host codex --budget ${HOOK_TIMEOUT_S - WAIT_MARGIN_S}`, timeout: HOOK_TIMEOUT_S });
    await writeJsonFile(hooksPath, hooks);

    const configPath = join(root, ".codex", "config.toml");
    let existing = "";
    try { existing = await readFile(configPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!/^\[mcp_servers\.listener\]/m.test(existing)) {
      const { command: bin, args } = splitCommand(command);
      const block = [
        "",
        "# listener-mcp: lets apps reach this agent (see .listener-mcp.json)",
        "[mcp_servers.listener]",
        `command = ${toml(bin)}`,
        `args = [${[...args, "mcp"].map(toml).join(", ")}]`,
        // listener_wait blocks until an app event arrives.
        `tool_timeout_sec = ${HOOK_TIMEOUT_S}`,
        "",
      ].join("\n");
      await mkdir(dirname(configPath), { recursive: true });
      await appendFile(configPath, block);
    }
    const skill = await installSkill(join(root, ".agents", "skills"));
    return [hooksPath, configPath, skill];
  },

  async uninstall(root) {
    const hooksPath = join(root, ".codex", "hooks.json");
    const hooks = await readJsonFile(hooksPath, null);
    if (hooks) await writeJsonFile(hooksPath, removeHooks(hooks));
  },

  hooks: {
    async "session-start"(input, { cwd }) {
      if (!input.session_id) return { exitCode: 0 };
      const agent = codex.agentId(input.session_id);
      let subscriptions = [];
      let project = null;
      let apps = [];
      try {
        const context = await agentIdentities({ cwd });
        ({ project, apps } = context);
        subscriptions = (await sessionIdentities(context.identities, agent)).flatMap((identity) => identity.subscriptions);
        if (!subscriptions.length && project?.config.auto_attach && context.fallback) {
          await attachSession(context.fallback.client, { agent, project, mode: "poll" });
          subscriptions = await context.fallback.client.subscriptions({ agent });
        }
      } catch { /* broker down: still tell the model who it is */ }
      return { exitCode: 0, stdout: sessionContext({ agent, subscriptions, project, apps, mode: "poll" }) };
    },

    async stop(input, { cwd, budgetS }) {
      if (!input.session_id) return { exitCode: 0 };
      const agent = codex.agentId(input.session_id);
      let identities;
      try { identities = await sessionIdentities((await agentIdentities({ cwd })).identities, agent); } catch { return { exitCode: 0 }; }
      if (!identities.length) return { exitCode: 0 };

      const result = await waitForSession(identities, agent, { budgetMs: budgetS * 1000, waiter: randomUUID() });
      if (result.events) return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason: formatEvents(result.events, { agent }) }) };
      if (result.ended === "timeout") {
        return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason: "listener-mcp: no app events for a long while. Reply with just \"listening\" and end the turn so the listener re-arms." }) };
      }
      return { exitCode: 0 };
    },
  },
};

