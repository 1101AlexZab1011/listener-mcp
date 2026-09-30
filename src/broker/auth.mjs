// @ts-check
// Tokens and what they may do.
//
// A token is 32 random bytes shown once; the broker stores only its SHA-256.
// Each token carries scopes:
//   admin                    everything, including minting tokens
//   publish:<pattern>        publish events on matching channels
//   subscribe:<pattern>      attach to / create groups inside the pattern
//   read:<pattern>           read history and presence inside the pattern
//   blobs                    upload and download blobs
import { createHash, randomBytes } from "node:crypto";
import { assertScope, covers, errors, matches, newId } from "../protocol.mjs";

export const TOKEN_PREFIX = "lmcp_";

export const hashToken = (token) => createHash("sha256").update(token).digest("hex");
export const generateToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/** Mint a token record and its secret. The secret is never stored. */
export function mintToken({ name, scopes, origins = [] }) {
  if (!name || typeof name !== "string" || name.length > 64) throw errors.badRequest("Token name must be 1-64 characters");
  if (name === "admin") throw errors.badRequest('The token name "admin" is reserved');
  if (!Array.isArray(scopes) || !scopes.length) throw errors.badRequest("A token needs at least one scope");
  scopes.forEach(assertScope);
  origins.forEach(assertOrigin);
  const secret = generateToken();
  return { secret, record: { id: newId("tok"), name, hash: hashToken(secret), scopes, origins } };
}

// Browser origins are the only thing that decides whether a web context may
// talk to the broker, so they are matched exactly: no wildcards.
const originPattern = /^(moz-extension|chrome-extension|safari-web-extension):\/\/[A-Za-z0-9-]{8,64}$|^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
export function assertOrigin(origin) {
  if (typeof origin !== "string" || !originPattern.test(origin)) throw errors.badRequest(`Unsupported origin ${JSON.stringify(origin)}: use an extension origin (moz-extension://…) or a loopback http origin`);
  return origin;
}

/** @typedef {{ id: string, name: string, scopes: string[], origins: string[] }} Principal */

export const isAdmin = (principal) => principal.scopes.includes("admin");

/** Throw unless `principal` may perform `action` on the concrete `channel`. */
export function requireChannel(principal, action, channel) {
  if (isAdmin(principal)) return;
  const prefix = `${action}:`;
  if (principal.scopes.some((scope) => scope.startsWith(prefix) && matches(scope.slice(prefix.length), channel))) return;
  throw errors.forbidden(`Token "${principal.name}" may not ${action} on ${channel}`);
}

/** Throw unless every channel `pattern` can reach is inside a granted scope. */
export function requirePattern(principal, action, pattern) {
  if (isAdmin(principal)) return;
  const prefix = `${action}:`;
  if (principal.scopes.some((scope) => scope.startsWith(prefix) && covers(scope.slice(prefix.length), pattern))) return;
  throw errors.forbidden(`Token "${principal.name}" may not ${action} on ${pattern}`);
}

export function requireScope(principal, scope) {
  if (isAdmin(principal) || principal.scopes.includes(scope)) return;
  throw errors.forbidden(`Token "${principal.name}" lacks the ${scope} scope`);
}

/** Can the principal read this concrete channel? Used to filter results. */
export function canRead(principal, channel) {
  if (isAdmin(principal)) return true;
  return principal.scopes.some((scope) => scope.startsWith("read:") && matches(scope.slice(5), channel));
}

/** A new scope list may not grant more than its creator holds. */
export function requireDelegable(principal, scopes) {
  if (isAdmin(principal)) return;
  for (const scope of scopes) {
    if (scope === "admin") throw errors.forbidden("Only admin tokens can mint admin tokens");
    if (scope === "blobs") { requireScope(principal, "blobs"); continue; }
    const [action, ...rest] = scope.split(":");
    requirePattern(principal, action, rest.join(":"));
  }
}
