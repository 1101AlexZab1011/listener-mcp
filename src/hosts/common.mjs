// @ts-check
// Helpers every host adapter uses: idempotent config merging, the skill file,
// and the session-start context text.
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerWhereAsked } from "../answer-rule.mjs";

// Ours whether called as `listener-mcp hook`, through npx, or as "<node>" "<…>/listener-mcp.mjs" hook.
const isOurs = (hook) => /listener-mcp(\.mjs)?"?\s+hook\b/.test(String(hook.command ?? ""));
const skillSource = fileURLToPath(new URL("../../skill/SKILL.md", import.meta.url));

export async function readJsonFile(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`${path} is not valid JSON: ${error.message}`); }
}

export async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Replace listener-mcp's entries for one hook event, leaving the user's own
 * hooks untouched. Works for both Claude Code and Codex, which share the
 * `{ hooks: { Event: [{ matcher?, hooks: [handler] }] } }` layout.
 */
export function setHook(config, event, handler, matcher) {
  config.hooks ??= {};
  const groups = (config.hooks[event] ?? [])
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) }))
    .filter((group) => group.hooks.length);
  groups.push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
  config.hooks[event] = groups;
  return config;
}

export function removeHooks(config) {
  for (const event of Object.keys(config.hooks ?? {})) {
    config.hooks[event] = config.hooks[event]
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) }))
      .filter((group) => group.hooks.length);
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  if (config.hooks && !Object.keys(config.hooks).length) delete config.hooks;
  return config;
}

export async function installSkill(directory) {
  const target = join(directory, "listener", "SKILL.md");
  await mkdir(dirname(target), { recursive: true });
  await copyFile(skillSource, target);
  return target;
}

// The name agent runtimes know the MCP server by: "agent-chat", what it is for. Installations made
// before carry the retired "listener"; init renames their entry and permission rules in place, and
// where both names are present drops the old one, so a session never starts the server twice.
// The program, its tools (listener_*) and its skill keep their names.
export const SERVER_NAME = "agent-chat";
export const RETIRED_SERVER_NAME = "listener";

const RETIRED_RULE = new RegExp(`^mcp__${RETIRED_SERVER_NAME}(?=$|__)`);

/**
 * Rename Claude Code permission rules for the retired server ("mcp__listener",
 * "mcp__listener__listener_wait") to the current one, in every list, without
 * repeating a rule already there. Returns whether anything changed.
 */
export function renamePermissionRules(settings) {
  let changed = false;
  for (const list of ["allow", "ask", "deny"]) {
    const rules = settings.permissions?.[list];
    if (!Array.isArray(rules)) continue;
    const renamed = [];
    for (const rule of rules) {
      const next = typeof rule === "string" ? rule.replace(RETIRED_RULE, `mcp__${SERVER_NAME}`) : rule;
      if (next !== rule) changed = true;
      if (!renamed.includes(next)) renamed.push(next); else changed = true;
    }
    settings.permissions[list] = renamed;
  }
  return changed;
}

/**
 * An `mcpServers` object with the retired entry renamed in place (its position kept), or dropped
 * when the current name is already there. Returns whether anything changed.
 */
export function renameServerEntry(container) {
  const servers = container?.mcpServers;
  if (!servers || !(RETIRED_SERVER_NAME in servers)) return false;
  if (SERVER_NAME in servers) { delete servers[RETIRED_SERVER_NAME]; return true; }
  container.mcpServers = Object.fromEntries(Object.entries(servers).map(([name, value]) => [name === RETIRED_SERVER_NAME ? SERVER_NAME : name, value]));
  return true;
}

/**
 * Codex's config.toml with the retired server's tables ([mcp_servers.listener] and its subtables)
 * renamed, or removed when the current name already has a table.
 */
export function renameCodexTables(text) {
  const head = (name) => new RegExp(`^\\[mcp_servers\\.${name.replace(/-/g, "\\-")}(\\.[^\\]]+)?\\]\\s*$`);
  const lines = text.split("\n");
  if (!lines.some((line) => head(RETIRED_SERVER_NAME).test(line))) return { text, changed: false };
  if (!lines.some((line) => head(SERVER_NAME).test(line))) {
    return { text: lines.map((line) => (head(RETIRED_SERVER_NAME).test(line) ? line.replace(`[mcp_servers.${RETIRED_SERVER_NAME}`, `[mcp_servers.${SERVER_NAME}`) : line)).join("\n"), changed: true };
  }
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) dropping = head(RETIRED_SERVER_NAME).test(line);
    if (!dropping) kept.push(line);
  }
  return { text: kept.join("\n"), changed: true };
}

/** Split a configured command like "npx --no-install listener-mcp" for MCP configs. */
export function splitCommand(command) {
  const parts = [...command.trim().matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) => (match[1] != null ? JSON.parse(`"${match[1]}"`) : match[2]));
  return { command: parts[0], args: parts.slice(1) };
}

/** How an agent starts the MCP server: on Windows npm installs CLIs as .cmd shims, which only cmd can start. */
export function serverCommand(command, os = process.platform) {
  const { command: bin, args } = splitCommand(command);
  if (os === "win32" && !/\.exe$/i.test(bin)) return { command: "cmd", args: ["/c", bin, ...args] };
  return { command: bin, args };
}

/** Context text a session-start hook gives the model. */
export function sessionContext({ agent, subscriptions, project, apps = [], mode }) {
  const lines = [`listener-mcp: this session's agent id is "${agent}".`];
  if (subscriptions.length) {
    lines.push(`It is attached to: ${subscriptions.map((sub) => sub.group).join(", ")}.`);
    lines.push(mode === "wake"
      ? "App events will wake this session as messages. Handle them, reply with listener_reply, then listener_ack."
      : "Call listener_wait to receive app events; handle them, reply with listener_reply, then listener_ack.");
    lines.push(answerWhereAsked({ tools: "mcp" }));
  } else if (project?.config.attach) {
    const { group, channels } = project.config.attach;
    lines.push(`To listen to this project's app, use the listener skill (listener_attach with session "${agent}"; default ${group ? `group ${group}` : ""}${channels ? ` on ${channels.join(", ")}` : ""}).`);
  }
  if (!subscriptions.length && apps.length) {
    lines.push(`Apps this session can listen to when the user asks: ${apps.map((app) => app.name).join(", ")} (listener_attach with session "${agent}" and app).`);
  }
  return lines.join("\n");
}
