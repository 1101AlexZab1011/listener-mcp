// @ts-check
// The agent-facing MCP server: attach to apps, receive events, reply, ack.
// It is host-neutral; the session id the model passes (from its session-start
// context) tells it which host, and so which delivery mode, applies.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentIdentities, attachSession, ensureBroker, formatEvents, identityAllowed, identityForApp, sessionIdentities, waitForSession } from "../agent.mjs";
import { instanceOf, instanceOfGroup } from "../apps.mjs";
import { hostOfAgent } from "../hosts/index.mjs";

const HEARTBEAT_MS = 60_000;

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (error) => ({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
const tool = (fn) => async (params) => { try { return await fn(params); } catch (error) { return failure(error); } };

const session = z.string().min(1).max(128).describe('This session\'s agent id, e.g. "claude:…" or "codex:…", from the listener-mcp session context');

export async function runMcpServer({ cwd = process.cwd(), env = process.env } = {}) {
  await ensureBroker({ env }).catch(() => {});
  const server = new McpServer({ name: "listener-mcp", version: "0.1.2" });
  /** Sessions this process has worked for; their subscriptions are kept alive. */
  const sessions = new Set();
  // Read fresh on every call: credentials and app profiles can change while the session runs.
  const context = () => agentIdentities({ cwd, env });
  /** The identities holding this session's subscriptions. */
  const holding = async (agent) => sessionIdentities((await context()).identities, agent);

  // While the model works on an event, its lease must not run out and its
  // subscription must not look abandoned. The heartbeat covers both.
  const heartbeat = setInterval(async () => {
    try {
      for (const agent of sessions) for (const identity of await holding(agent)) for (const sub of identity.subscriptions) await identity.client.touch(sub.id);
    } catch { /* broker restarting; next beat retries */ }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  server.registerTool("listener_status", {
    description: "Show the listener-mcp broker status, the apps registered for this user, and this session's subscriptions.",
    inputSchema: { session: session.optional() },
    annotations: { readOnlyHint: true },
  }, tool(async ({ session: agent }) => {
    const { identities, apps } = await context();
    // Which app (and instance) a subscription belongs to, so the model can name it.
    const owner = (group) => {
      for (const app of apps) {
        if (app.group === group) return { app: app.name };
        const instance = instanceOfGroup(app, group);
        if (instance) return { app: app.name, instance };
      }
      return {};
    };
    const status = {
      broker: identities.length ? await identities[0].client.health() : "no agent credential here; register an app or work in a project",
      apps: apps.map(({ name, group, channels, exclusive, single_instance }) => ({ name, group, channels, exclusive: Boolean(exclusive), single_instance: Boolean(single_instance) })),
      credentials: await Promise.all(identities.map(async (identity) => ({
        name: identity.name,
        scopes: (await identity.client.whoami()).scopes,
        ...(agent ? { subscriptions: (await identity.client.subscriptions({ agent })).map((sub) => ({ ...sub, ...owner(sub.group) })) } : {}),
      }))),
    };
    return text(status);
  }));

  server.registerTool("listener_attach", {
    description: "Start listening to app events: attach this session to an app (by its registered name, plus an instance when the app has several) or to a group of channels. With only session, uses the project's defaults from .listener-mcp.json.",
    inputSchema: {
      session,
      app: z.string().optional().describe('A registered app, e.g. "mail" (see listener_status); works from any directory'),
      instance: z.string().optional().describe("For an app with one group per instance (a chat session, a document): which one"),
      group: z.string().optional().describe("Consumer group to join (members share its events)"),
      channels: z.array(z.string()).optional().describe('Channel patterns, e.g. ["mail/chat/*"]; needed when creating a group'),
      from: z.enum(["now", "earliest"]).optional().describe("For a new group: deliver only new events, or the backlog too"),
      takeover: z.boolean().optional().describe("Replace the agent attached to an exclusive group. Only when the user asked for it"),
    },
  }, tool(async ({ session: agent, app: appName, instance, group, channels, from, takeover }) => {
    const ctx = await context();
    const mode = hostOfAgent(agent)?.mode ?? "poll";
    let identity = ctx.fallback;
    let app = null;
    if (appName) ({ app, identity } = await identityForApp(ctx, appName, env));
    if (!identity) {
      const known = ctx.apps.map((entry) => entry.name);
      throw new Error(`No agent credential in ${cwd}: there is no .listener-mcp.json here or above.${known.length ? ` Pass app (registered: ${known.join(", ")}).` : " Register an app with listener-mcp app add, or run listener-mcp init in the project."}`);
    }
    const result = await attachSession(identity.client, { agent, project: app ? null : ctx.project, app, instance, group, channels, from, mode, takeover });
    sessions.add(agent);
    // single_instance: the agent leaves its other instances of this app, only once the new attach succeeded.
    const left = [];
    if (app?.single_instance) {
      const target = instanceOf(app, instance).group;
      for (const held of await holding(agent)) {
        for (const sub of held.subscriptions) {
          if (sub.group !== target && instanceOfGroup(app, sub.group)) { await held.client.detach(sub.id); left.push(sub.group); }
        }
      }
    }
    const next = mode === "wake"
      ? "Now end your turn. Events will wake this session as messages; after handling each batch, end the turn again and the listener re-arms."
      : "Now call listener_wait. It returns when events arrive; handle them, then call listener_wait again.";
    return text(`Attached ${agent} to group ${result.group.name} (${result.group.channels.join(", ")}${result.group.exclusive ? "; exclusive" : ""}); ${result.pending} event(s) waiting.${left.length ? ` Left ${left.join(", ")}.` : ""}\n${next}`);
  }));

  server.registerTool("listener_detach", {
    description: "Stop listening: detach this session from one group, or from all of them.",
    inputSchema: { session, group: z.string().optional() },
  }, tool(async ({ session: agent, group }) => {
    const left = [];
    for (const identity of await holding(agent)) {
      for (const sub of identity.subscriptions.filter((entry) => !group || entry.group === group)) {
        await identity.client.detach(sub.id);
        left.push(sub.group);
      }
    }
    if (!group) sessions.delete(agent);
    return text(left.length ? `Detached from ${left.join(", ")}. The listener loop has ended.` : "This session was not attached.");
  }));

  server.registerTool("listener_wait", {
    description: "Block until app events arrive for this session, then return them. The default wait_seconds of -1 waits indefinitely. Use in hosts that cannot wake an idle session.",
    inputSchema: {
      session,
      wait_seconds: z.number().int().min(-1).max(86_400).default(-1),
      max: z.number().int().min(1).max(50).default(10),
    },
    annotations: { readOnlyHint: false },
  }, tool(async ({ session: agent, wait_seconds, max }) => {
    sessions.add(agent);
    const identities = await holding(agent);
    if (!identities.length) return text("This session is not attached. Call listener_attach first.");
    const budgetMs = wait_seconds < 0 ? 86_400_000 : wait_seconds * 1000;
    const waiter = `mcp-${randomUUID()}`;
    const result = await waitForSession(identities, agent, { budgetMs, waiter, max });
    if (result.events) return text(formatEvents(result.events, { agent }));
    if (result.ended === "timeout") return text("No events yet. Call listener_wait again to keep listening.");
    return text(`The wait ended (${result.ended}). This session is no longer listening.`);
  }));

  /** The identity to publish on `channel` with: this session's first, then any allowed one. */
  const publisher = async (agent, channel) => {
    const { identities } = await context();
    const preferred = agent ? await holding(agent) : [];
    const identity = await identityAllowed([...preferred, ...identities], "publish", channel);
    if (!identity) throw new Error(`No agent credential here may publish on ${channel}`);
    return identity;
  };

  server.registerTool("listener_publish", {
    description: "Publish an event on an app channel (e.g. a message into an app's chat).",
    inputSchema: {
      channel: z.string(),
      text: z.string().max(100_000).optional(),
      data: z.record(z.string(), z.any()).optional().describe("Structured payload; merged with text as data.text"),
      type: z.string().optional(),
      to: z.string().optional().describe("Address the event to one agent id"),
      reply_to: z.string().optional(),
      session: session.optional(),
    },
  }, tool(async ({ channel, text: body, data, type, to, reply_to, session: agent }) => {
    const { client } = await publisher(agent, channel);
    const payload = { ...(data ?? {}), ...(body != null ? { text: body } : {}) };
    const event = await client.publish({ channel, data: payload, type, to, replyTo: reply_to, agent });
    return text({ published: event.id, channel: event.channel, seq: event.seq });
  }));

  server.registerTool("listener_reply", {
    description: "Reply to an event on its own channel, e.g. answer a chat message.",
    inputSchema: {
      event_id: z.string(),
      text: z.string().max(100_000).optional(),
      data: z.record(z.string(), z.any()).optional(),
      session: session.optional(),
    },
  }, tool(async ({ event_id, text: body, data, session: agent }) => {
    const { identities } = await context();
    const preferred = agent ? await holding(agent) : [];
    let original = null;
    for (const identity of [...preferred, ...identities]) {
      original = await identity.client.event(event_id).catch(() => null);
      if (original) break;
    }
    if (!original) throw new Error(`No agent credential here can read event ${event_id}`);
    const { client } = await publisher(agent, original.channel);
    const payload = { ...(data ?? {}), ...(body != null ? { text: body } : {}) };
    const reply = await client.reply(original, { data: payload, agent });
    return text({ replied: reply.id, channel: reply.channel });
  }));

  /** Settle events with every identity holding this session's subscriptions. */
  const settle = async (agent, event_ids, outcome) => {
    const results = new Map(event_ids.map((id) => [id, "not_found"]));
    for (const identity of await holding(agent)) {
      for (const entry of (await identity.client[outcome](event_ids, { agent })).results) {
        if (entry.result !== "not_found") results.set(entry.event_id, entry.result);
      }
    }
    return { results: [...results].map(([event_id, result]) => ({ event_id, result })) };
  };

  server.registerTool("listener_ack", {
    description: "Acknowledge handled events so they are not redelivered. Call after replying.",
    inputSchema: { session, event_ids: z.array(z.string()).min(1) },
  }, tool(async ({ session: agent, event_ids }) => text(await settle(agent, event_ids, "ack"))));

  server.registerTool("listener_nack", {
    description: "Give events back for redelivery, e.g. when handling failed.",
    inputSchema: { session, event_ids: z.array(z.string()).min(1) },
  }, tool(async ({ session: agent, event_ids }) => text(await settle(agent, event_ids, "nack"))));

  server.registerTool("listener_history", {
    description: "Read recent events on a channel or pattern (oldest first).",
    inputSchema: { channel: z.string(), after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).default(50) },
    annotations: { readOnlyHint: true },
  }, tool(async ({ channel, after, limit }) => {
    const identity = await identityAllowed((await context()).identities, "read", channel);
    if (!identity) throw new Error(`No agent credential here may read ${channel}`);
    const c = identity.client;
    const events = after == null ? (await c.events({ channel, before: Number.MAX_SAFE_INTEGER, limit })) : await c.events({ channel, after, limit });
    return text(events);
  }));

  await server.connect(new StdioServerTransport());
}
