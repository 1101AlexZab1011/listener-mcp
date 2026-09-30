// @ts-check
// A small client for the broker's HTTP API, usable from Node (>= 22) and
// browsers alike: it only needs `fetch`. Apps use it to publish events and
// read replies; agent adapters use it to attach, wait, and acknowledge.

export class ListenerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Node's fetch gives up on a response body after 300 s, so long waits are
// issued as a series of shorter polls. The broker keeps the lease semantics
// across them because every poll carries the same waiter id.
const POLL_CHUNK_MS = 240_000;

const randomId = () => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export class ListenerClient {
  /**
   * @param {{ url: string, token?: string, fetch?: typeof fetch }} options
   */
  constructor({ url, token, fetch: fetchImpl = globalThis.fetch.bind(globalThis) }) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }

  /**
   * Build a client from local configuration (Node only): LISTENER_MCP_URL /
   * config.json for the address, and LISTENER_MCP_TOKEN, a named credential,
   * or the admin token for authentication.
   */
  static async fromEnvironment({ credential, env = process.env } = {}) {
    const { loadConfig, brokerUrl, resolveToken } = await import("./config.mjs");
    const config = await loadConfig(env);
    return new ListenerClient({ url: brokerUrl(config, env), token: await resolveToken({ credential, env }) });
  }

  async request(method, path, { body, query, signal, raw, headers = {} } = {}) {
    const url = new URL(this.url + path);
    for (const [key, value] of Object.entries(query ?? {})) if (value != null) url.searchParams.set(key, String(value));
    const init = { method, signal, headers: { ...headers } };
    if (this.token) init.headers.authorization = `Bearer ${this.token}`;
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
    const response = await this.fetch(url, init);
    const text = await response.text();
    let value = null;
    if (text) { try { value = JSON.parse(text); } catch { value = null; } }
    if (!response.ok) {
      const error = value?.error ?? {};
      throw new ListenerError(response.status, error.code ?? "http_error", error.message ?? `Broker answered ${response.status}`);
    }
    return value;
  }

  health() { return this.request("GET", "/v1/health"); }
  whoami() { return this.request("GET", "/v1/whoami"); }

  // --- events ---

  /**
   * Publish an event. With `waitReplyMs`, the call also waits for replies.
   * @param {{ channel: string, data?: any, type?: string, to?: string, replyTo?: string, ttlMs?: number, agent?: string, waitReplyMs?: number }} event
   */
  publish({ channel, data, type, to, replyTo, ttlMs, agent, waitReplyMs }) {
    return this.request("POST", "/v1/events", { body: { channel, data, type, to, reply_to: replyTo, ttl_ms: ttlMs, agent, wait_reply_ms: waitReplyMs } });
  }

  /** Reply to an event on the event's own channel. */
  async reply(event, { data, type = "reply", agent }) {
    const original = typeof event === "string" ? await this.event(event) : event;
    return this.publish({ channel: original.channel, data, type, replyTo: original.id, agent });
  }

  async events({ channel = "**", after, before, limit } = {}) {
    return (await this.request("GET", "/v1/events", { query: { channel, after, before, limit } })).events;
  }

  event(id) { return this.request("GET", `/v1/events/${encodeURIComponent(id)}`); }

  // --- groups and subscriptions ---

  createGroup({ name, channels, from, durable }) { return this.request("POST", "/v1/groups", { body: { name, channels, from, durable } }); }
  async groups() { return (await this.request("GET", "/v1/groups")).groups; }
  deleteGroup(name) { return this.request("DELETE", `/v1/groups/${encodeURIComponent(name)}`); }

  /**
   * Attach an agent to a group (created on demand when `channels` is given).
   * @param {{ agent: string, group?: string, channels?: string[], from?: "now" | "earliest", mode?: "wake" | "poll", meta?: object, durable?: boolean }} options
   */
  attach(options) { return this.request("POST", "/v1/subscriptions", { body: options }); }
  async subscriptions({ agent } = {}) { return (await this.request("GET", "/v1/subscriptions", { query: { agent } })).subscriptions; }
  detach(subscriptionId) { return this.request("DELETE", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`); }
  touch(subscriptionId) { return this.request("POST", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/touch`); }

  /**
   * Lease the next events for a subscription. `waitMs` of -1 waits until an
   * event arrives, however long that takes.
   * @param {string} subscriptionId
   * @param {{ waitMs?: number, waiter?: string, max?: number, signal?: AbortSignal }} [options]
   */
  next(subscriptionId, options = {}) {
    return this.#poll(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}/next`, options);
  }

  /** Like `next`, across every subscription the agent holds. */
  nextForAgent(agent, options = {}) {
    return this.#poll(`/v1/agents/${encodeURIComponent(agent)}/next`, options);
  }

  async #poll(path, { waitMs = 0, waiter = randomId(), max, signal } = {}) {
    const deadline = waitMs < 0 ? Infinity : Date.now() + waitMs;
    for (;;) {
      const chunk = Math.max(0, Math.min(POLL_CHUNK_MS, deadline - Date.now()));
      const result = await this.request("GET", path, { query: { wait_ms: chunk, waiter, max }, signal });
      if (result.events.length || Date.now() >= deadline) return result;
    }
  }

  /**
   * Iterate over events as they arrive. Each item carries `ack()` and
   * `nack()`; an event that is neither is redelivered when its lease expires.
   */
  async *listen(subscriptionId, { max, signal } = {}) {
    const waiter = randomId();
    while (!signal?.aborted) {
      const { events } = await this.next(subscriptionId, { waitMs: -1, waiter, max, signal });
      for (const event of events) {
        yield {
          event,
          ack: () => this.ack([event.id], { subscription: subscriptionId }),
          nack: () => this.nack([event.id], { subscription: subscriptionId }),
        };
      }
    }
  }

  ack(eventIds, { subscription, agent } = {}) { return this.request("POST", "/v1/ack", { body: { event_ids: eventIds, subscription, agent } }); }
  nack(eventIds, { subscription, agent } = {}) { return this.request("POST", "/v1/nack", { body: { event_ids: eventIds, subscription, agent } }); }

  presence(channel = "**") { return this.request("GET", "/v1/presence", { query: { channel } }); }

  // --- blobs ---

  /** Upload bytes (Blob, ArrayBuffer, Uint8Array or Buffer). */
  uploadBlob(data, { name, type } = {}) {
    return this.request("POST", "/v1/blobs", { raw: data, query: { name, type }, headers: { "content-type": type ?? "application/octet-stream" } });
  }

  async downloadBlob(id) {
    const response = await this.fetch(`${this.url}/v1/blobs/${encodeURIComponent(id)}`, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    if (!response.ok) throw new ListenerError(response.status, "blob_error", `Blob download failed with ${response.status}`);
    return response;
  }

  // --- administration ---

  createToken({ name, scopes, origins, replace }) { return this.request("POST", "/v1/tokens", { body: { name, scopes, origins, replace } }); }
  async tokens() { return (await this.request("GET", "/v1/tokens")).tokens; }
  revokeToken(ref) { return this.request("DELETE", `/v1/tokens/${encodeURIComponent(ref)}`); }
  openPairing({ name, scopes, origin, ttlMs }) { return this.request("POST", "/v1/pairing-grants", { body: { name, scopes, origin, ttl_ms: ttlMs } }); }
}

/**
 * Browser helper: obtain a token through an open pairing grant. Call from the
 * extension page whose origin the grant names.
 */
export async function pair(url, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl(`${url.replace(/\/$/, "")}/v1/pair`, { method: "POST" });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new ListenerError(response.status, value?.error?.code ?? "pair_failed", value?.error?.message ?? "Pairing failed");
  return value;
}
