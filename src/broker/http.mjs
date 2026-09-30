// @ts-check
// Small HTTP plumbing: JSON bodies, responses and a route table. Kept apart
// from the routes so the security checks in server.mjs read top to bottom.
import { errors, ProtocolError } from "../protocol.mjs";

/** Read a JSON body of at most `limit` bytes. */
export async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw errors.tooLarge(`Request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch { throw errors.badRequest("Request body must be a JSON object"); }
}

export function send(response, status, value, headers = {}) {
  if (response.headersSent) return;
  const body = status === 204 ? "" : JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

export function sendError(response, error, headers = {}) {
  if (error instanceof ProtocolError) return send(response, error.status, { error: { code: error.code, message: error.message } }, headers);
  return send(response, 500, { error: { code: "internal", message: "Internal broker error" } }, headers);
}

/**
 * A route table keyed by method, with `:param` segments. Handlers receive
 * `(context, params)` and return a value to send as JSON with status 200, or
 * `{ status, body }`, or nothing when they wrote the response themselves.
 */
export class Router {
  constructor() { this.routes = []; }

  add(method, path, handler, options = {}) {
    const parts = path.split("/").filter(Boolean);
    this.routes.push({ method, parts, handler, options });
    return this;
  }

  match(method, pathname) {
    const have = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== have.length) continue;
      const params = {};
      const ok = route.parts.every((part, index) => {
        if (part.startsWith(":")) {
          try { params[part.slice(1)] = decodeURIComponent(have[index]); } catch { return false; }
          return true;
        }
        return part === have[index];
      });
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}
