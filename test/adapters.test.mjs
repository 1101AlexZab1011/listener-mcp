import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { testBroker, sleep } from "./helpers.mjs";
import { saveCredential } from "../src/config.mjs";
import { saveApp } from "../src/apps.mjs";
import { ListenerClient } from "../src/client.mjs";

const cli = fileURLToPath(new URL("../bin/listener-mcp.mjs", import.meta.url));

function run(args, { env, input, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ? JSON.stringify(input) : "");
  });
}

/** A broker plus a project directory wired to a scoped agent credential. */
async function setup(t) {
  const env = await testBroker();
  const project = await mkdtemp(join(tmpdir(), "listener-mcp-project-"));
  t.after(async () => { await env.close(); await rm(project, { recursive: true, force: true }); });
  const processEnv = { ...env.env, LISTENER_MCP_URL: env.broker.url };
  const { token } = await env.admin.createToken({ name: "proj-agent", scopes: ["subscribe:app/**", "publish:app/**", "read:app/**"] });
  await saveCredential("proj-agent", token, processEnv);
  await writeFile(join(project, ".listener-mcp.json"), JSON.stringify({ version: 1, credential: "proj-agent", attach: { group: "app-chat", channels: ["app/chat/*"], from: "earliest" } }));
  const agentClient = new ListenerClient({ url: env.broker.url, token });
  return { env, project, processEnv, agentClient };
}

test("claude stop hook: silent when not attached, wakes with events via exit 2", async (t) => {
  const { env, project, processEnv, agentClient } = await setup(t);
  const idle = await run(["hook", "stop", "--host", "claude", "--budget", "5"], { env: processEnv, cwd: project, input: { session_id: "s1", cwd: project } });
  assert.equal(idle.code, 0);
  assert.equal(idle.stderr, "");

  await agentClient.attach({ agent: "claude:s1", group: "app-chat", channels: ["app/chat/*"], mode: "wake" });
  const hook = run(["hook", "stop", "--host", "claude", "--budget", "20"], { env: processEnv, cwd: project, input: { session_id: "s1", cwd: project } });
  await sleep(400);
  const presence = await env.admin.presence("app/chat/default");
  assert.equal(presence.listening, true, "the hook is parked on the broker");
  await env.admin.publish({ channel: "app/chat/default", data: { text: "ping from the app" } });
  const woke = await hook;
  assert.equal(woke.code, 2);
  assert.match(woke.stderr, /ping from the app/);
  assert.match(woke.stderr, /listener_ack/);
});

test("codex stop hook returns the events as a block decision", async (t) => {
  const { env, project, processEnv, agentClient } = await setup(t);
  await agentClient.attach({ agent: "codex:c1", group: "app-chat", channels: ["app/chat/*"], mode: "poll" });
  await env.admin.publish({ channel: "app/chat/default", data: { text: "queued" } });
  const result = await run(["hook", "stop", "--host", "codex", "--budget", "5"], { env: processEnv, cwd: project, input: { session_id: "c1", cwd: project } });
  assert.equal(result.code, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /queued/);
});

test("session-start hook tells the model its agent id", async (t) => {
  const { project, processEnv } = await setup(t);
  const result = await run(["hook", "session-start", "--host", "claude"], { env: processEnv, cwd: project, input: { session_id: "abc", cwd: project, source: "startup" } });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /agent id is "claude:abc"/);
  assert.match(result.stdout, /group app-chat/);
});

