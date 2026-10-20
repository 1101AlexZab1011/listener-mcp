// @ts-check
// App profiles: how agents reach one app, registered once per user so any
// session can attach to it from any directory. A profile holds no secrets:
// `credential` names the agent token for this app, saved next to the others.
//
//   <config dir>/apps/mail.json
//   {
//     "version": 1,
//     "credential": "email-agent",
//     "group": "mail-agent",
//     "channels": ["mail/chat/**", "mail/replies/**"],
//     "from": "now",
//     "exclusive": true
//   }
//
// The app decides its policy (which group, whether it takes one agent); the
// protocol only carries it. A project's `.listener-mcp.json` stays the default
// for agents working in that project.
//
// An app with several independent conversations (chat sessions, documents,
// rooms) uses an `{instance}` placeholder in `group` and `channels`: each
// instance is its own group, created on first attach.
//
//   "group": "mail-chat-{instance}",
//   "channels": ["mail/chat/{instance}", "mail/replies/{instance}/**"],
//   "single_instance": true            an agent holds one instance at a time
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { files, writePrivate } from "./config.mjs";

const appName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** @typedef {{ name: string, credential?: string, group: string, channels: string[], from?: "now" | "earliest", exclusive?: boolean, single_instance?: boolean }} App */

const PLACEHOLDER = "{instance}";
const instancePattern = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const instanceName = new RegExp(`^${instancePattern}$`);

/** Does the profile describe one group per instance? @param {App} app */
export const hasInstances = (app) => app.group.includes(PLACEHOLDER) || app.channels.some((pattern) => pattern.includes(PLACEHOLDER));

/**
 * The group and channels of one instance of `app`. An app with a placeholder
 * needs an instance, which must be a valid channel segment; one without
 * refuses it.
 * @param {App} app
 * @param {string | undefined} instance
 */
export function instanceOf(app, instance) {
  if (!hasInstances(app)) {
    if (instance != null) throw new Error(`App "${app.name}" has no instances; attach without instance`);
    return { group: app.group, channels: app.channels };
  }
  if (instance == null) throw new Error(`App "${app.name}" has one group per instance; pass instance`);
  if (typeof instance !== "string" || !instanceName.test(instance)) throw new Error(`Invalid instance ${JSON.stringify(instance)}: use [A-Za-z0-9._-], starting with a letter or digit`);
  const fill = (value) => value.split(PLACEHOLDER).join(instance);
  return { group: fill(app.group), channels: app.channels.map(fill) };
}

/** The instance a group belongs to, if it is one of `app`'s groups (null otherwise). @param {App} app */
export function instanceOfGroup(app, group) {
  if (!app.group.includes(PLACEHOLDER)) return null;
  const escaped = app.group.split(PLACEHOLDER).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const match = new RegExp(`^${escaped.join(`(${instancePattern})`)}$`).exec(group);
  return match ? match[1] : null;
}

export function assertAppName(name) {
  if (typeof name !== "string" || !appName.test(name)) throw new Error(`Invalid app name ${JSON.stringify(name)}: use [A-Za-z0-9._-], e.g. "mail"`);
  return name;
}

const appPath = (name, env) => join(files(env).apps, `${assertAppName(name)}.json`);

/** @returns {Promise<App | null>} */
export async function loadApp(name, env = process.env) {
  try {
    const config = JSON.parse(await readFile(appPath(name, env), "utf8"));
    if (config.version !== 1) throw new Error(`${appPath(name, env)}: unsupported version ${config.version}`);
    const { version, ...profile } = config;
    return { ...profile, name };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Every registered app, by name. @returns {Promise<App[]>} */
export async function listApps(env = process.env) {
  let entries = [];
  try { entries = await readdir(files(env).apps); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const names = entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -5)).filter((name) => appName.test(name)).sort();
  const apps = await Promise.all(names.map((name) => loadApp(name, env)));
  return /** @type {App[]} */ (apps.filter(Boolean));
}

/** @param {App} app */
export async function saveApp(app, env = process.env) {
  const { name, ...profile } = app;
  const path = appPath(name, env);
  await writePrivate(path, `${JSON.stringify({ version: 1, ...profile }, null, 2)}\n`);
  return path;
}

export async function removeApp(name, env = process.env) {
  const path = appPath(name, env);
  await rm(path, { force: true });
  return path;
}
