// @ts-check
// Persistence for the broker. Only the broker process opens the database, so
// there is exactly one writer; WAL mode keeps reads cheap while it writes.
//
// The store is deliberately dumb: it runs SQL and maps rows. Delivery policy
// (leases, retries, who may see what) lives in bus.mjs, so a different backend
// only has to reimplement this file's methods.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  origins TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS pairing_grants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  from_client TEXT NOT NULL,
  from_agent TEXT,
  to_agent TEXT,
  reply_to TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS events_channel ON events (channel, seq);
CREATE INDEX IF NOT EXISTS events_reply_to ON events (reply_to);
CREATE TABLE IF NOT EXISTS groups (
  name TEXT PRIMARY KEY,
  patterns TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  durable INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  group_name TEXT NOT NULL REFERENCES groups (name) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  token_id TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (agent, group_name)
);
CREATE TABLE IF NOT EXISTS deliveries (
  event_seq INTEGER NOT NULL REFERENCES events (seq) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  state TEXT NOT NULL,
  subscription_id TEXT,
  agent TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_seq, group_name)
);
CREATE INDEX IF NOT EXISTS deliveries_queue ON deliveries (group_name, state, event_seq);
CREATE INDEX IF NOT EXISTS deliveries_holder ON deliveries (subscription_id, state);
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const json = (value) => JSON.stringify(value);
const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

/** Channels a set of patterns can reach, as SQL prefixes (null = everything). */
function prefixes(patterns) {
  const result = [];
  for (const pattern of patterns) {
    const parts = pattern.split("/");
    const literal = [];
    for (const part of parts) { if (part === "*" || part === "**") break; literal.push(part); }
    if (!literal.length) return null;
    result.push(literal.join("/"));
  }
  return result;
}

function channelFilter(patterns, params) {
  const list = prefixes(patterns);
  if (!list) return "1";
  return `(${list.map((prefix) => { params.push(prefix, `${prefix}/%`); return "(e.channel = ? OR e.channel LIKE ?)"; }).join(" OR ")})`;
}