test("init wires Claude Code and Codex into a project, idempotently", async (t) => {
  const env = await testBroker();
  const project = await mkdtemp(join(tmpdir(), "listener-mcp-init-"));
  t.after(async () => { await env.close(); await rm(project, { recursive: true, force: true }); });
  const processEnv = { ...env.env, LISTENER_MCP_URL: env.broker.url };
  await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  for (let round = 0; round < 2; round++) {
    const result = await run(["init", "--channels", "demo/**", "--group", "demo", "--credential", "demo-agent"], { env: processEnv, cwd: project });
    assert.equal(result.code, 0, result.stderr);
  }
  const settings = JSON.parse(await readFile(join(project, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.Stop.length, 1, "no duplicate hooks after a second init");
  assert.equal(settings.hooks.Stop[0].hooks[0].asyncRewake, true);
  const mcp = JSON.parse(await readFile(join(project, ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers.other && mcp.mcpServers.listener, "existing servers are kept");
  const codexToml = await readFile(join(project, ".codex", "config.toml"), "utf8");
  assert.equal(codexToml.match(/\[mcp_servers\.listener\]/g).length, 1);
  const codexHooks = JSON.parse(await readFile(join(project, ".codex", "hooks.json"), "utf8"));
  assert.ok(codexHooks.hooks.Stop);
  await readFile(join(project, ".claude", "skills", "listener", "SKILL.md"));
  await readFile(join(project, ".agents", "skills", "listener", "SKILL.md"));
  const groups = await env.admin.groups();
  assert.deepEqual(groups.map((group) => group.name), ["demo"]);
});

test("the MCP server attaches, waits, replies and acks", async (t) => {
  const { env, project, processEnv } = await setup(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: processEnv, cwd: project, stderr: "pipe" });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content[0].text);
    return result.content[0].text;
  };
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes("listener_wait") && tools.includes("listener_attach"));

  assert.match(await call("listener_attach", { session: "codex:m1" }), /group app-chat/);
  const asked = await env.admin.publish({ channel: "app/chat/default", data: { text: "what is 2+2?" } });
  const delivered = await call("listener_wait", { session: "codex:m1", wait_seconds: 10 });
  assert.match(delivered, /what is 2\+2\?/);
  await call("listener_reply", { event_id: asked.id, text: "4", session: "codex:m1" });
  await call("listener_ack", { session: "codex:m1", event_ids: [asked.id] });
  const thread = await env.admin.event(asked.id);
  assert.equal(thread.replies[0].data.text, "4");
  assert.equal(thread.replies[0].from.agent, "codex:m1");
  assert.equal((await env.admin.presence("app/chat/default")).busy, false);
});

/** An app registered for this user, with its own credential, as `app add` leaves it. */
async function registerApp(env, processEnv) {
  const { token } = await env.admin.createToken({ name: "demo-agent", scopes: ["subscribe:demo/chat/**", "publish:demo/chat/**", "read:demo/chat/**"] });
  await saveCredential("demo-agent", token, processEnv);
  await saveApp({ name: "demo", credential: "demo-agent", group: "demo-chat", channels: ["demo/chat/**"], from: "now", exclusive: true }, processEnv);
}

async function mcpClient(t, { cwd, env }) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, cwd, stderr: "pipe" });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: Boolean(result.isError), text: result.content[0].text };
  };
}

test("a session in any directory attaches to a registered app, and the app takes one agent", async (t) => {
  const env = await testBroker();
  const anywhere = await mkdtemp(join(tmpdir(), "listener-mcp-anywhere-"));
  t.after(async () => { await env.close(); await rm(anywhere, { recursive: true, force: true }); });
  const processEnv = { ...env.env, LISTENER_MCP_URL: env.broker.url };
  await registerApp(env, processEnv);

  const context = await run(["hook", "session-start", "--host", "claude"], { env: processEnv, cwd: anywhere, input: { session_id: "x", cwd: anywhere } });
  assert.match(context.stdout, /listen to when the user asks: demo/);

  const call = await mcpClient(t, { cwd: anywhere, env: processEnv });
  const bare = await call("listener_attach", { session: "claude:x" });
  assert.ok(bare.error);
  assert.match(bare.text, /registered: demo/);
  const attached = await call("listener_attach", { session: "claude:x", app: "demo" });
  assert.ok(!attached.error, attached.text);
  assert.match(attached.text, /group demo-chat .*exclusive/);
  const second = await call("listener_attach", { session: "claude:y", app: "demo" });
  assert.ok(second.error);
  assert.match(second.text, /exclusive and claude:x is attached/);

  const hook = run(["hook", "stop", "--host", "claude", "--budget", "20"], { env: processEnv, cwd: anywhere, input: { session_id: "x", cwd: anywhere } });
  await sleep(400);
  const asked = await env.admin.publish({ channel: "demo/chat/default", data: { text: "hello from anywhere" } });
  const woke = await hook;
  assert.equal(woke.code, 2);
  assert.match(woke.stderr, /hello from anywhere/);

  assert.ok(!(await call("listener_reply", { event_id: asked.id, text: "hi", session: "claude:x" })).error);
  assert.match((await call("listener_ack", { session: "claude:x", event_ids: [asked.id] })).text, /acked/);
  assert.equal((await env.admin.event(asked.id)).replies[0].from.agent, "claude:x");
  const outside = await call("listener_publish", { channel: "other/x", text: "no", session: "claude:x" });
  assert.ok(outside.error, "agents never fall back to the admin token");
  assert.match(outside.text, /may publish on other\/x/);

  const taken = await call("listener_attach", { session: "claude:y", app: "demo", takeover: true });
  assert.ok(!taken.error, taken.text);
  assert.match((await call("listener_detach", { session: "claude:x" })).text, /not attached/);
});

