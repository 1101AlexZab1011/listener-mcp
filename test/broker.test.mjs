import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { testBroker, sleep } from "./helpers.mjs";

const agentScopes = ["subscribe:mail/**", "publish:mail/**", "read:mail/**"];

test("an attached agent receives, acks, and is not sent its own replies", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const app = await env.client("mail-app", ["publish:mail/**", "read:mail/**"]);
  const agent = await env.client("agent", agentScopes);

  const { subscription } = await agent.attach({ agent: "claude:s1", group: "mail-chat", channels: ["mail/chat/*"], from: "earliest" });
  const waiting = agent.next(subscription.id, { waitMs: 5000 });
  await sleep(50);
  const sent = await app.publish({ channel: "mail/chat/default", data: { text: "hello" } });
  const { events } = await waiting;
  assert.equal(events.length, 1);
  assert.equal(events[0].id, sent.id);
  assert.equal(events[0].delivery.attempt, 1);

  await agent.publish({ channel: "mail/chat/default", type: "reply", data: { text: "hi" }, replyTo: sent.id, agent: "claude:s1" });
  await agent.ack([sent.id], { subscription: subscription.id });
  const again = await agent.next(subscription.id, { waitMs: 100 });
  assert.equal(again.events.length, 0, "own reply and acked message are not redelivered");

  const history = await app.events({ channel: "mail/chat/*" });
  assert.deepEqual(history.map((event) => event.type), ["message", "reply"]);
  const withReplies = await app.event(sent.id);
  assert.equal(withReplies.replies[0].data.text, "hi");
});

test("messages published before any agent is present queue in a durable group", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  await env.admin.createGroup({ name: "mail-chat", channels: ["mail/chat/*"] });
  await env.admin.publish({ channel: "mail/chat/default", data: { text: "while away" } });
  const agent = await env.client("agent", agentScopes);
  const { subscription, pending } = await agent.attach({ agent: "codex:1", group: "mail-chat" });
  assert.equal(pending, 1);
  const { events } = await agent.next(subscription.id);
  assert.equal(events[0].data.text, "while away");
});

test("groups fan out; members of one group share the load", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const a = await agent.attach({ agent: "a", group: "workers", channels: ["mail/**"] });
  const b = await agent.attach({ agent: "b", group: "workers" });
  const auditor = await agent.attach({ agent: "auditor", channels: ["mail/**"] });

  await env.admin.publish({ channel: "mail/inbox/new", data: 1 });
  const first = await agent.next(a.subscription.id);
  const second = await agent.next(b.subscription.id);
  assert.equal(first.events.length + second.events.length, 1, "one worker gets it");
  const audit = await agent.next(auditor.subscription.id);
  assert.equal(audit.events.length, 1, "the other group gets its own copy");
});

test("nack and abandoned polls give events back", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const { subscription } = await agent.attach({ agent: "a", channels: ["mail/**"] });
  const event = await env.admin.publish({ channel: "mail/x", data: 1 });
  await agent.next(subscription.id);
  assert.equal((await agent.next(subscription.id)).events.length, 0, "leased");
  await agent.nack([event.id], { subscription: subscription.id });
  const retry = await agent.next(subscription.id);
  assert.equal(retry.events[0].delivery.attempt, 2);
});

test("a lease expires and the event is redelivered, then dead-lettered", async (t) => {
  const env = await testBroker({ lease_ms: 50, max_attempts: 2 });
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const { subscription } = await agent.attach({ agent: "a", channels: ["mail/**"] });
  await env.admin.publish({ channel: "mail/x", data: 1 });
  assert.equal((await agent.next(subscription.id)).events.length, 1);
  await sleep(80);
  assert.equal((await agent.next(subscription.id)).events[0].delivery.attempt, 2);
  await sleep(80);
  assert.equal((await agent.next(subscription.id)).events.length, 0, "dead after max attempts");
});

