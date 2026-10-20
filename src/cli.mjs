// @ts-check
// `listener-mcp <command>`: run the broker, wire projects to agents, and poke
// at the bus from a shell.
import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { brokerUrl, ensureConfig, files, loadConfig, readAdminToken, readCredential, saveCredential, credentialPath } from "./config.mjs";
import { ListenerClient } from "./client.mjs";
import { ensureBroker, formatEvents, readStdinJson, connect } from "./agent.mjs";
import { assertAppName, listApps, loadApp, removeApp, saveApp } from "./apps.mjs";
import { findProject, writeProject } from "./project.mjs";
import { covers } from "./protocol.mjs";
import { host, hosts } from "./hosts/index.mjs";

const HELP = `listener-mcp: let apps reach coding agents.

Broker
  broker                         run the broker in the foreground
  service install|uninstall|status
                                 run the broker as a per-user service (systemd/launchd)
  status [pattern]               broker health, groups and who is listening
  doctor                         check the setup of this machine and project

Projects
  init [--agent claude,codex] [--channels 'app/**'] [--group name] [--from now|earliest]
       [--credential name] [--command listener-mcp] [--auto-attach] [--no-start]
                                 wire this project: token, MCP server, hooks, skill
  init --user [--agent claude,codex] [--command listener-mcp]
                                 wire every agent session of this user: MCP server, hooks, skill
  uninstall [--user] [--agent claude,codex]
                                 remove the hooks and MCP entries init added

Apps (reachable from any session once init --user is done)
  app add <name> --channels 'app/**' [--group g] [--from now|earliest] [--exclusive]
          [--credential name]    register an app: its agent token, durable group and profile
  app list | app remove <name>

Tokens
  token create --name n --scopes 'publish:app/**,read:app/**' [--origin o] [--save] [--replace]
  token list | token revoke <id|name>
  pair --name n --origin moz-extension://… --scopes …   one-time token handout to a browser extension

Events
  publish <channel> [text] [--type t] [--data json] [--to agent] [--reply-to id] [--wait-reply s]
  events <pattern> [--after seq] [--limit n] [--follow]
  group create <name> --channels a,b [--from earliest] | group list | group delete <name>
  attach --agent id (--group g | --channels a,b) [--mode wake|poll] [--takeover]
  detach --agent id [--group g]
  wait --agent id [--timeout s] [--max n]        lease events (prints JSON; exit 1 on timeout)
  ack|nack --agent id <event ids…>

Adapters (called by agent runtimes)
  hook <session-start|stop> --host claude|codex [--budget seconds]
  mcp                            the MCP server (stdio)

Global options: --credential <name> uses a saved token instead of the admin token.
`;

const list = (value) => (value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : undefined);
const out = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);

async function adminClient(values = {}) {
  const env = process.env;
  const config = await loadConfig(env);
  const url = brokerUrl(config, env);
  const { resolveToken } = await import("./config.mjs");
  return new ListenerClient({ url, token: await resolveToken({ credential: values.credential, env }) });
}