test("a project session also attached to an app waits on both credentials", async (t) => {
  const { env, project, processEnv } = await setup(t);
  await registerApp(env, processEnv);
  const call = await mcpClient(t, { cwd: project, env: processEnv });
  assert.ok(!(await call("listener_attach", { session: "claude:p" })).error);
  assert.ok(!(await call("listener_attach", { session: "claude:p", app: "demo" })).error);
  const status = JSON.parse((await call("listener_status", { session: "claude:p" })).text);
  assert.deepEqual(status.credentials.map((entry) => [entry.name, entry.subscriptions.length]), [["proj-agent", 1], ["demo-agent", 1]]);

  for (const channel of ["demo/chat/default", "app/chat/default"]) {
    const hook = run(["hook", "stop", "--host", "claude", "--budget", "20"], { env: processEnv, cwd: project, input: { session_id: "p", cwd: project } });
    await sleep(400);
    const sent = await env.admin.publish({ channel, data: { text: `on ${channel}` } });
    const woke = await hook;
    assert.equal(woke.code, 2);
    assert.match(woke.stderr, new RegExp(`on ${channel}`));
    assert.match((await call("listener_ack", { session: "claude:p", event_ids: [sent.id] })).text, /acked/);
  }
  assert.match((await call("listener_detach", { session: "claude:p" })).text, /app-chat, demo-chat/);
});

test("app add mints a credential once, keeps an existing one, and sets the group policy", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const processEnv = { ...env.env, LISTENER_MCP_URL: env.broker.url };
  const added = await run(["app", "add", "demo", "--channels", "demo/chat/**", "--group", "demo-chat", "--exclusive"], { env: processEnv });
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /\(new\)/);
  const profile = JSON.parse(await readFile(join(env.home, "apps", "demo.json"), "utf8"));
  assert.deepEqual(profile, { version: 1, credential: "demo-agent", group: "demo-chat", channels: ["demo/chat/**"], from: "now", exclusive: true });
  const token = await readFile(join(env.home, "credentials", "demo-agent.token"), "utf8");
  assert.equal((await env.admin.groups())[0].exclusive, true);

  const again = await run(["app", "add", "demo", "--no-exclusive"], { env: processEnv });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /\(kept\)/);
  assert.equal(await readFile(join(env.home, "credentials", "demo-agent.token"), "utf8"), token);
  assert.equal((await env.admin.groups())[0].exclusive, false);

  const narrow = await run(["app", "add", "wide", "--channels", "wide/**", "--credential", "demo-agent"], { env: processEnv });
  assert.equal(narrow.code, 1);
  assert.match(narrow.stderr, /may not subscribe to wide\/\*\*/);
  assert.match((await run(["app", "list"], { env: processEnv })).stdout, /"name": "demo"/);
});

test("init --user wires every session through the home directory, and uninstall --user undoes it", async (t) => {
  const env = await testBroker();
  const home = await mkdtemp(join(tmpdir(), "listener-mcp-home-"));
  t.after(async () => { await env.close(); await rm(home, { recursive: true, force: true }); });
  // No claude CLI on PATH: the MCP registration is reported, not written.
  const processEnv = { ...env.env, LISTENER_MCP_URL: env.broker.url, HOME: home, PATH: join(home, "bin") };
  const result = await run(["init", "--user", "--command", "listener-mcp"], { env: processEnv });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /claude mcp add-json --scope user listener/);
  const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "listener-mcp hook stop --host claude --budget 1999940");
  assert.ok(settings.permissions.allow.includes("mcp__listener"));
  await readFile(join(home, ".claude", "skills", "listener", "SKILL.md"));
  assert.match(await readFile(join(home, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.listener\]/);
  await readFile(join(home, ".agents", "skills", "listener", "SKILL.md"));

  const removed = await run(["uninstall", "--user"], { env: processEnv });
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")).hooks, undefined);
});