test("only waiters on matching channels are woken", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const chat = await agent.attach({ agent: "a", channels: ["mail/chat/*"] });
  let settled = false;
  const waiting = agent.next(chat.subscription.id, { waitMs: 300 }).then((result) => { settled = true; return result; });
  await sleep(30);
  await env.admin.publish({ channel: "mail/inbox/new", data: 1 });
  await sleep(50);
  assert.equal(settled, false, "an unrelated event does not end the wait");
  assert.equal((await waiting).timed_out, true);
});

test("a newer waiter supersedes the parked one, which cannot come back", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const { subscription } = await agent.attach({ agent: "a", channels: ["mail/**"] });
  const old = agent.next(subscription.id, { waitMs: 5000, waiter: "old" }).catch((error) => error);
  await sleep(30);
  const fresh = agent.next(subscription.id, { waitMs: 5000, waiter: "new" });
  assert.equal((await old).code, "superseded");
  await assert.rejects(agent.next(subscription.id, { waiter: "old" }), { code: "superseded" });
  await env.admin.publish({ channel: "mail/x", data: 1 });
  assert.equal((await fresh).events.length, 1);
});

test("presence reports parked and busy agents", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const { subscription } = await agent.attach({ agent: "a", group: "mail-chat", channels: ["mail/chat/*"] });
  const controller = new AbortController();
  const parked = agent.next(subscription.id, { waitMs: 5000, signal: controller.signal }).catch(() => null);
  await sleep(30);
  let presence = await env.admin.presence("mail/chat/default");
  assert.equal(presence.listening, true);
  assert.equal(presence.busy, false);
  controller.abort();
  await parked;
  await sleep(30);
  presence = await env.admin.presence("mail/chat/default");
  assert.equal(presence.listening, false, "a dropped poll stops counting at once");
  await env.admin.publish({ channel: "mail/chat/default", data: 1 });
  await agent.next(subscription.id);
  presence = await env.admin.presence("mail/chat/default");
  assert.equal(presence.busy, true);
});

test("events addressed to an agent reach only that agent", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const a = await agent.attach({ agent: "a", group: "g", channels: ["mail/**"] });
  const b = await agent.attach({ agent: "b", group: "g" });
  await env.admin.publish({ channel: "mail/x", data: 1, to: "b" });
  assert.equal((await agent.next(a.subscription.id)).events.length, 0);
  assert.equal((await agent.next(b.subscription.id)).events.length, 1);
});

test("request/reply waits for the agent's answer", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const { subscription } = await agent.attach({ agent: "a", channels: ["mail/**"] });
  (async () => {
    const { events } = await agent.next(subscription.id, { waitMs: 5000 });
    await agent.reply(events[0], { data: { answer: 42 }, agent: "a" });
  })();
  const result = await env.admin.publish({ channel: "mail/ask", data: { q: "?" }, waitReplyMs: 5000 });
  assert.equal(result.replies[0].data.answer, 42);
});

test("a reply answers its own event: on that event's channel, or from a token that may publish there (F52)", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  // A confirmation card asked on one device's channel, and who waits for its answer.
  const host = await env.client("host", ["publish:mail/devices/**", "read:mail/**"]);
  const phone = await env.client("phone", ["read:mail/devices/p1", "publish:mail/devices/p1"]);
  // Can read the phone's channel (so it learns the card's id) and publish elsewhere, not there.
  const other = await env.client("other", ["read:mail/devices/p1", "read:mail/chat/**", "publish:mail/chat/**"]);
  const card = await host.publish({ channel: "mail/devices/p1", type: "confirm", data: { question: "Send it?" } });
  const asked = await other.event(card.id);
  assert.equal(asked.id, card.id, "the other token can read the card");

  // Answering it from another channel is refused, and nothing is added.
  await assert.rejects(other.publish({ channel: "mail/chat/default", type: "reply", data: { answer: "yes" }, replyTo: card.id }), (error) => error.status === 403 && /may not answer an event on mail\/devices\/p1/.test(error.message));
  // Answering it on its own channel needs publish rights there, as any publish does.
  await assert.rejects(other.publish({ channel: "mail/devices/p1", type: "reply", data: { answer: "yes" }, replyTo: card.id }), (error) => error.status === 403);
  assert.equal((await host.event(card.id)).replies.length, 0, "no answer was taken");

  // The phone answers on the card's channel: taken.
  await phone.publish({ channel: "mail/devices/p1", type: "reply", data: { answer: "yes" }, replyTo: card.id });
  assert.equal((await host.event(card.id)).replies[0].data.answer, "yes");
  // A token that may publish on the card's channel may answer it from another channel (the host's own side).
  const desk = await env.client("desk", ["publish:mail/devices/**", "publish:mail/answers/**", "read:mail/**"]);
  await desk.publish({ channel: "mail/answers/p1", type: "reply", data: { answer: "no" }, replyTo: card.id });
  assert.deepEqual((await host.event(card.id)).replies.map((reply) => reply.data.answer), ["yes", "no"]);
});

