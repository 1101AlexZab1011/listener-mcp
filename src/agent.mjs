// @ts-check
// Agent-side building blocks shared by the hooks, the MCP server and the CLI:
// connecting to (and if needed starting) the broker, the credentials a session
// acts with, attaching with a project's or an app's defaults, and rendering
// events as text a model can act on.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brokerUrl, ensureConfig, files, loadConfig, readCredential } from "./config.mjs";
import { ListenerClient } from "./client.mjs";
import { listApps, loadApp } from "./apps.mjs";
import { findProject } from "./project.mjs";
import { covers, matches } from "./protocol.mjs";

const cliPath = fileURLToPath(new URL("../bin/listener-mcp.mjs", import.meta.url));

/** A client for this project's agent credential (or the environment's token). */
export async function connect({ cwd = process.cwd(), env = process.env } = {}) {
  const project = await findProject(cwd);
  const client = await ListenerClient.fromEnvironment({ credential: project?.config.credential, env });
  return { client, project };
}

/**
 * @typedef {{ name: string, client: ListenerClient, apps: import("./apps.mjs").App[], scopes?: Promise<string[]> }} Identity
 */

/**
 * The credentials an agent session acts with: first the default one (the
 * environment's token or credential, else the project's), then each
 * registered app's. Never the admin token: an app's agent credential carries
 * the app's limits, and they must hold wherever the session runs.
 *
 * @returns {Promise<{ url: string, project: any, apps: import("./apps.mjs").App[], identities: Identity[], fallback: Identity | null }>}
 */
export async function agentIdentities({ cwd = process.cwd(), env = process.env } = {}) {
  const project = await findProject(cwd);
  const apps = await listApps(env);
  const url = brokerUrl(await loadConfig(env), env);
  /** @type {Identity[]} */
  const identities = [];
  const add = (name, token, app) => {
    let identity = identities.find((entry) => entry.name === name);
    if (!identity) identities.push(identity = { name, client: new ListenerClient({ url, token }), apps: [] });
    if (app) identity.apps.push(app);
  };
  const defaultName = env.LISTENER_MCP_TOKEN ? "env" : project?.config.credential ?? env.LISTENER_MCP_CREDENTIAL;
  if (env.LISTENER_MCP_TOKEN) add("env", env.LISTENER_MCP_TOKEN);
  else if (defaultName) add(defaultName, await readCredential(defaultName, env).catch(missingCredential(defaultName)));
  for (const app of apps) {
    if (!app.credential) continue;
    // An app whose token was never saved is skipped here; attaching to it says why.
    const token = await readCredential(app.credential, env).catch(() => null);
    if (token) add(app.credential, token, app);
  }
  return { url, project, apps, identities, fallback: identities.find((identity) => identity.name === defaultName) ?? null };
}

const missingCredential = (name) => (error) => {
  if (error.code === "ENOENT") throw new Error(`No listener-mcp credential named "${name}". Create it with: listener-mcp token create --name ${name} --save`);
  throw error;
};

/** The identity an app's agents use: its own credential, else the session's default. */
export async function identityForApp(context, name, env = process.env) {
  const app = context.apps.find((entry) => entry.name === name) ?? (await loadApp(name, env));
  if (!app) throw new Error(`No app "${name}" is registered${context.apps.length ? ` (registered: ${context.apps.map((entry) => entry.name).join(", ")})` : ""}. Register it with: listener-mcp app add ${name} --channels '${name}/**'`);
  if (!app.credential) {
    if (!context.fallback) throw new Error(`App "${name}" names no credential and this session has no default one`);
    return { app, identity: context.fallback };
  }
  let identity = context.identities.find((entry) => entry.name === app.credential);
  if (!identity) {
    const token = await readCredential(app.credential, env).catch(missingCredential(app.credential));
    context.identities.push(identity = { name: app.credential, client: new ListenerClient({ url: context.url, token }), apps: [app] });
  }
  return { app, identity };
}

/**
 * The identities that hold subscriptions for `agent`, each with them. A token
 * only sees its own subscriptions, so no subscription is listed twice.
 * Identities the broker refuses (a revoked token) are skipped.
 */
export async function sessionIdentities(identities, agent) {
  const found = [];
  for (const identity of identities) {
    try {
      const subscriptions = await identity.client.subscriptions({ agent });
      if (subscriptions.length) found.push({ ...identity, subscriptions });
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) throw error;
    }
  }
  return found;
}

/** The scopes an identity's token carries, asked once per identity. */
function scopesOf(identity) {
  identity.scopes ??= identity.client.whoami().then((who) => who.scopes, () => []);
  return identity.scopes;
}

/**
 * The first identity allowed to `action` on `channel` (a concrete channel for
 * publish, a pattern for read), or null.
 */
export async function identityAllowed(identities, action, channel) {
  for (const identity of identities) {
    const scopes = await scopesOf(identity);
    const allowed = scopes.some((scope) => scope === "admin" || (scope.startsWith(`${action}:`) && (action === "publish" ? matches : covers)(scope.slice(action.length + 1), channel)));
    if (allowed) return identity;
  }
  return null;
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

/**
 * Attach `agent` using explicit options, falling back to an app's profile or
 * the project's defaults.
 */
export async function attachSession(client, { agent, project, app, group, channels, from, mode, takeover }) {
  const defaults = app ?? project?.config.attach ?? {};
  const options = {
    agent,
    group: group ?? defaults.group,
    channels: channels ?? defaults.channels,
    from: from ?? defaults.from ?? "now",
    mode,
    ...(defaults.exclusive != null ? { exclusive: defaults.exclusive } : {}),
    ...(takeover ? { takeover: true } : {}),
  };
  if (!options.group && !options.channels?.length) throw new Error("Nothing to attach to: pass an app, or channels (or a group), or set attach.channels in .listener-mcp.json");
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
 * Wait for events for `agent` across every identity that holds subscriptions
 * for it. One identity waits directly; several wait side by side, and the
 * first to receive events (or to be superseded by a newer waiter) ends the
 * others. Events that reach a second wait before it stops are kept.
 */
export async function waitForSession(identities, agent, { budgetMs, signal, waiter, max }) {
  if (identities.length === 1) return waitForAgent(identities[0].client, agent, { budgetMs, signal, waiter, max });
  if (!identities.length) return { ended: "not_found" };
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const waits = identities.map((identity) => waitForAgent(identity.client, agent, { budgetMs, signal: controller.signal, waiter, max }));
  const pending = new Map(waits.map((wait, index) => [index, wait.then((result) => ({ index, result }))]));
  const endings = [];
  try {
    while (pending.size) {
      const { index, result } = await Promise.race(pending.values());
      pending.delete(index);
      if (result.events || result.ended === "superseded") {
        controller.abort();
        const rest = await Promise.all(pending.values());
        const events = [result, ...rest.map((entry) => entry.result)].flatMap((entry) => entry.events ?? []);
        return events.length ? { events } : result;
      }
      endings.push(result.ended);
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  if (signal?.aborted) return { ended: "aborted" };
  return { ended: endings.includes("timeout") ? "timeout" : endings[0] };
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
