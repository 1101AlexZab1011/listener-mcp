// @ts-check
// Helpers every host adapter uses: idempotent config merging, the skill file,
// and the session-start context text.
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_MARKER = "listener-mcp hook";
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
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !String(hook.command ?? "").includes(HOOK_MARKER)) }))
    .filter((group) => group.hooks.length);
  groups.push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
  config.hooks[event] = groups;
  return config;
}

export function removeHooks(config) {
  for (const event of Object.keys(config.hooks ?? {})) {
    config.hooks[event] = config.hooks[event]
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !String(hook.command ?? "").includes(HOOK_MARKER)) }))
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

/** Split a configured command like "npx --no-install listener-mcp" for MCP configs. */
export function splitCommand(command) {
  const parts = [...command.trim().matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) => (match[1] != null ? JSON.parse(`"${match[1]}"`) : match[2]));
  return { command: parts[0], args: parts.slice(1) };
}

/** Context text a session-start hook gives the model. */
export function sessionContext({ agent, subscriptions, project, mode }) {
  const lines = [`listener-mcp: this session's agent id is "${agent}".`];
  if (subscriptions.length) {
    lines.push(`It is attached to: ${subscriptions.map((sub) => sub.group).join(", ")}.`);
    lines.push(mode === "wake"
      ? "App events will wake this session as messages. Handle them, reply with listener_reply, then listener_ack."
      : "Call listener_wait to receive app events; handle them, reply with listener_reply, then listener_ack.");
  } else if (project?.config.attach) {
    const { group, channels } = project.config.attach;
    lines.push(`To listen to this project's app, use the listener skill (listener_attach with session "${agent}"; default ${group ? `group ${group}` : ""}${channels ? ` on ${channels.join(", ")}` : ""}).`);
  }
  return lines.join("\n");
}
