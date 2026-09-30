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
  const pairRequest = () => fetch(`${env.broker.url}/v1/pair`, { headers: { origin } });
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
  assert.ok(png.path.endsWith("shot.png"));
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
