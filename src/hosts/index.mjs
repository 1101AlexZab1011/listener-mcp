// @ts-check
// The host registry. A host adapter teaches listener-mcp one agent runtime:
//
//   name       "claude", "codex", …
//   mode       "wake" if the runtime can wake an idle session from outside,
//              "poll" if the session must wait inside a turn
//   agentId    session id → agent id ("claude:<id>")
//   install    write the runtime's MCP config, hooks and skill into a project
//   uninstall  remove what install wrote
//   hooks      handlers for `listener-mcp hook <event> --host <name>`; each
//              gets the hook's stdin JSON and returns { exitCode, stdout?, stderr? }
//
// Supporting a new runtime means adding one module here.
import { claude } from "./claude.mjs";
import { codex } from "./codex.mjs";

export const hosts = { claude, codex };

export function host(name) {
  const found = hosts[name];
  if (!found) throw new Error(`Unknown host "${name}". Known hosts: ${Object.keys(hosts).join(", ")}`);
  return found;
}

/** The host a session belongs to, from its agent id prefix. */
export function hostOfAgent(agent) {
  const prefix = String(agent).split(":")[0];
  return hosts[prefix] ?? null;
}