export class Store {
  /** @param {string} path a file path, or ":memory:" */
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(schema);
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
  }

  close() { this.db.close(); }

  /** Run `fn` atomically. */
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  // --- tokens ---------------------------------------------------------------

  insertToken({ id, name, hash, scopes, origins = [], createdAt }) {
    this.db.prepare("INSERT INTO tokens (id, name, hash, scopes, origins, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, hash, json(scopes), json(origins), createdAt);
  }

  /** (Re)register the bootstrap admin token, even if an older row was revoked. */
  restoreAdmin({ id, hash, now }) {
    this.db.prepare("DELETE FROM tokens WHERE id = ? OR hash = ?").run(id, hash);
    this.insertToken({ id, name: "admin", hash, scopes: ["admin"], origins: [], createdAt: now });
  }

  tokenByHash(hash) {
    const row = this.db.prepare("SELECT * FROM tokens WHERE hash = ? AND revoked_at IS NULL").get(hash);
    return row ? this.#token(row) : null;
  }

  listTokens() {
    return this.db.prepare("SELECT * FROM tokens WHERE revoked_at IS NULL ORDER BY created_at").all().map((row) => this.#token(row));
  }

  revokeTokens({ id, name }, now) {
    const result = id
      ? this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id)
      : this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(now, name);
    return Number(result.changes);
  }

  touchToken(id, now) { this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now, id); }

  /** Origins any live token or pending pairing grant allows; used for CORS preflight. */
  knownOrigins(now) {
    const origins = new Set();
    for (const row of this.db.prepare("SELECT origins FROM tokens WHERE revoked_at IS NULL").all()) for (const origin of parse(String(row.origins), [])) origins.add(origin);
    for (const row of this.db.prepare("SELECT origin FROM pairing_grants WHERE used_at IS NULL AND expires_at > ?").all(now)) origins.add(String(row.origin));
    return origins;
  }

  #token(row) {
    return { id: row.id, name: row.name, scopes: parse(row.scopes, []), origins: parse(row.origins, []), created_at: row.created_at, last_used_at: row.last_used_at };
  }

  // --- pairing grants ---------------------------------------------------------

  insertGrant({ id, name, scopes, origin, expiresAt }) {
    this.db.prepare("INSERT INTO pairing_grants (id, name, scopes, origin, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, name, json(scopes), origin, expiresAt);
  }

  /** Atomically claim the newest open grant for `origin`, or return null. */
  claimGrant(origin, now) {
    const row = this.db.prepare("SELECT * FROM pairing_grants WHERE origin = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1").get(origin, now);
    if (!row) return null;
    const claimed = this.db.prepare("UPDATE pairing_grants SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, row.id);
    if (!Number(claimed.changes)) return null;
    return { id: row.id, name: row.name, scopes: parse(row.scopes, []), origin: row.origin };
  }

  // --- events -----------------------------------------------------------------

  insertEvent(event) {
    const result = this.db.prepare(`INSERT INTO events (id, channel, type, data, from_client, from_agent, to_agent, reply_to, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event.id, event.channel, event.type, json(event.data), event.from_client, event.from_agent ?? null, event.to_agent ?? null, event.reply_to ?? null, event.created_at, event.expires_at ?? null);
    return Number(result.lastInsertRowid);
  }

  eventById(id) {
    const row = this.db.prepare("SELECT * FROM events e WHERE id = ?").get(id);
    return row ? this.#event(row) : null;
  }

  lastSeq() { return Number(this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get()?.seq ?? 0); }

  /** Events on channels a pattern set may reach, oldest first, after `after`. */
  eventsAfter(patterns, after, limit) {
    const params = [after];
    const filter = channelFilter(patterns, params);
    params.push(limit);
    return this.db.prepare(`SELECT * FROM events e WHERE e.seq > ? AND ${filter} ORDER BY e.seq LIMIT ?`).all(...params).map((row) => this.#event(row));
  }

  /** Newest events first, for history pages that start from the end. */
  eventsBefore(patterns, before, limit) {
    const params = [before];
    const filter = channelFilter(patterns, params);
    params.push(limit);
    return this.db.prepare(`SELECT * FROM events e WHERE e.seq < ? AND ${filter} ORDER BY e.seq DESC LIMIT ?`).all(...params).map((row) => this.#event(row));
  }

  repliesTo(eventId) {
    return this.db.prepare("SELECT * FROM events e WHERE reply_to = ? ORDER BY seq").all(eventId).map((row) => this.#event(row));
  }

  #event(row) {
    return {
      seq: Number(row.seq), id: row.id, channel: row.channel, type: row.type, data: parse(row.data, null),
      from_client: row.from_client, from_agent: row.from_agent ?? null, to_agent: row.to_agent ?? null,
      reply_to: row.reply_to ?? null, created_at: Number(row.created_at), expires_at: row.expires_at == null ? null : Number(row.expires_at),
    };
  }

  // --- groups and subscriptions -------------------------------------------------

  insertGroup({ name, patterns, startSeq, durable, createdBy, createdAt }) {
    this.db.prepare("INSERT INTO groups (name, patterns, start_seq, durable, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(name, json(patterns), startSeq, durable ? 1 : 0, createdBy, createdAt);
  }

  group(name) {
    const row = this.db.prepare("SELECT * FROM groups WHERE name = ?").get(name);
    return row ? this.#group(row) : null;
  }

  listGroups() { return this.db.prepare("SELECT * FROM groups ORDER BY name").all().map((row) => this.#group(row)); }

  deleteGroup(name) { return Number(this.db.prepare("DELETE FROM groups WHERE name = ?").run(name).changes); }

  #group(row) {
    return { name: row.name, patterns: parse(row.patterns, []), start_seq: Number(row.start_seq), durable: Boolean(row.durable), created_by: row.created_by, created_at: Number(row.created_at) };
  }

  insertSubscription({ id, agent, group, mode, tokenId, meta = {}, now }) {
    this.db.prepare("INSERT INTO subscriptions (id, agent, group_name, mode, token_id, meta, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, agent, group, mode, tokenId, json(meta), now, now);
  }

  updateSubscription(id, { mode, meta, now }) {
    this.db.prepare("UPDATE subscriptions SET mode = COALESCE(?, mode), meta = COALESCE(?, meta), last_seen_at = ? WHERE id = ?").run(mode ?? null, meta ? json(meta) : null, now, id);
  }

  subscription(id) {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id);
    return row ? this.#subscription(row) : null;
  }

  subscriptionFor(agent, group) {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE agent = ? AND group_name = ?").get(agent, group);
    return row ? this.#subscription(row) : null;
  }

  subscriptions({ agent, group } = {}) {
    if (agent) return this.db.prepare("SELECT * FROM subscriptions WHERE agent = ? ORDER BY created_at").all(agent).map((row) => this.#subscription(row));
    if (group) return this.db.prepare("SELECT * FROM subscriptions WHERE group_name = ? ORDER BY created_at").all(group).map((row) => this.#subscription(row));
    return this.db.prepare("SELECT * FROM subscriptions ORDER BY created_at").all().map((row) => this.#subscription(row));
  }

  deleteSubscription(id) { return Number(this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id).changes); }

  touchSubscription(id, now) { this.db.prepare("UPDATE subscriptions SET last_seen_at = ? WHERE id = ?").run(now, id); }

  staleSubscriptions(before) {
    return this.db.prepare("SELECT * FROM subscriptions WHERE last_seen_at < ?").all(before).map((row) => this.#subscription(row));
  }

  #subscription(row) {
    return { id: row.id, agent: row.agent, group: row.group_name, mode: row.mode, token_id: row.token_id, meta: parse(row.meta, {}), created_at: Number(row.created_at), last_seen_at: Number(row.last_seen_at) };
  }

  // --- deliveries -----------------------------------------------------------------

  // A delivery row exists for every (event, group) pair the event is meant for;
  // the broker creates them when the event is published, or when a group is
  // created with a backlog. States: pending → leased → acked | dead.

  addPending(seq, groups, now) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO deliveries (event_seq, group_name, state, attempts, updated_at) VALUES (?, ?, 'pending', 0, ?)");
    for (const group of groups) insert.run(seq, group, now);
  }

  /**
   * Events a group owes and that nobody currently holds: pending, or leased
   * with an expired lease. Events addressed to another agent are skipped.
   */
  deliverable(group, agent, now, limit) {
    return this.db.prepare(`SELECT e.*, d.attempts AS attempts FROM deliveries d JOIN events e ON e.seq = d.event_seq
      WHERE d.group_name = ?
        AND (d.state = 'pending' OR (d.state = 'leased' AND d.lease_until <= ?))
        AND (e.expires_at IS NULL OR e.expires_at > ?)
        AND (e.to_agent IS NULL OR e.to_agent = ?)
      ORDER BY d.event_seq LIMIT ?`).all(group, now, now, agent, limit).map((row) => ({ ...this.#event(row), attempts: Number(row.attempts ?? 0) }));
  }

  pendingCount(group, now) {
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM deliveries d JOIN events e ON e.seq = d.event_seq
      WHERE d.group_name = ? AND (d.state = 'pending' OR (d.state = 'leased' AND d.lease_until <= ?)) AND (e.expires_at IS NULL OR e.expires_at > ?)`).get(group, now, now)?.n ?? 0);
  }

  lease({ seq, group, subscriptionId, agent, leaseUntil, now }) {
    this.db.prepare(`INSERT INTO deliveries (event_seq, group_name, state, subscription_id, agent, attempts, lease_until, updated_at)
      VALUES (?, ?, 'leased', ?, ?, 1, ?, ?)
      ON CONFLICT (event_seq, group_name) DO UPDATE SET state = 'leased', subscription_id = excluded.subscription_id,
        agent = excluded.agent, attempts = deliveries.attempts + 1, lease_until = excluded.lease_until, updated_at = excluded.updated_at`).run(seq, group, subscriptionId, agent, leaseUntil, now);
  }

  setDeliveryState({ seq, group, state, now, leaseUntil = null }) {
    this.db.prepare(`INSERT INTO deliveries (event_seq, group_name, state, attempts, lease_until, updated_at) VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT (event_seq, group_name) DO UPDATE SET state = excluded.state, lease_until = excluded.lease_until, updated_at = excluded.updated_at`).run(seq, group, state, leaseUntil, now);
  }

  delivery(seq, group) {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE event_seq = ? AND group_name = ?").get(seq, group);
    return row ? { seq: Number(row.event_seq), group: row.group_name, state: row.state, subscription_id: row.subscription_id, agent: row.agent, attempts: Number(row.attempts), lease_until: row.lease_until == null ? null : Number(row.lease_until) } : null;
  }

  /** Active leases in a group, with the leased event's channel. */
  activeLeases(group, now) {
    return this.db.prepare(`SELECT d.event_seq, d.agent, d.subscription_id, d.lease_until, e.channel, e.id FROM deliveries d JOIN events e ON e.seq = d.event_seq
      WHERE d.group_name = ? AND d.state = 'leased' AND d.lease_until > ?`).all(group, now)
      .map((row) => ({ seq: Number(row.event_seq), event_id: row.id, channel: row.channel, agent: row.agent, subscription_id: row.subscription_id, lease_until: Number(row.lease_until) }));
  }

  extendLeases(subscriptionId, leaseUntil, now) {
    return Number(this.db.prepare("UPDATE deliveries SET lease_until = ?, updated_at = ? WHERE subscription_id = ? AND state = 'leased' AND lease_until > ?").run(leaseUntil, now, subscriptionId, now).changes);
  }

  releaseLeases(subscriptionId, now) {
    return Number(this.db.prepare("UPDATE deliveries SET lease_until = ?, updated_at = ? WHERE subscription_id = ? AND state = 'leased' AND lease_until > ?").run(now, now, subscriptionId, now).changes);
  }

  // --- blobs ------------------------------------------------------------------------

  insertBlob(blob) {
    this.db.prepare("INSERT INTO blobs (id, path, name, type, size, token_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(blob.id, blob.path, blob.name, blob.type, blob.size, blob.token_id, blob.created_at);
  }

  blob(id) {
    const row = this.db.prepare("SELECT * FROM blobs WHERE id = ?").get(id);
    return row ? { ...row, size: Number(row.size), created_at: Number(row.created_at) } : null;
  }

  oldBlobs(before) { return this.db.prepare("SELECT * FROM blobs WHERE created_at < ?").all(before); }
  deleteBlob(id) { this.db.prepare("DELETE FROM blobs WHERE id = ?").run(id); }

  // --- retention ----------------------------------------------------------------------

  /** Drop old events; their delivery rows go with them (ON DELETE CASCADE). */
  pruneEvents(before) {
    return Number(this.db.prepare("DELETE FROM events WHERE created_at < ? OR (expires_at IS NOT NULL AND expires_at < ?)").run(before, before).changes);
  }
}