test("a late answer to an event already swept is an ordinary publish on the sender's own channel (F52)", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const app = await env.client("mail-app", ["publish:mail/**", "read:mail/**"]);
  const agent = await env.client("agent", ["read:mail/chat/**", "publish:mail/chat/**"]);
  const asked = await app.publish({ channel: "mail/chat/default", data: { text: "still there?" } });
  // Older than retention_days: the sweep deletes it.
  env.broker.store.pruneEvents(Date.now() + 1);
  await assert.rejects(app.event(asked.id), (error) => error.status === 404, "the event is gone");
  const late = await agent.publish({ channel: "mail/chat/default", type: "reply", data: { text: "yes, sorry" }, replyTo: asked.id });
  assert.equal(late.reply_to, asked.id);
  assert.deepEqual((await app.events({ channel: "mail/chat/*" })).map((event) => event.data.text), ["yes, sorry"]);
  // Still only where the sender may publish.
  await assert.rejects(agent.publish({ channel: "mail/devices/p1", type: "reply", data: {}, replyTo: asked.id }), (error) => error.status === 403);
});

test("scopes limit what a token can do", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const app = await env.client("mail-app", ["publish:mail/**", "read:mail/**"]);
  await assert.rejects(app.publish({ channel: "crm/x", data: 1 }), { status: 403 });
  await assert.rejects(app.attach({ agent: "x", channels: ["mail/**"] }), { status: 403 });
  await assert.rejects(app.createToken({ name: "escalate", scopes: ["admin"] }), { status: 403 });
  await assert.rejects(app.events({ channel: "**" }), { status: 403 });
  const narrow = await app.createToken({ name: "narrow", scopes: ["publish:mail/chat/*"] });
  assert.ok(narrow.token.startsWith("lmcp_"));
  await assert.rejects(app.createToken({ name: "wide", scopes: ["publish:**"] }), { status: 403 });
});

test("requests need a valid token, a loopback Host, and a known Origin", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const raw = (headers, path = "/v1/whoami") => new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: env.broker.port, path, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(await raw({}, "/v1/health"), 200);
  assert.equal(await raw({ authorization: "Bearer nope" }), 401);
  assert.equal(await raw({ authorization: `Bearer ${env.broker.adminToken}`, host: "evil.example:80" }), 403);
  assert.equal(await raw({ authorization: `Bearer ${env.broker.adminToken}`, origin: "https://evil.example" }), 403);
  assert.equal(await raw({ authorization: `Bearer ${env.broker.adminToken}` }), 200);
});

