import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.mjs";
import { startBroker } from "../src/broker/index.mjs";
import { ListenerClient } from "../src/client.mjs";

/** A broker on a random port with its own home directory and in-memory store. */
export async function testBroker(limits = {}) {
  const home = await mkdtemp(join(tmpdir(), "listener-mcp-test-"));
  const env = { ...process.env, LISTENER_MCP_HOME: home };
  const config = { ...defaultConfig(), limits: { ...defaultConfig().limits, ...limits } };
  const broker = await startBroker({ config, env, database: ":memory:", port: 0 });
  const admin = new ListenerClient({ url: broker.url, token: broker.adminToken });
  const client = async (name, scopes, origins) => {
    const { token } = await admin.createToken({ name, scopes, origins });
    return new ListenerClient({ url: broker.url, token });
  };
  return {
    broker, admin, client, env, home,
    async close() { await broker.close(); await rm(home, { recursive: true, force: true }); },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
