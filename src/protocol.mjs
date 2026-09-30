// @ts-check
// Wire-level vocabulary shared by the broker, the client and every adapter.
// Nothing here does I/O, so any piece of the system can depend on it.
import { randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47800;
export const DEFAULT_HOST = "127.0.0.1";

// Channels are slash-separated names such as `mail/chat/default`. The first
// segment is conventionally the app, the rest is app-defined.
const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_CHANNEL_LENGTH = 200;

export class ProtocolError extends Error {
  /**
   * @param {number} status HTTP status the broker answers with
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable explanation
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const errors = {
  badRequest: (message) => new ProtocolError(400, "bad_request", message),
  unauthorized: () => new ProtocolError(401, "unauthorized", "A valid bearer token is required"),
  forbidden: (message) => new ProtocolError(403, "forbidden", message),
  notFound: (message) => new ProtocolError(404, "not_found", message),
  conflict: (code, message) => new ProtocolError(409, code, message),
  tooLarge: (message) => new ProtocolError(413, "too_large", message),
};

/** @param {unknown} value */
export function assertChannel(value) {
  if (typeof value !== "string" || value.length > MAX_CHANNEL_LENGTH || !value.split("/").every((part) => segment.test(part))) {
    throw errors.badRequest(`Invalid channel ${JSON.stringify(value)}: use slash-separated segments of [A-Za-z0-9._-], e.g. "mail/chat/default"`);
  }
  return value;
}

// Patterns add two wildcards: `*` matches exactly one segment, `**` matches any
// number of trailing segments (including none) and may only appear last.
/** @param {unknown} value */
export function assertPattern(value) {
  if (typeof value !== "string" || value.length > MAX_CHANNEL_LENGTH) throw errors.badRequest(`Invalid channel pattern ${JSON.stringify(value)}`);
  const parts = value.split("/");
  parts.forEach((part, index) => {
    if (part === "**" && index === parts.length - 1) return;
    if (part === "*" || segment.test(part)) return;
    throw errors.badRequest(`Invalid channel pattern ${JSON.stringify(value)}: segments are names, "*", or a final "**"`);
  });
  return value;
}

/** Does `pattern` match the concrete `channel`? */
export function matches(pattern, channel) {
  const want = pattern.split("/");
  const have = channel.split("/");
  for (let index = 0; index < want.length; index++) {
    if (want[index] === "**") return true;
    if (index >= have.length) return false;
    if (want[index] !== "*" && want[index] !== have[index]) return false;
  }
  return want.length === have.length;
}

/**
 * Does `outer` match every channel that `inner` can match? Used to check that
 * a subscription pattern stays inside the scope a token was granted.
 */
export function covers(outer, inner) {
  const a = outer.split("/");
  const b = inner.split("/");
  for (let index = 0; index < a.length; index++) {
    if (a[index] === "**") return true;
    if (index >= b.length) return false;
    if (b[index] === "**") return false;
    if (a[index] !== "*" && a[index] !== b[index]) return false;
  }
  return a.length === b.length;
}

/** @param {string} prefix */
export const newId = (prefix) => `${prefix}_${randomBytes(12).toString("base64url")}`;

// Agent ids name one live agent session, e.g. `claude:1f0c…` or `codex:019…`.
const agentId = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
/** @param {unknown} value */
export function assertAgent(value) {
  if (typeof value !== "string" || !agentId.test(value)) throw errors.badRequest(`Invalid agent id ${JSON.stringify(value)}`);
  return value;
}

const groupName = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
/** @param {unknown} value */
export function assertGroup(value) {
  if (typeof value !== "string" || !groupName.test(value)) throw errors.badRequest(`Invalid group name ${JSON.stringify(value)}`);
  return value;
}

// Scopes are `<action>:<pattern>` grants; `admin` alone grants everything.
export const ACTIONS = /** @type {const} */ (["publish", "subscribe", "read"]);
/** @param {unknown} value */
export function assertScope(value) {
  if (value === "admin" || value === "blobs") return value;
  if (typeof value !== "string") throw errors.badRequest("Scopes must be strings");
  const [action, ...rest] = value.split(":");
  if (!ACTIONS.includes(/** @type {any} */ (action)) || !rest.length) throw errors.badRequest(`Invalid scope ${JSON.stringify(value)}: use admin, blobs, or <publish|subscribe|read>:<pattern>`);
  assertPattern(rest.join(":"));
  return value;
}
