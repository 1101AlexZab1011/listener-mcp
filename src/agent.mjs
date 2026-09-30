// @ts-check
// Agent-side building blocks shared by the hooks, the MCP server and the CLI:
// connecting to (and if needed starting) the broker, attaching a session with
// the project's defaults, and rendering events as text a model can act on.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brokerUrl, ensureConfig, files, loadConfig } from "./config.mjs";
import { ListenerClient } from "./client.mjs";
import { findProject } from "./project.mjs";

const cliPath = fileURLToPath(new URL("../bin/listener-mcp.mjs", import.meta.url));

/** A client for this project's agent credential (or the environment's token). */
export async function connect({ cwd = process.cwd(), env = process.env } = {}) {
  const project = await findProject(cwd);
  const client = await ListenerClient.fromEnvironment({ credential: project?.config.credential, env });
  return { client, project };
}

async function reachable(url) {
  try { return (await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}

/**
 * Make sure a broker answers, starting one in the background if not: the
 * installed service when there is one, otherwise a detached process.
 */
export async function ensureBroker({ env = process.env } = {}) {
  const config = await ensureConfig(env);
  const url = brokerUrl(config, env);
  if (await reachable(url)) return { url, started: false };
  const { startService } = await import("./service.mjs");
  if (!(await startService().catch(() => false))) {
    const log = openSync(files(env).log, "a", 0o600);
    spawn(process.execPath, [cliPath, "broker"], { detached: true, stdio: ["ignore", log, log], env }).unref();
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await reachable(url)) return { url, started: true };
  }
  throw new Error(`The listener-mcp broker did not come up at ${url}; see ${files(env).log}`);
}

export async function brokerAddress(env = process.env) {
  return brokerUrl(await loadConfig(env), env);
}

/** Attach `agent` using explicit options, falling back to the project's defaults. */
export async function attachSession(client, { agent, project, group, channels, from, mode }) {
  const defaults = project?.config.attach ?? {};
  const options = {
    agent,
    group: group ?? defaults.group,
    channels: channels ?? defaults.channels,
    from: from ?? defaults.from ?? "now",
    mode,
  };
  if (!options.group && !options.channels?.length) throw new Error("Nothing to attach to: pass channels (or a group), or set attach.channels in .listener-mcp.json");
  return client.attach(options);
}

const describeData = (data) => {
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.text === "string") {
    const { text, ...rest } = data;
    return Object.keys(rest).length ? `${text}\n    data: ${JSON.stringify(rest)}` : text;
  }
  return JSON.stringify(data);
};

/** Render leased events as instructions for the model. */
export function formatEvents(events, { agent, tools = "mcp" } = {}) {
  const lines = [`listener-mcp: ${events.length} event${events.length === 1 ? "" : "s"} for ${agent}.`, ""];
  events.forEach((event, index) => {
    const from = event.from.agent ? `${event.from.client} (${event.from.agent})` : event.from.client;
    lines.push(`[${index + 1}] ${event.channel} · ${event.type} · id ${event.id}${event.delivery?.attempt > 1 ? ` · attempt ${event.delivery.attempt}` : ""}`);
    lines.push(`    from: ${from}${event.reply_to ? ` · in reply to ${event.reply_to}` : ""}`);
    lines.push(`    ${describeData(event.data).split("\n").join("\n    ")}`);
    lines.push("");
  });
  const ids = events.map((event) => event.id).join(", ");
  lines.push(tools === "mcp"
    ? `Handle each event. When it expects an answer, use listener_reply with its event id. Then call listener_ack with session "${agent}" and event ids [${ids}]. Leave an event unacknowledged if handling failed, so it is redelivered.`
    : `Handle each event, reply with \`listener-mcp publish --reply-to <id>\`, then \`listener-mcp ack --agent ${agent} ${ids}\`.`);
  return lines.join("\n");
}

/** Read a hook's JSON input from stdin. */
export async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * Wait for events for `agent` across all its subscriptions, riding out broker
 * restarts. Resolves `{ events }`, or `{ ended: reason }` when the wait should
 * stop: time budget used up, or the session was detached or superseded.
 */
export async function waitForAgent(client, agent, { budgetMs, signal, waiter, max }) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ended: "timeout" };
    try {
      const result = await client.nextForAgent(agent, { waitMs: remaining, waiter, signal, max });
      if (result.events.length) return { events: result.events };
    } catch (error) {
      if (signal?.aborted) return { ended: "aborted" };
      if (["superseded", "detached", "not_found"].includes(error.code)) return { ended: error.code };
      if (error.status === 401 || error.status === 403) throw error;
      // Broker restarting or briefly unreachable: back off and keep listening.
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, deadline - Date.now()))));
    }
  }
}