test("pairing gives a browser origin one token, once", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const origin = "moz-extension://6a1b9c1e-7a55-4b39-9f5a-2b3c4d5e6f70";
  const pairRequest = () => fetch(`${env.broker.url}/v1/pair`, { method: "POST", headers: { origin } });
  assert.equal((await pairRequest()).status, 403, "no grant yet");
  await env.admin.openPairing({ name: "thunderbird", scopes: ["publish:mail/**", "read:mail/**", "blobs"], origin });
  const paired = await pairRequest();
  assert.equal(paired.status, 200);
  assert.equal(paired.headers.get("access-control-allow-origin"), origin);
  const { token } = await paired.json();
  assert.equal((await pairRequest()).status, 403, "grant is single use");
  const ok = await fetch(`${env.broker.url}/v1/events?channel=mail/**`, { headers: { origin, authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  const elsewhere = await fetch(`${env.broker.url}/v1/events?channel=mail/**`, { headers: { authorization: `Bearer ${token}`, origin: "moz-extension://00000000-0000-0000-0000-000000000000" } });
  assert.equal(elsewhere.status, 403);
});

test("blobs round-trip and dangerous types are not rendered", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const png = await env.admin.uploadBlob(new Uint8Array([137, 80, 78, 71]), { name: "shot.png", type: "image/png" });
  assert.equal(png.size, 4);
  assert.ok(png.path.endsWith(`${png.id}.shot.png`));
  const back = await env.admin.downloadBlob(png.id);
  assert.equal(back.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
  const html = await env.admin.uploadBlob(new TextEncoder().encode("<script>"), { name: "x.html", type: "text/html" });
  const served = await env.admin.downloadBlob(html.id);
  assert.equal(served.headers.get("content-type"), "application/octet-stream");
});

test("an agent waits on all of its groups at once, including ones it joins mid-wait", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const agent = await env.client("agent", ["subscribe:**", "publish:**", "read:**"]);
  await agent.attach({ agent: "claude:s", group: "mail", channels: ["mail/**"] });
  const waiting = agent.nextForAgent("claude:s", { waitMs: 5000 });
  await sleep(30);
  await agent.attach({ agent: "claude:s", group: "crm", channels: ["crm/**"] });
  await sleep(30);
  await env.admin.publish({ channel: "crm/lead/new", data: { name: "ACME" } });
  const { events } = await waiting;
  assert.equal(events[0].channel, "crm/lead/new");
  assert.equal(events[0].delivery.group, "crm");
  await agent.ack([events[0].id], { agent: "claude:s" });
  const presence = await env.admin.presence("crm/**");
  assert.equal(presence.busy, false);
});

test("an exclusive group admits one agent: others are refused, may take over, and replace a vanished one", async (t) => {
  const env = await testBroker({ presence_ms: 100 });
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const first = await agent.attach({ agent: "claude:a", group: "chat", channels: ["mail/chat/*"], exclusive: true });
  assert.equal(first.group.exclusive, true);
  await assert.rejects(agent.attach({ agent: "claude:b", group: "chat" }), (error) => error.code === "group_occupied" && /claude:a/.test(error.message));
  await agent.attach({ agent: "claude:a", group: "chat" });
  assert.equal((await agent.subscriptions({ agent: "claude:a" })).length, 1, "the member itself may attach again");

  const taken = await agent.attach({ agent: "claude:b", group: "chat", takeover: true });
  assert.equal(taken.subscription.agent, "claude:b");
  assert.equal((await agent.subscriptions({ agent: "claude:a" })).length, 0, "takeover detaches the old member");

  // A parked member is present however long it waits.
  const parked = agent.nextForAgent("claude:b", { waitMs: 400 });
  await sleep(150);
  await assert.rejects(agent.attach({ agent: "claude:c", group: "chat" }), { code: "group_occupied" });
  await parked;
  // Neither parked, nor holding a lease, nor seen for presence_ms: gone.
  await sleep(150);
  await agent.attach({ agent: "claude:c", group: "chat" });
  const [group] = await env.admin.groups();
  assert.deepEqual(group.members.map((member) => member.agent), ["claude:c"]);
});

test("exclusive is group policy: creating the group again updates it", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  await env.admin.createGroup({ name: "chat", channels: ["mail/chat/*"] });
  assert.equal((await env.admin.createGroup({ name: "chat", channels: ["mail/chat/*"], exclusive: true })).exclusive, true);
  assert.equal((await env.admin.createGroup({ name: "chat", channels: ["mail/chat/*"] })).exclusive, true, "omitting it keeps it");
  assert.equal((await env.admin.createGroup({ name: "chat", channels: ["mail/chat/*"], exclusive: false })).exclusive, false);
  const agent = await env.client("agent", agentScopes);
  await agent.attach({ agent: "a", group: "chat" });
  await agent.attach({ agent: "b", group: "chat" });
});

