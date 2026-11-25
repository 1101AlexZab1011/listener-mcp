// Answer where you were asked (Thoth F55): an app's message is answered in the app only, with nothing in
// the agent's own conversation; what the person types there is answered there; the one exception is an
// app that cannot carry the answer. Said wherever an agent learns how to handle app events, for Claude
// Code and Codex alike: the session-start context, each delivery notice, the MCP server's instructions
// and the bundled skill.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_INSTRUCTIONS, answerWhereAsked } from "../src/answer-rule.mjs";
import { formatEvents } from "../src/agent.mjs";
import { sessionContext } from "../src/hosts/common.mjs";

const RULE = /Answer where you were asked: an app event .* is answered only in that app/;
const event = { id: "evt_1", channel: "mail/chat/default", type: "message", data: { text: "Which branch?" }, from: { client: "thoth" }, delivery: { attempt: 1 } };

test("the rule: in the app only, nothing in the agent's own conversation, its own questions there, one line when the app can't carry it", () => {
  const rule = answerWhereAsked();
  assert.match(rule, RULE);
  assert.match(rule, /with listener_reply/);
  assert.match(rule, /Write nothing about it in your own conversation: no copy of the answer, no summary, no closing line/);
  assert.match(rule, /A message typed in your own conversation is answered there/);
  assert.match(rule, /Only when the app cannot carry the answer .* one short line/);
  assert.match(answerWhereAsked({ tools: "cli" }), /with `listener-mcp publish --reply-to <id>`/);
});

test("a session attached to an app is told the rule at start, in wake and in poll mode; one that is not attached is not", () => {
  for (const mode of ["wake", "poll"]) {
    const text = sessionContext({ agent: "claude:s1", subscriptions: [{ group: "mail" }], mode });
    assert.match(text, RULE, mode);
  }
  assert.doesNotMatch(sessionContext({ agent: "codex:s2", subscriptions: [], mode: "wake" }), RULE);
});

test("every delivery notice carries the rule, for MCP tools and for the CLI", () => {
  const mcp = formatEvents([event], { agent: "claude:s1" });
  assert.match(mcp, RULE);
  assert.match(mcp, /with listener_reply\./);
  const cli = formatEvents([event], { agent: "codex:s2", tools: "cli" });
  assert.match(cli, RULE);
  assert.match(cli, /listener-mcp publish --reply-to <id>/);
});

test("the MCP server sends the rule as its instructions at initialize, to any client", async () => {
  assert.match(MCP_INSTRUCTIONS, RULE);
  // The server is built with them (src/mcp/server.mjs), and the SDK hands them over at initialize.
  const source = await readFile(new URL("../src/mcp/server.mjs", import.meta.url), "utf8");
  assert.match(source, /new McpServer\(\{ name: "listener-mcp", version: "[^"]+" \}, \{ instructions: MCP_INSTRUCTIONS \}\)/);
  const server = new McpServer({ name: "listener-mcp", version: "test" }, { instructions: MCP_INSTRUCTIONS });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "codex", version: "test" });
  await client.connect(clientSide);
  assert.equal(client.getInstructions(), MCP_INSTRUCTIONS);
  await client.close();
  await server.close();
});

test("the bundled skill says it too", async () => {
  const skill = await readFile(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /## Answer where you were asked/);
  assert.match(skill, /answered only in that app, with `listener_reply`/);
  assert.match(skill, /End the turn without text/);
});
