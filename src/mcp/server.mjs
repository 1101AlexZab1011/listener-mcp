// @ts-check
// The agent-facing MCP server: attach to apps, receive events, reply, ack.
// It is host-neutral; the session id the model passes (from its session-start
// context) tells it which host, and so which delivery mode, applies.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { attachSession, connect, ensureBroker, formatEvents, waitForAgent } from "../agent.mjs";
import { hostOfAgent } from "../hosts/index.mjs";

const HEARTBEAT_MS = 60_000;

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (error) => ({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
const tool = (fn) => async (params) => { try { return await fn(params); } catch (error) { return failure(error); } };

const session = z.string().min(1).max(128).describe('This session\'s agent id, e.g. "claude:…" or "codex:…", from the listener-mcp session context');

export async function runMcpServer({ cwd = process.cwd(), env = process.env } = {}) {
  await ensureBroker({ env }).catch(() => {});
  const server = new McpServer({ name: "listener-mcp", version: "0.1.0" });
  /** Sessions this process has worked for; their subscriptions are kept alive. */
  const sessions = new Set();
  const client = async () => (await connect({ cwd, env })).client;

  // While the model works on an event, its lease must not run out and its
  // subscription must not look abandoned. The heartbeat covers both.
  const heartbeat = setInterval(async () => {
    try {
      const c = await client();
      for (const agent of sessions) for (const sub of await c.subscriptions({ agent })) await c.touch(sub.id);
    } catch { /* broker restarting; next beat retries */ }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  server.registerTool("listener_status", {
    description: "Show the listener-mcp broker status and this session's subscriptions.",
    inputSchema: { session: session.optional() },
    annotations: { readOnlyHint: true },
  }, tool(async ({ session: agent }) => {
    const c = await client();
    const status = { broker: await c.health(), token: await c.whoami() };
    if (agent) Object.assign(status, { subscriptions: await c.subscriptions({ agent }) });
    return text(status);
  }));

  server.registerTool("listener_attach", {
    description: "Start listening to app events: attach this session to a group of channels. Without arguments beyond session, uses the project's defaults from .listener-mcp.json.",
    inputSchema: {
      session,
      group: z.string().optional().describe("Consumer group to join (members share its events)"),
      channels: z.array(z.string()).optional().describe('Channel patterns, e.g. ["mail/chat/*"]; needed when creating a group'),
      from: z.enum(["now", "earliest"]).optional().describe("For a new group: deliver only new events, or the backlog too"),
    },
  }, tool(async ({ session: agent, group, channels, from }) => {
    const connection = await connect({ cwd, env });
    const mode = hostOfAgent(agent)?.mode ?? "poll";
    const result = await attachSession(connection.client, { agent, project: connection.project, group, channels, from, mode });
    sessions.add(agent);
    const next = mode === "wake"
      ? "Now end your turn. Events will wake this session as messages; after handling each batch, end the turn again and the listener re-arms."
      : "Now call listener_wait. It returns when events arrive; handle them, then call listener_wait again.";
    return text(`Attached ${agent} to group ${result.group.name} (${result.group.channels.join(", ")}); ${result.pending} event(s) waiting.\n${next}`);
  }));

  server.registerTool("listener_detach", {
    description: "Stop listening: detach this session from one group, or from all of them.",
    inputSchema: { session, group: z.string().optional() },
  }, tool(async ({ session: agent, group }) => {
    const c = await client();
    const subs = (await c.subscriptions({ agent })).filter((sub) => !group || sub.group === group);
    for (const sub of subs) await c.detach(sub.id);
    if (!group) sessions.delete(agent);
    return text(subs.length ? `Detached from ${subs.map((sub) => sub.group).join(", ")}. The listener loop has ended.` : "This session was not attached.");
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
    const c = await client();
    const budgetMs = wait_seconds < 0 ? 86_400_000 : wait_seconds * 1000;
    const waiter = `mcp-${randomUUID()}`;
    const result = await waitForAgent(c, agent, { budgetMs, waiter, max });
    if (result.events) return text(formatEvents(result.events, { agent }));
    if (result.ended === "timeout") return text("No events yet. Call listener_wait again to keep listening.");
    return text(`The wait ended (${result.ended}). This session is no longer listening.`);
  }));

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
    const c = await client();
    const payload = { ...(data ?? {}), ...(body != null ? { text: body } : {}) };
    const event = await c.publish({ channel, data: payload, type, to, replyTo: reply_to, agent });
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
    const c = await client();
    const payload = { ...(data ?? {}), ...(body != null ? { text: body } : {}) };
    const reply = await c.reply(event_id, { data: payload, agent });
    return text({ replied: reply.id, channel: reply.channel });
  }));

  server.registerTool("listener_ack", {
    description: "Acknowledge handled events so they are not redelivered. Call after replying.",
    inputSchema: { session, event_ids: z.array(z.string()).min(1) },
  }, tool(async ({ session: agent, event_ids }) => text(await (await client()).ack(event_ids, { agent }))));

  server.registerTool("listener_nack", {
    description: "Give events back for redelivery, e.g. when handling failed.",
    inputSchema: { session, event_ids: z.array(z.string()).min(1) },
  }, tool(async ({ session: agent, event_ids }) => text(await (await client()).nack(event_ids, { agent }))));

  server.registerTool("listener_history", {
    description: "Read recent events on a channel or pattern (oldest first).",
    inputSchema: { channel: z.string(), after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).default(50) },
    annotations: { readOnlyHint: true },
  }, tool(async ({ channel, after, limit }) => {
    const c = await client();
    const events = after == null ? (await c.events({ channel, before: Number.MAX_SAFE_INTEGER, limit })) : await c.events({ channel, after, limit });
    return text(events);
  }));

  await server.connect(new StdioServerTransport());
}