test("a group asked for with more channels takes them from now; a narrower or unscoped set is refused", async (t) => {
  const env = await testBroker();
  t.after(() => env.close());
  const agent = await env.client("agent", agentScopes);
  const { subscription } = await agent.attach({ agent: "claude:x", group: "mail-chat-x", channels: ["mail/chat/x"], from: "earliest" });
  await env.admin.publish({ channel: "mail/chat/x/earlier", data: { text: "before the group widened" } });

  // Attaching with every old pattern plus a new one widens the group, with no backfill.
  const widened = await agent.attach({ agent: "claude:x", group: "mail-chat-x", channels: ["mail/chat/x", "mail/chat/x/**"] });
  const [group] = (await env.admin.groups()).filter((item) => item.name === "mail-chat-x");
  assert.deepEqual(group.channels, ["mail/chat/x", "mail/chat/x/**"]);
  await env.admin.publish({ channel: "mail/chat/x/later", data: { text: "a second chat" } });
  await env.admin.publish({ channel: "mail/chat/x", data: { text: "the first chat" } });
  const { events } = await agent.next(widened.subscription.id, { waitMs: 1000 });
  assert.deepEqual(events.map((event) => event.channel), ["mail/chat/x/later", "mail/chat/x"], "no backfill of mail/chat/x/earlier");
  assert.equal(subscription.id, widened.subscription.id, "the same subscription goes on");

  // Creating it again the same way widens too, and asking with the same set changes nothing.
  await env.admin.createGroup({ name: "mail-chat-y", channels: ["mail/chat/y"] });
  assert.deepEqual((await env.admin.createGroup({ name: "mail-chat-y", channels: ["mail/chat/y/**", "mail/chat/y"] })).channels, ["mail/chat/y", "mail/chat/y/**"]);
  assert.deepEqual((await env.admin.createGroup({ name: "mail-chat-y", channels: ["mail/chat/y", "mail/chat/y/**"] })).channels, ["mail/chat/y", "mail/chat/y/**"]);

  // A narrower or a different set is still a mismatch.
  await assert.rejects(agent.attach({ agent: "claude:x", group: "mail-chat-x", channels: ["mail/chat/x/**"] }), { code: "group_mismatch" });
  await assert.rejects(env.admin.createGroup({ name: "mail-chat-y", channels: ["mail/chat/y", "mail/chat/z"] }), { code: "group_mismatch" });

  // An added pattern the caller may not subscribe to is refused, and the group stays as it was.
  const narrow = await env.client("narrow", ["subscribe:mail/chat/n", "subscribe:mail/chat/n/**", "publish:mail/**", "read:mail/**"]);
  await narrow.attach({ agent: "claude:n", group: "mail-chat-n", channels: ["mail/chat/n"] });
  await assert.rejects(narrow.attach({ agent: "claude:n", group: "mail-chat-n", channels: ["mail/chat/n", "mail/other/**"] }), { status: 403 });
  assert.deepEqual((await env.admin.groups()).find((item) => item.name === "mail-chat-n").channels, ["mail/chat/n"]);
  await narrow.attach({ agent: "claude:n", group: "mail-chat-n", channels: ["mail/chat/n", "mail/chat/n/**"] });
  assert.deepEqual((await env.admin.groups()).find((item) => item.name === "mail-chat-n").channels, ["mail/chat/n", "mail/chat/n/**"]);
});

test("a database from before exclusive groups is migrated", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { Store } = await import("../src/broker/store.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "listener-mcp-db-"));
  const path = join(dir, "broker.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE groups (name TEXT PRIMARY KEY, patterns TEXT NOT NULL, start_seq INTEGER NOT NULL, durable INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)");
  old.prepare("INSERT INTO groups VALUES ('chat', '[\"mail/chat/*\"]', 0, 1, 'admin', 0)").run();
  old.close();
  const store = new Store(path);
  // Close before removing: Windows keeps an open database's files.
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });
  assert.equal(store.group("chat")?.exclusive, false);
  store.setGroupExclusive("chat", true);
  assert.equal(store.group("chat")?.exclusive, true);
});
