// @ts-check
// Claude Code adapter.
//
// Claude Code can wake an idle session: an `asyncRewake` hook runs in the
// background and, when it exits with code 2, its stderr is delivered to the
// model as a new message. So the Stop hook parks on the broker *after* the
// turn has ended. The session stays free for the user, and an app event wakes
// it. When the woken turn ends, Stop fires again and the next wait begins.
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, formatEvents, waitForAgent, attachSession } from "../agent.mjs";
import { installSkill, readJsonFile, removeHooks, sessionContext, setHook, splitCommand, writeJsonFile } from "./common.mjs";

// Claude Code's hook runner uses a timer, and timers overflow at ~24.8 days,
// so the wait stays below that and re-arms on its own when it runs out.
const HOOK_TIMEOUT_S = 2_000_000;
const WAIT_MARGIN_S = 60;

export const claude = {
  name: "claude",
  mode: /** @type {const} */ ("wake"),
  agentId: (sessionId) => `claude:${sessionId}`,

  async install(root, { command }) {
    const settingsPath = join(root, ".claude", "settings.json");
    const settings = await readJsonFile(settingsPath, {});
    setHook(settings, "SessionStart", { type: "command", command: `${command} hook session-start --host claude`, timeout: 15 });
    setHook(settings, "Stop", {
      type: "command",
      command: `${command} hook stop --host claude --budget ${HOOK_TIMEOUT_S - WAIT_MARGIN_S}`,
      asyncRewake: true,
      timeout: HOOK_TIMEOUT_S,
      rewakeMessage: "listener-mcp delivered app events:",
      rewakeSummary: "listener-mcp event",
    });
    settings.permissions ??= {};
    settings.permissions.allow ??= [];
    if (!settings.permissions.allow.includes("mcp__listener")) settings.permissions.allow.push("mcp__listener");
    await writeJsonFile(settingsPath, settings);

    const mcpPath = join(root, ".mcp.json");
    const mcp = await readJsonFile(mcpPath, {});
    mcp.mcpServers ??= {};
    const { command: bin, args } = splitCommand(command);
    mcp.mcpServers.listener = { type: "stdio", command: bin, args: [...args, "mcp"] };
    await writeJsonFile(mcpPath, mcp);

    const skill = await installSkill(join(root, ".claude", "skills"));
    return [settingsPath, mcpPath, skill];
  },

  async uninstall(root) {
    const settingsPath = join(root, ".claude", "settings.json");
    const settings = await readJsonFile(settingsPath, null);
    if (settings) {
      removeHooks(settings);
      if (settings.permissions?.allow) settings.permissions.allow = settings.permissions.allow.filter((rule) => rule !== "mcp__listener");
      await writeJsonFile(settingsPath, settings);
    }
    const mcpPath = join(root, ".mcp.json");
    const mcp = await readJsonFile(mcpPath, null);
    if (mcp?.mcpServers?.listener) { delete mcp.mcpServers.listener; await writeJsonFile(mcpPath, mcp); }
  },

  hooks: {
    async "session-start"(input, { cwd }) {
      if (!input.session_id) return { exitCode: 0 };
      const agent = claude.agentId(input.session_id);
      let subscriptions = [];
      let project = null;
      try {
        const connection = await connect({ cwd });
        project = connection.project;
        subscriptions = await connection.client.subscriptions({ agent });
        if (!subscriptions.length && project?.config.auto_attach) {
          await attachSession(connection.client, { agent, project, mode: "wake" });
          subscriptions = await connection.client.subscriptions({ agent });
        }
      } catch { /* broker down: still tell the model who it is */ }
      return { exitCode: 0, stdout: sessionContext({ agent, subscriptions, project, mode: "wake" }) };
    },

    async stop(input, { cwd, budgetS }) {
      if (!input.session_id) return { exitCode: 0 };
      const agent = claude.agentId(input.session_id);
      let connection;
      try { connection = await connect({ cwd }); } catch { return { exitCode: 0 }; }
      let subscriptions;
      try { subscriptions = await connection.client.subscriptions({ agent }); } catch { return { exitCode: 0 }; }
      if (!subscriptions.length) return { exitCode: 0 };

      const result = await waitForAgent(connection.client, agent, { budgetMs: budgetS * 1000, waiter: randomUUID() });
      if (result.events) return { exitCode: 2, stderr: formatEvents(result.events, { agent }) };
      if (result.ended === "timeout") {
        // The hook is about to be killed by its own timeout. Waking the model
        // once is the only way to get a fresh Stop hook, so ask for a no-op turn.
        return { exitCode: 2, stderr: "listener-mcp: no app events for a long while. Reply with just \"listening\" and end the turn so the listener re-arms." };
      }
      return { exitCode: 0 };
    },
  },
};
