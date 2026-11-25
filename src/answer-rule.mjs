// @ts-check
// Answer where you were asked (Thoth F55). An app event - a message from Agent Chat on the desktop or a
// phone, or any other app's request - is answered in that app, and only there: the person reads the app,
// not the agent's own conversation, and a copy there is noise. What the person types in the agent's own
// conversation is answered there, as always. The one exception: when the app cannot carry the answer
// (the broker is down, the reply fails), one short line in the agent's own conversation says so.
//
// It is said wherever an agent learns how to handle app events, so Claude Code and Codex follow it with
// no memory of their own: the session-start context (hosts/common.mjs sessionContext), each delivery
// notice (agent.mjs formatEvents) and the MCP server's instructions (mcp/server.mjs).

/** The rule, for an agent that replies with the MCP tools (`mcp`) or the CLI (`cli`). */
export function answerWhereAsked({ tools = "mcp" } = {}) {
  const reply = tools === "mcp" ? "listener_reply" : "`listener-mcp publish --reply-to <id>`";
  return [
    `Answer where you were asked: an app event (a message from Agent Chat on the desktop or a phone, or any app's request) is answered only in that app, with ${reply}.`,
    "Write nothing about it in your own conversation: no copy of the answer, no summary, no closing line.",
    "A message typed in your own conversation is answered there.",
    "Only when the app cannot carry the answer (the broker is down, the reply fails) say so in one short line in your own conversation.",
  ].join(" ");
}

/** The MCP server's instructions (sent to every client at initialize). */
export const MCP_INSTRUCTIONS = [
  "listener-mcp connects this agent session to apps such as Thoth's Agent Chat. App events arrive as messages (or from listener_wait); handle each, answer with listener_reply when it expects an answer, then listener_ack.",
  answerWhereAsked({ tools: "mcp" }),
].join("\n");
