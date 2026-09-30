// @ts-check
// The broker's HTTP front door. Every request passes the same gate, in order:
//
//   1. Host header must name the loopback address we listen on. This defeats
//      DNS rebinding: a web page cannot make its own domain resolve to us.
//   2. A browser Origin, if present, must be one a token or pairing grant
//      allows. Unknown pages get no CORS headers and a 403.
//   3. A bearer token must be valid, and if the request came from a browser,
//      that token must list the request's origin.
//
// Only /v1/health (no data) and /v1/pair (origin-bound, one-shot) skip step 3.
import { createServer } from "node:http";
import { files, readAdminToken, writePrivate } from "../config.mjs";
import { errors, PROTOCOL_VERSION, ProtocolError } from "../protocol.mjs";
import { assertOrigin, generateToken, hashToken, mintToken, requireDelegable, requireScope } from "./auth.mjs";
import { BlobStore } from "./blobs.mjs";
import { Bus } from "./bus.mjs";
import { readJson, Router, send, sendError } from "./http.mjs";
import { Store } from "./store.mjs";

const VERSION = "0.1.0";
const JSON_LIMIT = 1024 * 1024;

/**
 * Start a broker.
 * @param {{ config: any, env?: NodeJS.ProcessEnv, database?: string, port?: number, log?: (line: string) => void }} options
 */
export const BROKER_VERSION = VERSION;

export async function startBroker({ config, env = process.env, database, port = config.port, log = () => {} }) {
  const paths = files(env);
  const store = new Store(database ?? paths.database);
  const bus = new Bus({ store, limits: config.limits });
  const blobs = new BlobStore({ root: paths.blobs, store, maxBytes: config.limits.blob_bytes });
  const adminToken = await bootstrapAdmin(store, env);
  const router = buildRoutes({ bus, store, blobs, config });

  let allowedHosts = new Set();
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!(error?.status)) log(`error: ${error?.stack ?? error}`);
      sendError(response, error);
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://broker");
    if (!allowedHosts.has(String(request.headers.host ?? "").toLowerCase())) throw errors.forbidden("Unexpected Host header");

    const origin = typeof request.headers.origin === "string" ? request.headers.origin : null;
    const cors = origin && store.knownOrigins(Date.now()).has(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, DELETE", "access-control-max-age": "600", vary: "Origin" }
      : {};
    if (origin && !cors["access-control-allow-origin"]) return sendError(response, errors.forbidden("Origin not allowed"));
    if (request.method === "OPTIONS") return send(response, 204, null, cors);

    const found = router.match(request.method, url.pathname);
    if (!found) return sendError(response, errors.notFound("No such endpoint"), cors);
    if (found.methodNotAllowed) return sendError(response, new ProtocolError(405, "method_not_allowed", "Method not allowed"), cors);
    const { route, params } = found;

    let principal = null;
    if (!route.options.public) {
      const header = String(request.headers.authorization ?? "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      principal = token ? store.tokenByHash(hashToken(token)) : null;
      if (!principal) return sendError(response, errors.unauthorized(), cors);
      if (origin && !principal.origins.includes(origin)) return sendError(response, errors.forbidden("This token is not valid for this origin"), cors);
      store.touchToken(principal.id, Date.now());
    }
    try {
      const result = await route.handler({ request, response, url, principal, origin, cors }, params);
      if (result === undefined) return;
      if (result && typeof result === "object" && "status" in result && "body" in result) return send(response, result.status, result.body, cors);
      return send(response, 200, result, cors);
    } catch (error) { return sendError(response, error, cors); }
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, config.host, () => { server.off("error", reject); resolve(undefined); });
  });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const hostName = config.host === "::1" ? "[::1]" : config.host;
  allowedHosts = new Set([`${hostName}:${address.port}`, `localhost:${address.port}`, `127.0.0.1:${address.port}`, `[::1]:${address.port}`].map((value) => value.toLowerCase()));
  // Long polls are the point: no request or idle timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;
  server.keepAliveTimeout = 5_000;

  const sweep = setInterval(() => {
    try { bus.sweep(); } catch (error) { log(`sweep failed: ${error}`); }
    blobs.prune(Date.now() - config.limits.retention_days * 86_400_000).catch((error) => log(`blob prune failed: ${error}`));
  }, 5 * 60_000);
  sweep.unref();

  const url = `http://${hostName}:${address.port}`;
  log(`listener-mcp broker ${VERSION} listening on ${url}`);
  return {
    url,
    port: address.port,
    bus,
    store,
    adminToken,
    async close() {
      clearInterval(sweep);
      bus.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      store.close();
    },
  };
}