const commands = {
  async broker(args) {
    const { values } = parseArgs({ args, options: { port: { type: "string" } } });
    const config = await ensureConfig();
    const { startBroker } = await import("./broker/index.mjs");
    const broker = await startBroker({ config, port: values.port ? Number(values.port) : config.port, log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
    const stop = () => broker.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },

  async service([action = "status"]) {
    const service = await import("./service.mjs");
    if (action === "install") { await ensureConfig(); return out(await service.installService()); }
    if (action === "uninstall") return out({ removed: await service.uninstallService() });
    if (action === "status") return out(await service.serviceStatus());
    throw new Error("Usage: listener-mcp service install|uninstall|status");
  },

  async status(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { credential: { type: "string" } } });
    const client = await adminClient(values);
    const pattern = positionals[0] ?? "**";
    out({ broker: client.url, health: await client.health(), presence: await client.presence(pattern) });
  },

  async doctor() {
    const checks = [];
    const check = async (name, fn) => {
      try { checks.push({ check: name, ok: true, detail: await fn() }); }
      catch (error) { checks.push({ check: name, ok: false, detail: error.message }); }
    };
    await check("node >= 22.13", () => { const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) throw new Error(process.versions.node); return process.versions.node; });
    await check("config", async () => files().config);
    await check("broker reachable", async () => (await ensureBroker()).url);
    await check("admin token", async () => { await readAdminToken(); return files().adminToken; });
    await check("listener-mcp on PATH", () => execFileSync(process.platform === "win32" ? "where" : "which", ["listener-mcp"], { encoding: "utf8" }).trim());
    const project = await findProject();
    const apps = await listApps();
    await check("project", async () => {
      if (project) return project.path;
      if (apps.length) return "none here; sessions use the registered apps";
      throw new Error("no .listener-mcp.json here or above, and no registered apps (run listener-mcp init, or app add)");
    });
    if (project?.config.credential) await check(`credential ${project.config.credential}`, async () => { const { client } = await connect(); return (await client.whoami()).scopes.join(" "); });
    for (const app of apps) {
      await check(`app ${app.name}`, async () => {
        if (!app.credential) return `group ${app.group}, default credential`;
        const client = new ListenerClient({ url: brokerUrl(await loadConfig()), token: await readCredential(app.credential) });
        const { scopes } = await client.whoami();
        const missing = app.channels.filter((pattern) => !scopes.some((scope) => scope.startsWith("subscribe:") && covers(scope.slice(10), pattern)));
        if (missing.length) throw new Error(`credential ${app.credential} may not subscribe to ${missing.join(", ")}`);
        return `group ${app.group}${app.exclusive ? " (exclusive)" : ""}, credential ${app.credential}`;
      });
    }
    for (const item of checks) out(`${item.ok ? "ok  " : "FAIL"}  ${item.check}: ${item.detail}`);
    if (checks.some((item) => !item.ok)) process.exitCode = 1;
  },

  async init(args) {
    const { values } = parseArgs({ args, options: {
      agent: { type: "string" }, channels: { type: "string" }, group: { type: "string" }, from: { type: "string" },
      credential: { type: "string" }, command: { type: "string" }, "auto-attach": { type: "boolean" }, "no-start": { type: "boolean" },
      user: { type: "boolean" },
    } });
    if (values.user) return initUser(values);
    const root = resolve(".");
    const found = await findProject(root);
    const existing = found?.root === root ? found.config : null;
    const agents = list(values.agent) ?? Object.keys(hosts);
    agents.forEach(host);
    const channels = list(values.channels) ?? existing?.attach?.channels;
    if (!channels?.length) throw new Error("Pass --channels, e.g. --channels 'myapp/**' (the app channels this project's agents listen to)");
    const credential = values.credential ?? existing?.credential ?? `${basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}-agent`;
    const command = values.command ?? (await detectCommand(root));

    await ensureConfig();
    if (!values["no-start"]) await ensureBroker();
    const admin = new ListenerClient({ url: brokerUrl(await loadConfig()), token: await readAdminToken() });
    const scopes = [...channels.flatMap((pattern) => [`subscribe:${pattern}`, `publish:${pattern}`, `read:${pattern}`]), "blobs"];
    const { token } = await admin.createToken({ name: credential, scopes, replace: true });
    await saveCredential(credential, token);
    if (values.group) await admin.createGroup({ name: values.group, channels, from: values.from === "now" ? "now" : "earliest" });

    const attach = { ...(values.group ? { group: values.group } : {}), channels, from: values.from ?? "earliest" };
    const projectPath = await writeProject(root, { credential, attach, auto_attach: Boolean(values["auto-attach"] ?? existing?.auto_attach) });
    const written = [projectPath, credentialPath(credential)];
    for (const name of agents) written.push(...(await host(name).install(root, { command })));
    out(`listener-mcp is wired into ${root}\n\n${written.map((path) => `  ${path}`).join("\n")}\n\nAgents: ${agents.join(", ")} · channels: ${channels.join(", ")}${values.group ? ` · group: ${values.group}` : ""}\nRestart the agent session so it loads the new MCP server and hooks. Codex asks you to trust project hooks (/hooks).`);
  },

  async uninstall(args) {
    const { values } = parseArgs({ args, options: { agent: { type: "string" }, user: { type: "boolean" } } });
    const root = values.user ? homedir() : resolve(".");
    for (const name of list(values.agent) ?? Object.keys(hosts)) await host(name).uninstall(root, { scope: values.user ? "user" : "project" });
    out(values.user
      ? "Removed listener-mcp's user-level hooks and MCP entries. App profiles, credentials and the skill files are left in place."
      : "Removed listener-mcp hooks and MCP entries. .listener-mcp.json and the skill files are left in place.");
  },

  async app([action, ...args]) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, allowNegative: true, options: {
      channels: { type: "string" }, group: { type: "string" }, from: { type: "string" }, exclusive: { type: "boolean" },
      credential: { type: "string" }, "no-start": { type: "boolean" },
    } });
    if (action === "list") return out(await listApps());
    if (action === "remove") {
      const name = assertAppName(positionals[0]);
      if (!(await loadApp(name))) throw new Error(`No app "${name}" is registered`);
      await removeApp(name);
      return out(`Removed app ${name}. Its group and credential are left in place (listener-mcp group delete, token revoke).`);
    }
    if (action !== "add") throw new Error("Usage: listener-mcp app add|list|remove");
    const name = assertAppName(positionals[0]);
    const existing = await loadApp(name);
    const channels = list(values.channels) ?? existing?.channels;
    if (!channels?.length) throw new Error(`Pass --channels, e.g. --channels '${name}/**' (the channels the app's agents listen to)`);
    const from = values.from ?? existing?.from ?? "now";
    if (from !== "now" && from !== "earliest") throw new Error("--from must be now or earliest");
    const app = {
      name,
      credential: values.credential ?? existing?.credential ?? `${name}-agent`,
      group: values.group ?? existing?.group ?? name,
      channels,
      from: /** @type {"now" | "earliest"} */ (from),
      exclusive: values.exclusive ?? existing?.exclusive ?? false,
    };

    await ensureConfig();
    if (!values["no-start"]) await ensureBroker();
    const url = brokerUrl(await loadConfig());
    const admin = new ListenerClient({ url, token: await readAdminToken() });
    // An existing credential is kept: the app may have given it more scopes than its channels.
    let token = await readCredential(app.credential).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const minted = !token;
    if (!token) {
      const scopes = [...channels.flatMap((pattern) => [`subscribe:${pattern}`, `publish:${pattern}`, `read:${pattern}`]), "blobs"];
      ({ token } = await admin.createToken({ name: app.credential, scopes, replace: true }));
      await saveCredential(app.credential, token);
    }
    const { scopes } = await new ListenerClient({ url, token }).whoami();
    const missing = channels.filter((pattern) => !scopes.some((scope) => scope === "admin" || (scope.startsWith("subscribe:") && covers(scope.slice(10), pattern))));
    if (missing.length) throw new Error(`Credential ${app.credential} may not subscribe to ${missing.join(", ")}. Widen it with listener-mcp token create --name ${app.credential} --replace --save --scopes …, or pass another --credential`);
    await admin.createGroup({ name: app.group, channels, from: app.from, exclusive: app.exclusive });
    const path = await saveApp(app);
    out(`App ${name} registered\n\n  ${path}\n  ${credentialPath(app.credential)}${minted ? " (new)" : " (kept)"}\n\nGroup ${app.group} on ${channels.join(", ")}${app.exclusive ? ", exclusive: one agent at a time" : ""}.\nAgents attach from any session with listener_attach and app "${name}" (after listener-mcp init --user).`);
  },

  async token([action, ...args]) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      name: { type: "string" }, scopes: { type: "string" }, origin: { type: "string", multiple: true }, save: { type: "boolean" }, replace: { type: "boolean" }, credential: { type: "string" },
    } });
    const client = await adminClient(values);
    if (action === "create") {
      const created = await client.createToken({ name: values.name, scopes: list(values.scopes), origins: values.origin ?? [], replace: values.replace });
      if (values.save) return out({ ...created, token: undefined, saved: await saveCredential(created.name, created.token) });
      return out(created);
    }
    if (action === "list") return out(await client.tokens());
    if (action === "revoke") return out(await client.revokeToken(positionals[0]));
    throw new Error("Usage: listener-mcp token create|list|revoke");
  },

  async pair(args) {
    const { values } = parseArgs({ args, options: { name: { type: "string" }, origin: { type: "string" }, scopes: { type: "string" }, ttl: { type: "string" }, credential: { type: "string" } } });
    const client = await adminClient(values);
    const grant = await client.openPairing({ name: values.name, origin: values.origin, scopes: list(values.scopes), ttlMs: values.ttl ? Number(values.ttl) * 1000 : undefined });
    out(`Pairing open for ${grant.origin} until ${grant.expires_at}. Reload the extension (or press its Pair button) to receive the token.`);
  },

  async group([action, ...args]) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { channels: { type: "string" }, from: { type: "string" }, credential: { type: "string" } } });
    const client = await adminClient(values);
    if (action === "create") return out(await client.createGroup({ name: positionals[0], channels: list(values.channels), from: values.from }));
    if (action === "list") return out(await client.groups());
    if (action === "delete") return out(await client.deleteGroup(positionals[0]));
    throw new Error("Usage: listener-mcp group create|list|delete");
  },

  async publish(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      type: { type: "string" }, data: { type: "string" }, to: { type: "string" }, "reply-to": { type: "string" }, agent: { type: "string" }, "wait-reply": { type: "string" }, credential: { type: "string" },
    } });
    const [channel, ...words] = positionals;
    const data = { ...(values.data ? JSON.parse(values.data) : {}), ...(words.length ? { text: words.join(" ") } : {}) };
    const client = await adminClient(values);
    out(await client.publish({ channel, data, type: values.type, to: values.to, replyTo: values["reply-to"], agent: values.agent, waitReplyMs: values["wait-reply"] ? Number(values["wait-reply"]) * 1000 : undefined }));
  },

  async events(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { after: { type: "string" }, limit: { type: "string" }, follow: { type: "boolean" }, credential: { type: "string" } } });
    const client = await adminClient(values);
    const channel = positionals[0] ?? "**";
    let after = Number(values.after ?? 0);
    for (;;) {
      const events = await client.events({ channel, after, limit: values.limit ? Number(values.limit) : 100 });
      for (const event of events) { out(JSON.stringify(event)); after = event.seq; }
      if (!values.follow) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  },

  async attach(args) {
    const { values } = parseArgs({ args, options: { agent: { type: "string" }, group: { type: "string" }, channels: { type: "string" }, from: { type: "string" }, mode: { type: "string" }, takeover: { type: "boolean" }, credential: { type: "string" } } });
    const client = await adminClient(values);
    out(await client.attach({ agent: values.agent, group: values.group, channels: list(values.channels), from: values.from, mode: values.mode ?? "poll", takeover: values.takeover }));
  },

  async detach(args) {
    const { values } = parseArgs({ args, options: { agent: { type: "string" }, group: { type: "string" }, credential: { type: "string" } } });
    const client = await adminClient(values);
    const subs = (await client.subscriptions({ agent: values.agent })).filter((sub) => !values.group || sub.group === values.group);
    for (const sub of subs) await client.detach(sub.id);
    out({ detached: subs.map((sub) => sub.group) });
  },

  async wait(args) {
    const { values } = parseArgs({ args, options: { agent: { type: "string" }, timeout: { type: "string" }, max: { type: "string" }, text: { type: "boolean" }, credential: { type: "string" } } });
    if (!values.agent) throw new Error("--agent is required");
    const client = await adminClient(values);
    const timeout = values.timeout == null ? -1 : Number(values.timeout);
    const result = await client.nextForAgent(values.agent, { waitMs: timeout < 0 ? -1 : timeout * 1000, max: values.max ? Number(values.max) : undefined });
    if (!result.events.length) { process.exitCode = 1; return; }
    out(values.text ? formatEvents(result.events, { agent: values.agent, tools: "cli" }) : result);
  },

  async ack(args) { return settle(args, "ack"); },
  async nack(args) { return settle(args, "nack"); },

  async hook([event, ...args]) {
    const { values } = parseArgs({ args, options: { host: { type: "string" }, budget: { type: "string" } } });
    const adapter = host(values.host ?? "claude");
    const handler = adapter.hooks[event];
    if (!handler) throw new Error(`Host ${adapter.name} has no ${event} hook`);
    const input = await readStdinJson();
    const result = await handler(input, { cwd: input.cwd ?? process.cwd(), budgetS: Number(values.budget ?? 3600) });
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode ?? 0;
  },

  async mcp() {
    const { runMcpServer } = await import("./mcp/server.mjs");
    await runMcpServer();
  },

  async version() { out("0.1.2"); },
  async help() { out(HELP); },
};

