// @ts-check
// Delivery policy: who receives which event, and when.
//
// Model
//   event         something published on a channel (`mail/chat/default`)
//   group         a named set of channel patterns with its own queue. Each
//                 event matching a group is delivered to exactly one member of
//                 that group; separate groups each get their own copy.
//   subscription  one agent's membership in one group. An agent may join many
//                 groups; a group may have many agents (load sharing).
//   lease         a delivered event is held by one subscription until it is
//                 acked, nacked, or the lease expires (then it is redelivered).
//
// Waiting agents park an HTTP request here. Publishing wakes only the waiters
// whose groups the event belongs to; a woken waiter retries its lease and
// parks again if something else took the event first.
import { assertAgent, assertChannel, assertGroup, assertPattern, errors, matches, newId } from "../protocol.mjs";
import { canRead, isAdmin, requireChannel, requirePattern } from "./auth.mjs";

const typePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BATCH = 50;

/** Can some channel match both patterns? */
export function overlaps(a, b) {
  const x = a.split("/");
  const y = b.split("/");
  for (let index = 0; ; index++) {
    if (x[index] === "**" || y[index] === "**") return true;
    if (index >= x.length || index >= y.length) return x.length === y.length;
    if (x[index] !== "*" && y[index] !== "*" && x[index] !== y[index]) return false;
  }
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/** The public shape of an event. */
export function toWire(event) {
  return {
    id: event.id,
    seq: event.seq,
    channel: event.channel,
    type: event.type,
    data: event.data,
    from: { client: event.from_client, agent: event.from_agent },
    to: event.to_agent,
    reply_to: event.reply_to,
    created_at: iso(event.created_at),
    expires_at: iso(event.expires_at),
  };
}

const subscriptionWire = (sub, waiting) => ({
  id: sub.id, agent: sub.agent, group: sub.group, mode: sub.mode, meta: sub.meta,
  created_at: iso(sub.created_at), last_seen_at: iso(sub.last_seen_at), waiting,
});

const groupWire = (group) => ({ name: group.name, channels: group.patterns, durable: group.durable, created_by: group.created_by, created_at: iso(group.created_at) });

export class Bus {
  /**
   * @param {{ store: import("./store.mjs").Store, limits: Record<string, number>, clock?: () => number }} options
   */
  constructor({ store, limits, clock = Date.now }) {
    this.store = store;
    this.limits = limits;
    this.now = clock;
    /** @type {Map<string, { waiter: string, group: string, wake: (reason?: string) => void }>} */
    this.waiters = new Map();
    /** Waiter ids replaced by a newer waiter, per subscription; they get 409 from then on. */
    this.retired = new Map();
    /** @type {Map<string, Set<() => void>>} */
    this.replyWaiters = new Map();
  }

  // --- publishing -------------------------------------------------------------

  publish(principal, input) {
    const channel = assertChannel(input.channel);
    requireChannel(principal, "publish", channel);
    const type = input.type ?? "message";
    if (typeof type !== "string" || !typePattern.test(type)) throw errors.badRequest("type must match [A-Za-z0-9._-]{1,64}");
    const data = input.data ?? null;
    const encoded = JSON.stringify(data);
    if (encoded === undefined) throw errors.badRequest("data must be JSON");
    if (Buffer.byteLength(encoded) > this.limits.event_bytes) throw errors.tooLarge(`Event data exceeds ${this.limits.event_bytes} bytes`);
    const fromAgent = input.agent == null ? null : assertAgent(input.agent);
    const toAgent = input.to == null ? null : assertAgent(input.to);
    if (input.reply_to != null && typeof input.reply_to !== "string") throw errors.badRequest("reply_to must be an event id");
    const now = this.now();
    const ttl = input.ttl_ms == null ? null : Number(input.ttl_ms);
    if (ttl != null && (!Number.isInteger(ttl) || ttl <= 0)) throw errors.badRequest("ttl_ms must be a positive integer");

    const event = {
      id: newId("evt"), channel, type, data, from_client: principal.name, from_agent: fromAgent, to_agent: toAgent,
      reply_to: input.reply_to ?? null, created_at: now, expires_at: ttl ? now + ttl : null,
    };
    const groups = this.store.transaction(() => {
      event.seq = this.store.insertEvent(event);
      const targets = this.#groupsFor(event);
      this.store.addPending(event.seq, targets, now);
      return targets;
    });
    this.#wakeGroups(new Set(groups));
    if (event.reply_to) for (const resolve of this.replyWaiters.get(event.reply_to) ?? []) resolve();
    return toWire(event);
  }

  /**
   * Groups an event is owed to: every group with a matching pattern, except
   * the publisher's own groups (an agent never receives its own replies), and
   * only groups containing the target when the event is addressed.
   */
  #groupsFor(event) {
    const result = [];
    for (const group of this.store.listGroups()) {
      if (!group.patterns.some((pattern) => matches(pattern, event.channel))) continue;
      const members = this.store.subscriptions({ group: group.name });
      if (event.from_agent && members.some((sub) => sub.agent === event.from_agent)) continue;
      if (event.to_agent && !members.some((sub) => sub.agent === event.to_agent)) continue;
      result.push(group.name);
    }
    return result;
  }

  #wakeGroups(groups) {
    for (const waiter of [...this.waiters.values()]) if (groups.has(waiter.group)) waiter.wake("event");
  }

  // --- reading ------------------------------------------------------------------

  event(principal, id) {
    const event = this.store.eventById(String(id));
    if (!event || !canRead(principal, event.channel)) throw errors.notFound("No such event");
    return { ...toWire(event), replies: this.store.repliesTo(event.id).filter((reply) => canRead(principal, reply.channel)).map(toWire) };
  }

  history(principal, { channel, after, before, limit }) {
    const pattern = assertPattern(channel);
    requirePattern(principal, "read", pattern);
    const size = Math.min(Math.max(Number(limit ?? 100), 1), 500);
    const collect = (fetch, cursor, forward) => {
      const out = [];
      while (out.length < size) {
        const batch = fetch(cursor);
        if (!batch.length) break;
        for (const event of batch) if (matches(pattern, event.channel)) out.push(event);
        cursor = batch[batch.length - 1].seq;
        if (batch.length < size) break;
      }
      const page = out.slice(0, size);
      return forward ? page : page.reverse();
    };
    if (before != null) {
      return collect((cursor) => this.store.eventsBefore([pattern], cursor, size), Number(before), false).map(toWire);
    }
    return collect((cursor) => this.store.eventsAfter([pattern], cursor, size), Number(after ?? 0), true).map(toWire);
  }

  /** Resolve when a reply to `eventId` exists, or after `ms`. */
  async waitForReplies(principal, eventId, ms) {
    const deadline = this.now() + ms;
    for (;;) {
      const replies = this.store.repliesTo(eventId).filter((reply) => canRead(principal, reply.channel));
      if (replies.length || this.now() >= deadline) return replies.map(toWire);
      await new Promise((resolve) => {
        const set = this.replyWaiters.get(eventId) ?? new Set();
        const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) this.replyWaiters.delete(eventId); resolve(undefined); };
        const timer = setTimeout(done, Math.max(deadline - this.now(), 0));
        set.add(done);
        this.replyWaiters.set(eventId, set);
      });
    }
  }

  // --- groups and subscriptions ----------------------------------------------------

  createGroup(principal, { name, channels, from = "now", durable = true }) {
    assertGroup(name);
    if (!Array.isArray(channels) || !channels.length) throw errors.badRequest("channels must be a non-empty array of patterns");
    channels.forEach((pattern) => { assertPattern(pattern); requirePattern(principal, "subscribe", pattern); });
    const existing = this.store.group(name);
    if (existing) {
      if (!sameSet(existing.patterns, channels)) throw errors.conflict("group_mismatch", `Group ${name} already exists with channels ${existing.patterns.join(", ")}`);
      return groupWire(existing);
    }
    if (from !== "now" && from !== "earliest") throw errors.badRequest('from must be "now" or "earliest"');
    const now = this.now();
    this.store.transaction(() => {
      this.store.insertGroup({ name, patterns: channels, startSeq: from === "now" ? this.store.lastSeq() : 0, durable, createdBy: principal.name, createdAt: now });
      if (from === "earliest") this.#backfill(name, channels, now);
    });
    return groupWire(/** @type {any} */ (this.store.group(name)));
  }

  #backfill(group, patterns, now) {
    let cursor = 0;
    for (;;) {
      const batch = this.store.eventsAfter(patterns, cursor, 500);
      if (!batch.length) return;
      for (const event of batch) {
        if (patterns.some((pattern) => matches(pattern, event.channel)) && (!event.expires_at || event.expires_at > now)) this.store.addPending(event.seq, [group], now);
      }
      cursor = batch[batch.length - 1].seq;
    }
  }

  groups(principal) {
    return this.store.listGroups().filter((group) => isAdmin(principal) || group.patterns.every((pattern) => principal.scopes.some((scope) => scope.startsWith("subscribe:") && overlaps(scope.slice(10), pattern)))).map((group) => ({
      ...groupWire(group),
      members: this.store.subscriptions({ group: group.name }).map((sub) => subscriptionWire(sub, this.waiters.has(sub.id))),
      pending: this.store.pendingCount(group.name, this.now()),
    }));
  }

  deleteGroup(principal, name) {
    const group = this.store.group(String(name));
    if (!group) throw errors.notFound(`No group ${name}`);
    group.patterns.forEach((pattern) => requirePattern(principal, "subscribe", pattern));
    for (const sub of this.store.subscriptions({ group: group.name })) this.#endWaiter(sub.id, "detached");
    this.store.deleteGroup(group.name);
    return { deleted: group.name };
  }

  /**
   * Join an agent to a group, creating the group if needed. Without a group
   * name the agent gets a private group `agent:<agent>`, removed when it leaves.
   */
  attach(principal, { agent, group, channels, from = "now", mode = "wake", meta = {}, durable }) {
    assertAgent(agent);
    if (!["wake", "poll"].includes(mode)) throw errors.badRequest('mode must be "wake" or "poll"');
    if (meta === null || typeof meta !== "object" || Array.isArray(meta) || JSON.stringify(meta).length > 4096) throw errors.badRequest("meta must be a small JSON object");
    const name = group ?? `agent:${agent}`;
    let existing = this.store.group(name);
    if (!existing) {
      if (!channels?.length) throw errors.badRequest(`Group ${name} does not exist; pass channels to create it`);
      this.createGroup(principal, { name, channels, from, durable: durable ?? Boolean(group) });
      existing = /** @type {any} */ (this.store.group(name));
    } else {
      if (channels?.length && !sameSet(existing.patterns, channels)) throw errors.conflict("group_mismatch", `Group ${name} listens on ${existing.patterns.join(", ")}, not ${channels.join(", ")}`);
      existing.patterns.forEach((pattern) => requirePattern(principal, "subscribe", pattern));
    }
    const now = this.now();
    let sub = this.store.subscriptionFor(agent, name);
    if (sub) {
      if (sub.token_id !== principal.id && !isAdmin(principal)) throw errors.forbidden(`Agent ${agent} is attached with another token`);
      this.store.updateSubscription(sub.id, { mode, meta, now });
    } else {
      this.store.insertSubscription({ id: newId("sub"), agent, group: name, mode, tokenId: principal.id, meta, now });
    }
    sub = /** @type {any} */ (this.store.subscriptionFor(agent, name));
    // A waiter already parked for this agent should now cover the new group too.
    for (const other of this.store.subscriptions({ agent })) if (other.id !== sub.id) this.waiters.get(other.id)?.wake("refresh");
    return { subscription: subscriptionWire(sub, this.waiters.has(sub.id)), group: groupWire(existing), pending: this.store.pendingCount(name, now) };
  }

  subscriptions(principal, { agent } = {}) {
    return this.store.subscriptions(agent ? { agent: assertAgent(agent) } : {})
      .filter((sub) => isAdmin(principal) || sub.token_id === principal.id)
      .map((sub) => subscriptionWire(sub, this.waiters.has(sub.id)));
  }

  #owned(principal, id) {
    const sub = this.store.subscription(String(id));
    if (!sub || (sub.token_id !== principal.id && !isAdmin(principal))) throw errors.notFound("No such subscription");
    return sub;
  }

  detach(principal, id) {
    const sub = this.#owned(principal, id);
    this.#remove(sub);
    return { detached: sub.id };
  }

  #remove(sub) {
    const now = this.now();
    this.#endWaiter(sub.id, "detached");
    this.store.transaction(() => {
      this.store.releaseLeases(sub.id, now);
      this.store.deleteSubscription(sub.id);
      const group = this.store.group(sub.group);
      if (group && !group.durable && !this.store.subscriptions({ group: group.name }).length) this.store.deleteGroup(group.name);
    });
    this.#wakeGroups(new Set([sub.group]));
  }

  /** Keep a subscription alive and extend the leases it holds. */
  touch(principal, id) {
    const sub = this.#owned(principal, id);
    const now = this.now();
    this.store.touchSubscription(sub.id, now);
    const extended = this.store.extendLeases(sub.id, now + this.limits.lease_ms, now);
    return { subscription: sub.id, extended };
  }

  // --- delivery -------------------------------------------------------------------------

  /**
   * Lease up to `max` events, parking until one arrives. The target is one
   * subscription (`{ subscription }`) or every subscription an agent holds
   * (`{ agent }`), so an agent attached to several apps waits in one call.
   *
   * `waitMs` of -1 waits indefinitely. `waiter` identifies the caller: a new
   * waiter id replaces the parked one (the newest caller wins), and a replaced
   * id is refused from then on, so two stale loops cannot ping-pong.
   * `signal` aborts the wait when the caller disconnects.
   */
  async next(principal, target, { waitMs = 0, waiter = null, max = 10, signal } = {}) {
    let subs = this.#targets(principal, target);
    if (!subs.length) throw errors.notFound(target.agent ? `Agent ${target.agent} has no subscriptions` : "No such subscription");
    const count = Math.min(Math.max(Number(max) || 1, 1), MAX_BATCH);
    const waiterId = waiter != null ? String(waiter) : newId("w");
    for (const sub of subs) this.#claim(sub, waiterId);
    const deadline = waitMs < 0 ? Infinity : this.now() + waitMs;
    for (;;) {
      const leased = [];
      for (const sub of subs) {
        this.store.touchSubscription(sub.id, this.now());
        if (leased.length < count) leased.push(...this.#lease(sub, count - leased.length));
      }
      if (leased.length) return { events: leased, timed_out: false };
      const remaining = deadline - this.now();
      if (remaining <= 0 || signal?.aborted) return { events: [], timed_out: true };
      const reason = await this.#park(subs, waiterId, remaining, signal);
      if (reason === "superseded") throw errors.conflict("superseded", "A newer waiter took over this subscription");
      if (reason === "timeout" || reason === "aborted" || reason === "replaced") return { events: [], timed_out: true };
      // "event", "detached" or "refresh": look again at what this waiter covers.
      subs = this.#targets(principal, target);
      if (!subs.length) throw errors.conflict("detached", "The subscription was detached");
      for (const sub of subs) this.#claim(sub, waiterId);
    }
  }

  #targets(principal, { subscription, agent }) {
    if (subscription) {
      const sub = this.store.subscription(String(subscription));
      return sub && (sub.token_id === principal.id || isAdmin(principal)) ? [sub] : [];
    }
    return this.store.subscriptions({ agent: assertAgent(agent) }).filter((sub) => sub.token_id === principal.id || isAdmin(principal));
  }

  #claim(sub, waiter) {
    const retired = this.retired.get(sub.id);
    if (retired?.has(waiter)) throw errors.conflict("superseded", "A newer waiter took over this subscription");
    const current = this.waiters.get(sub.id);
    if (current && current.waiter !== waiter) {
      const set = retired ?? new Set();
      set.add(current.waiter);
      if (set.size > 32) set.delete(set.values().next().value);
      this.retired.set(sub.id, set);
      current.wake("superseded");
    }
  }

  #park(subs, id, ms, signal) {
    return new Promise((resolve) => {
      let timer = null;
      let done = false;
      const wake = (reason = "event") => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        for (const sub of subs) if (this.waiters.get(sub.id)?.wake === wake) this.waiters.delete(sub.id);
        resolve(reason);
      };
      const onAbort = () => wake("aborted");
      // setTimeout overflows past 2^31-1 ms, so indefinite waits get no timer at all.
      if (Number.isFinite(ms)) timer = setTimeout(() => wake("timeout"), Math.min(ms, 2_147_483_647));
      signal?.addEventListener("abort", onAbort, { once: true });
      for (const sub of subs) {
        // The same waiter polling again (its earlier request was cut off locally)
        // replaces its own stale park; different waiters were settled by #claim.
        this.waiters.get(sub.id)?.wake("replaced");
        this.waiters.set(sub.id, { waiter: id, group: sub.group, wake });
      }
    });
  }

  #endWaiter(subId, reason) {
    this.waiters.get(subId)?.wake(reason);
    this.retired.delete(subId);
  }

  #lease(sub, count) {
    const now = this.now();
    return this.store.transaction(() => {
      const out = [];
      for (const event of this.store.deliverable(sub.group, sub.agent, now, count * 2)) {
        if (out.length >= count) break;
        if (event.attempts >= this.limits.max_attempts) {
          this.store.setDeliveryState({ seq: event.seq, group: sub.group, state: "dead", now });
          continue;
        }
        const leaseUntil = now + this.limits.lease_ms;
        this.store.lease({ seq: event.seq, group: sub.group, subscriptionId: sub.id, agent: sub.agent, leaseUntil, now });
        out.push({ ...toWire(event), delivery: { subscription: sub.id, group: sub.group, attempt: event.attempts + 1, lease_until: iso(leaseUntil) } });
      }
      return out;
    });
  }

  /** Hand leased events back immediately, e.g. when the response never reached the caller. */
  release(events) {
    const now = this.now();
    const groups = new Set();
    this.store.transaction(() => {
      for (const event of events) {
        const { subscription, group } = event.delivery;
        const delivery = this.store.delivery(event.seq, group);
        if (delivery?.state === "leased" && delivery.subscription_id === subscription) {
          this.store.setDeliveryState({ seq: event.seq, group, state: "pending", now });
          groups.add(group);
        }
      }
    });
    this.#wakeGroups(groups);
  }

  /** Mark events handled (`ack`) or give them back for redelivery (`nack`). */
  settle(principal, { subscription, agent, event_ids, outcome }) {
    if (!Array.isArray(event_ids) || !event_ids.length) throw errors.badRequest("event_ids must be a non-empty array");
    const subs = subscription ? [this.#owned(principal, subscription)] : this.store.subscriptions({ agent: assertAgent(agent) }).filter((sub) => sub.token_id === principal.id || isAdmin(principal));
    if (!subs.length) throw errors.notFound("No subscription to settle events for");
    const now = this.now();
    const results = [];
    const woken = new Set();
    this.store.transaction(() => {
      for (const eventId of event_ids) {
        const event = this.store.eventById(String(eventId));
        let settled = null;
        for (const sub of event ? subs : []) {
          const delivery = this.store.delivery(event.seq, sub.group);
          if (!delivery || delivery.state === "dead") continue;
          if (outcome === "ack") {
            if (delivery.state !== "acked") this.store.setDeliveryState({ seq: event.seq, group: sub.group, state: "acked", now });
            settled = "acked";
          } else if (delivery.state === "leased") {
            this.store.setDeliveryState({ seq: event.seq, group: sub.group, state: "pending", now });
            woken.add(sub.group);
            settled = "requeued";
          }
        }
        results.push({ event_id: eventId, result: settled ?? "not_found" });
      }
    });
    this.#wakeGroups(woken);
    return { results };
  }

  // --- presence -------------------------------------------------------------------------

  /**
   * Who is listening on a channel (or pattern): the groups that would receive
   * an event there, their members, whether a member is parked right now, and
   * which events are being worked on.
   */
  presence(principal, channel) {
    const pattern = assertPattern(channel);
    requirePattern(principal, "read", pattern);
    const now = this.now();
    const groups = this.store.listGroups().filter((group) => group.patterns.some((p) => overlaps(p, pattern))).map((group) => {
      const leases = this.store.activeLeases(group.name, now).filter((lease) => matches(pattern, lease.channel));
      const members = this.store.subscriptions({ group: group.name }).map((sub) => ({
        ...subscriptionWire(sub, this.waiters.has(sub.id)),
        working_on: leases.filter((lease) => lease.subscription_id === sub.id).map((lease) => lease.event_id),
      }));
      return { name: group.name, channels: group.patterns, durable: group.durable, pending: this.store.pendingCount(group.name, now), members };
    });
    const members = groups.flatMap((group) => group.members);
    return {
      channel: pattern,
      listening: members.some((member) => member.waiting),
      busy: members.some((member) => member.working_on.length > 0),
      attached: members.length > 0,
      groups,
    };
  }

  // --- housekeeping ------------------------------------------------------------------------

  /** Drop idle subscriptions and old events. Called periodically by the server. */
  sweep({ subscriptionIdleMs = 6 * 3_600_000 } = {}) {
    const now = this.now();
    for (const sub of this.store.staleSubscriptions(now - subscriptionIdleMs)) {
      if (!this.waiters.has(sub.id)) this.#remove(sub);
    }
    return { pruned: this.store.pruneEvents(now - this.limits.retention_days * 86_400_000) };
  }

  close() {
    for (const subId of [...this.waiters.keys()]) this.#endWaiter(subId, "detached");
  }
}

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
}
