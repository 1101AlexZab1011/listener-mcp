// @ts-check
// Where listener-mcp keeps its files, and how clients find the broker.
//
//   config dir  config.json, admin.token, credentials/<name>.token   (0700/0600)
//   state dir   broker.db, blobs/, broker.log                          (0700)
//
// LISTENER_MCP_HOME puts both under one directory, which is what tests and
// isolated setups (a second broker on another port) use.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_HOST, DEFAULT_PORT } from "./protocol.mjs";

export function paths(env = process.env) {
  if (env.LISTENER_MCP_HOME) {
    const home = resolve(env.LISTENER_MCP_HOME);
    return { config: home, state: home };
  }
  const os = platform();
  if (os === "darwin") {
    const base = join(homedir(), "Library", "Application Support", "listener-mcp");
    return { config: base, state: base };
  }
  if (os === "win32") {
    const base = join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "listener-mcp");
    return { config: base, state: base };
  }
  return {
    config: join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "listener-mcp"),
    state: join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "listener-mcp"),
  };
}

export const files = (env = process.env) => {
  const dirs = paths(env);
  return {
    ...dirs,
    config: join(dirs.config, "config.json"),
    configDir: dirs.config,
    adminToken: join(dirs.config, "admin.token"),
    credentials: join(dirs.config, "credentials"),
    database: join(dirs.state, "broker.db"),
    blobs: join(dirs.state, "blobs"),
    log: join(dirs.state, "broker.log"),
  };
};

/** Write a file only its owner can read, atomically. */
export async function writePrivate(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => {});
}

export const defaultConfig = () => ({
  version: 1,
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  limits: {
    event_bytes: 256 * 1024,
    blob_bytes: 25 * 1024 * 1024,
    lease_ms: 15 * 60_000,
    max_attempts: 10,
    retention_days: 30,
  },
});

export async function loadConfig(env = process.env) {
  const defaults = defaultConfig();
  let stored = {};
  try { stored = JSON.parse(await readFile(files(env).config, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const config = { ...defaults, ...stored, limits: { ...defaults.limits, ...(stored.limits ?? {}) } };
  if (env.LISTENER_MCP_PORT) config.port = Number(env.LISTENER_MCP_PORT);
  // The broker never listens beyond loopback: tokens travel in clear HTTP.
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) throw new Error(`listener-mcp only binds to loopback, got host ${config.host}`);
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error(`Invalid port ${config.port}`);
  return config;
}

export async function ensureConfig(env = process.env) {
  const f = files(env);
  await mkdir(f.configDir, { recursive: true, mode: 0o700 });
  await mkdir(f.state, { recursive: true, mode: 0o700 });
  try { await readFile(f.config, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writePrivate(f.config, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
  }
  return loadConfig(env);
}

export function brokerUrl(config, env = process.env) {
  if (env.LISTENER_MCP_URL) return env.LISTENER_MCP_URL.replace(/\/$/, "");
  const host = config.host === "::1" ? "[::1]" : config.host;
  return `http://${host}:${config.port}`;
}

const credentialName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function credentialPath(name, env = process.env) {
  if (!credentialName.test(name)) throw new Error(`Invalid credential name ${JSON.stringify(name)}`);
  return join(files(env).credentials, `${name}.token`);
}

export async function readCredential(name, env = process.env) {
  return (await readFile(credentialPath(name, env), "utf8")).trim();
}

export async function saveCredential(name, token, env = process.env) {
  await writePrivate(credentialPath(name, env), `${token}\n`);
  return credentialPath(name, env);
}

export async function readAdminToken(env = process.env) {
  return (await readFile(files(env).adminToken, "utf8")).trim();
}

/**
 * Resolve the token a client should use, most specific first:
 * LISTENER_MCP_TOKEN, a named credential, then the admin token.
 */
export async function resolveToken({ credential, env = process.env } = {}) {
  if (env.LISTENER_MCP_TOKEN) return env.LISTENER_MCP_TOKEN;
  const name = credential ?? env.LISTENER_MCP_CREDENTIAL;
  if (name) {
    try { return await readCredential(name, env); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error(`No listener-mcp credential named "${name}". Create it with: listener-mcp token create --name ${name} --save`);
      throw error;
    }
  }
  try { return await readAdminToken(env); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("No listener-mcp token found. Start the broker once (listener-mcp broker) or set LISTENER_MCP_TOKEN.");
    throw error;
  }
}