/** `init --user`: hooks, MCP server and skill for every session, in the user's home. */
async function initUser(values) {
  const root = homedir();
  const agents = list(values.agent) ?? Object.keys(hosts);
  agents.forEach(host);
  const command = values.command ?? (await detectCommand(root));
  await ensureConfig();
  if (!values["no-start"]) await ensureBroker();
  const written = [];
  for (const name of agents) written.push(...(await host(name).install(root, { command, scope: "user" })));
  const apps = await listApps();
  out(`listener-mcp is wired into every agent session of this user\n\n${written.map((path) => `  ${path}`).join("\n")}\n\nAgents: ${agents.join(", ")} · apps: ${apps.length ? apps.map((app) => app.name).join(", ") : "none yet (listener-mcp app add)"}\nRestart agent sessions so they load the MCP server and hooks.`);
}

async function settle(args, outcome) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { agent: { type: "string" }, subscription: { type: "string" }, credential: { type: "string" } } });
  const client = await adminClient(values);
  out(await client[outcome](positionals, { agent: values.agent, subscription: values.subscription }));
}

/**
 * How hooks and MCP configs should invoke us: the global binary when it is on
 * PATH, the project's own copy when it is a dependency, else this exact file.
 */
async function detectCommand(root) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["listener-mcp"], { stdio: "ignore" });
    return "listener-mcp";
  } catch { /* not on PATH */ }
  const { access } = await import("node:fs/promises");
  if (await access(resolve(root, "node_modules", "listener-mcp", "bin", "listener-mcp.mjs")).then(() => true, () => false)) return "npx --no-install listener-mcp";
  const { fileURLToPath } = await import("node:url");
  const self = fileURLToPath(new URL("../bin/listener-mcp.mjs", import.meta.url));
  process.stderr.write(`warning: listener-mcp is not on PATH; hooks will call ${self} directly. Install it globally or pass --command.\n`);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(self)}`;
}

export async function main(argv) {
  const [name = "help", ...args] = argv;
  const command = commands[name === "--help" || name === "-h" ? "help" : name === "--version" ? "version" : name];
  if (!command) { process.stderr.write(`Unknown command "${name}".\n\n${HELP}`); process.exitCode = 2; return; }
  try { await command(args); }
  catch (error) {
    process.stderr.write(`listener-mcp ${name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