/** Make sure the admin token file exists and its hash is known to the store. */
async function bootstrapAdmin(store, env) {
  let token;
  try { token = await readAdminToken(env); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    token = generateToken();
    await writePrivate(files(env).adminToken, `${token}\n`);
  }
  if (!store.tokenByHash(hashToken(token))) store.restoreAdmin({ id: `tok_admin_${hashToken(token).slice(0, 12)}`, hash: hashToken(token), now: Date.now() });
  return token;
}

function buildRoutes({ bus, store, blobs, config }) {
  const router = new Router();
  const int = (value, fallback) => {
    if (value == null || value === "") return fallback;
    const number = Number(value);
    if (!Number.isInteger(number)) throw errors.badRequest(`Expected an integer, got ${JSON.stringify(value)}`);
    return number;
  };

  router.add("GET", "/v1/health", () => ({ ok: true, protocol: PROTOCOL_VERSION, version: VERSION }), { public: true });

  // A browser extension cannot read files, so it obtains its token here, once:
  // `listener-mcp pair` opens a short-lived grant for one exact origin.
  router.add("GET", "/v1/pair", ({ origin }) => {
    if (!origin) throw errors.forbidden("Pairing is only available to browser origins");
    const grant = store.claimGrant(origin, Date.now());
    if (!grant) throw errors.forbidden("No open pairing grant for this origin. Run: listener-mcp pair --origin " + origin);
    const { secret, record } = mintToken({ name: grant.name, scopes: grant.scopes, origins: [origin] });
    store.revokeTokens({ name: grant.name }, Date.now());
    store.insertToken({ ...record, createdAt: Date.now() });
    return { token: secret, name: grant.name, scopes: grant.scopes };
  }, { public: true });

  router.add("GET", "/v1/whoami", ({ principal }) => ({ id: principal.id, name: principal.name, scopes: principal.scopes, origins: principal.origins }));

  // --- tokens ---
  router.add("POST", "/v1/tokens", async ({ request, principal }) => {
    const input = await readJson(request, JSON_LIMIT);
    const scopes = input.scopes ?? [];
    requireDelegable(principal, scopes);
    const { secret, record } = mintToken({ name: input.name, scopes, origins: input.origins ?? [] });
    if (input.replace) store.revokeTokens({ name: record.name }, Date.now());
    store.insertToken({ ...record, createdAt: Date.now() });
    return { status: 201, body: { token: secret, id: record.id, name: record.name, scopes: record.scopes, origins: record.origins } };
  });
  router.add("GET", "/v1/tokens", ({ principal }) => { requireScope(principal, "admin"); return { tokens: store.listTokens() }; });
  router.add("DELETE", "/v1/tokens/:ref", ({ principal }, { ref }) => {
    requireScope(principal, "admin");
    const revoked = ref.startsWith("tok_") ? store.revokeTokens({ id: ref }, Date.now()) : store.revokeTokens({ name: ref }, Date.now());
    if (!revoked) throw errors.notFound("No such token");
    return { revoked };
  });
  router.add("POST", "/v1/pairing-grants", async ({ request, principal }) => {
    requireScope(principal, "admin");
    const input = await readJson(request, JSON_LIMIT);
    const origin = assertOrigin(input.origin);
    const scopes = input.scopes ?? [];
    mintToken({ name: input.name, scopes, origins: [origin] }); // validates name and scopes
    const ttl = Math.min(int(input.ttl_ms, 10 * 60_000), 60 * 60_000);
    const grant = { id: `grant_${Date.now()}`, name: input.name, scopes, origin, expiresAt: Date.now() + ttl };
    store.insertGrant(grant);
    return { status: 201, body: { name: grant.name, origin, scopes, expires_at: new Date(grant.expiresAt).toISOString() } };
  });

  // --- events ---
  router.add("POST", "/v1/events", async ({ request, principal }) => {
    const input = await readJson(request, config.limits.event_bytes + 16 * 1024);
    const event = bus.publish(principal, input);
    const waitReply = int(input.wait_reply_ms, 0);
    if (waitReply > 0) {
      const replies = await bus.waitForReplies(principal, event.id, Math.min(waitReply, 3_600_000));
      return { status: 201, body: { ...event, replies } };
    }
    return { status: 201, body: event };
  });
  router.add("GET", "/v1/events", ({ url, principal }) => {
    const channel = url.searchParams.get("channel") ?? "**";
    const before = url.searchParams.get("before");
    return { events: bus.history(principal, { channel, after: int(url.searchParams.get("after"), 0), before: before == null ? null : int(before, null), limit: int(url.searchParams.get("limit"), 100) }) };
  });
  router.add("GET", "/v1/events/:id", ({ principal }, { id }) => bus.event(principal, id));

  // --- groups ---
  router.add("GET", "/v1/groups", ({ principal }) => ({ groups: bus.groups(principal) }));
  router.add("POST", "/v1/groups", async ({ request, principal }) => ({ status: 201, body: bus.createGroup(principal, await readJson(request, JSON_LIMIT)) }));
  router.add("DELETE", "/v1/groups/:name", ({ principal }, { name }) => bus.deleteGroup(principal, name));

  // --- subscriptions ---
  router.add("POST", "/v1/subscriptions", async ({ request, principal }) => ({ status: 201, body: bus.attach(principal, await readJson(request, JSON_LIMIT)) }));
  router.add("GET", "/v1/subscriptions", ({ url, principal }) => ({ subscriptions: bus.subscriptions(principal, { agent: url.searchParams.get("agent") ?? undefined }) }));
  router.add("DELETE", "/v1/subscriptions/:id", ({ principal }, { id }) => bus.detach(principal, id));
  router.add("POST", "/v1/subscriptions/:id/touch", ({ principal }, { id }) => bus.touch(principal, id));
  // Long polls: one subscription, or every subscription an agent holds.
  const next = (target) => async ({ request, response, url, principal, cors }, params) => {
    const waitMs = int(url.searchParams.get("wait_ms"), 0);
    if (waitMs < -1 || waitMs > 86_400_000) throw errors.badRequest("wait_ms must be -1 (until an event arrives) or 0..86400000");
    // The caller hanging up must end the wait, or its parked slot would keep
    // the agent looking present after it is gone.
    const controller = new AbortController();
    request.once("close", () => { if (!response.writableFinished) controller.abort(); });
    const result = await bus.next(principal, target(params), { waitMs, waiter: url.searchParams.get("waiter"), max: int(url.searchParams.get("max"), 10), signal: controller.signal });
    if (controller.signal.aborted || response.destroyed) { bus.release(result.events); return; }
    // A lease only counts if the caller actually received it.
    response.once("close", () => { if (!response.writableFinished) bus.release(result.events); });
    send(response, 200, result, cors);
  };
  router.add("GET", "/v1/subscriptions/:id/next", next(({ id }) => ({ subscription: id })));
  router.add("GET", "/v1/agents/:agent/next", next(({ agent }) => ({ agent })));
  router.add("POST", "/v1/ack", async ({ request, principal }) => bus.settle(principal, { ...(await readJson(request, JSON_LIMIT)), outcome: "ack" }));
  router.add("POST", "/v1/nack", async ({ request, principal }) => bus.settle(principal, { ...(await readJson(request, JSON_LIMIT)), outcome: "nack" }));

  // --- presence ---
  router.add("GET", "/v1/presence", ({ url, principal }) => bus.presence(principal, url.searchParams.get("channel") ?? "**"));

  // --- blobs ---
  router.add("POST", "/v1/blobs", async ({ request, url, principal }) => {
    requireScope(principal, "blobs");
    return { status: 201, body: await blobs.save(request, { name: url.searchParams.get("name"), type: url.searchParams.get("type") ?? request.headers["content-type"], principal }) };
  });
  router.add("GET", "/v1/blobs/:id", async ({ response, principal, cors }, { id }) => {
    requireScope(principal, "blobs");
    await blobs.serve(id, response, cors);
  });

  return router;
}

