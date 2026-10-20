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
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { files, writePrivate } from "./config.mjs";

const appName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** @typedef {{ name: string, credential?: string, group: string, channels: string[], from?: "now" | "earliest", exclusive?: boolean }} App */

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
