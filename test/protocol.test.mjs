import { test } from "node:test";
import assert from "node:assert/strict";
import { assertChannel, assertPattern, covers, matches } from "../src/protocol.mjs";
import { overlaps } from "../src/broker/bus.mjs";

test("patterns match channels segment by segment", () => {
  assert.ok(matches("mail/chat/default", "mail/chat/default"));
  assert.ok(matches("mail/chat/*", "mail/chat/default"));
  assert.ok(!matches("mail/chat/*", "mail/chat/a/b"));
  assert.ok(matches("mail/**", "mail/chat/a/b"));
  assert.ok(matches("mail/**", "mail"));
  assert.ok(matches("**", "anything/at/all"));
  assert.ok(!matches("mail/*", "crm/x"));
});

test("covers decides whether a scope contains a pattern", () => {
  assert.ok(covers("mail/**", "mail/chat/*"));
  assert.ok(covers("**", "mail/**"));
  assert.ok(covers("mail/*/default", "mail/chat/default"));
  assert.ok(!covers("mail/chat/*", "mail/**"));
  assert.ok(!covers("mail/*", "mail/chat/x"));
  assert.ok(!covers("mail/chat", "mail/*"));
});

test("overlaps finds patterns that can share a channel", () => {
  assert.ok(overlaps("mail/*/default", "mail/chat/*"));
  assert.ok(overlaps("**", "x"));
  assert.ok(!overlaps("mail/chat/*", "mail/inbox/*"));
  assert.ok(!overlaps("mail/*", "mail/chat/x"));
});

test("names are validated", () => {
  assert.throws(() => assertChannel("mail//x"));
  assert.throws(() => assertChannel("mail/*"));
  assert.throws(() => assertChannel("../etc"));
  assert.equal(assertChannel("mail/chat/default"), "mail/chat/default");
  assert.throws(() => assertPattern("mail/**/x"));
  assert.equal(assertPattern("mail/**"), "mail/**");
});
