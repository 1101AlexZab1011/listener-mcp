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
import { execFileSync } from "node:child_process";
import { agentIdentities, attachSession, formatEvents, sessionIdentities, waitForSession } from "../agent.mjs";
import { installSkill, readJsonFile, removeHooks, sessionContext, setHook, splitCommand, writeJsonFile } from "./common.mjs";

// Claude Code's hook runner uses a timer, and timers overflow at ~24.8 days,
// so the wait stays below that and re-arms on its own when it runs out.
const HOOK_TIMEOUT_S = 2_000_000;
const WAIT_MARGIN_S = 60;

export const claude = {
  name: "claude",
  mode: /** @type {const} */ ("wake"),
  agentId: (sessionId) => `claude:${sessionId}`,

  /**
   * Wire Claude Code into `root`. With scope "user", `root` is the home
   * directory: hooks and skill go to ~/.claude, and the MCP server is
   * registered in user scope through the `claude` CLI, which owns that file.
   */
  async install(root, { command, scope = "project" }) {
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

    const { command: bin, args } = splitCommand(command);
    const server = { type: "stdio", command: bin, args: [...args, "mcp"] };
    let mcpPath;
    if (scope === "user") {
      mcpPath = registerUserServer(server);
    } else {
      mcpPath = join(root, ".mcp.json");
      const mcp = await readJsonFile(mcpPath, {});
      mcp.mcpServers ??= {};
      mcp.mcpServers.listener = server;
      await writeJsonFile(mcpPath, mcp);
    }

    const skill = await installSkill(join(root, ".claude", "skills"));
    return [settingsPath, mcpPath, skill];
  },

  async uninstall(root, { scope = "project" } = {}) {
    const settingsPath = join(root, ".claude", "settings.json");
    const settings = await readJsonFile(settingsPath, null);
    if (settings) {
      removeHooks(settings);
      if (settings.permissions?.allow) settings.permissions.allow = settings.permissions.allow.filter((rule) => rule !== "mcp__listener");
      await writeJsonFile(settingsPath, settings);
    }
    if (scope === "user") {
      try { claudeCli(["mcp", "remove", "--scope", "user", "listener"]); } catch { /* not registered */ }
      return;
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
      let apps = [];
      try {
        const context = await agentIdentities({ cwd });
        ({ project, apps } = context);
        subscriptions = (await sessionIdentities(context.identities, agent)).flatMap((identity) => identity.subscriptions);
        if (!subscriptions.length && project?.config.auto_attach && context.fallback) {
          await attachSession(context.fallback.client, { agent, project, mode: "wake" });
          subscriptions = await context.fallback.client.subscriptions({ agent });
        }
      } catch { /* broker down: still tell the model who it is */ }
      return { exitCode: 0, stdout: sessionContext({ agent, subscriptions, project, apps, mode: "wake" }) };
    },

    async stop(input, { cwd, budgetS }) {
      if (!input.session_id) return { exitCode: 0 };
      const agent = claude.agentId(input.session_id);
      let identities;
      try { identities = await sessionIdentities((await agentIdentities({ cwd })).identities, agent); } catch { return { exitCode: 0 }; }
      if (!identities.length) return { exitCode: 0 };

      const result = await waitForSession(identities, agent, { budgetMs: budgetS * 1000, waiter: randomUUID() });
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

const claudeCli = (args) => execFileSync(process.platform === "win32" ? "claude.cmd" : "claude", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

/** Register the listener server in Claude Code's user scope, replacing an older entry. */
function registerUserServer(server) {
  const json = JSON.stringify(server);
  try { claudeCli(["mcp", "remove", "--scope", "user", "listener"]); } catch { /* not registered yet */ }
  try {
    claudeCli(["mcp", "add-json", "--scope", "user", "listener", json]);
    return "Claude Code user MCP config (claude mcp add-json --scope user listener)";
  } catch (error) {
    process.stderr.write(`warning: could not register the MCP server with the claude CLI (${error.message.split("\n")[0]}). Run:\n  claude mcp add-json --scope user listener '${json}'\n`);
    return "Claude Code user MCP config: not written, see the warning above";
  }
}
