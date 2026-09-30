# listener-mcp protocol, version 1

The broker speaks JSON over HTTP/1.1 on a loopback address (default
`http://127.0.0.1:47800`). Any language that can make HTTP requests can use it.
The JS client in `src/client.mjs` is a thin wrapper around this API.

## Conventions

- Every request except `GET /v1/health` and `/v1/pair` carries
  `Authorization: Bearer <token>`.
- Request and response bodies are JSON objects. Errors look like this:
  `{"error": {"code": "forbidden", "message": "…"}}`. The HTTP status and the
  `code` are stable; the message is for humans.
- Timestamps are ISO 8601 strings in UTC.
- Unknown request fields are ignored, and new response fields may be added
  within version 1. Clients must tolerate both.

| Status | Code                                         | Meaning                                                  |
|--------|----------------------------------------------|----------------------------------------------------------|
| 400    | `bad_request`                                | Invalid input                                            |
| 401    | `unauthorized`                               | Missing or unknown token                                 |
| 403    | `forbidden`                                  | Scope, Host or Origin check failed                       |
| 404    | `not_found`                                  | No such resource, or not visible to this token           |
| 409    | `superseded`, `detached`, `group_mismatch`   | The wait was replaced or ended; the group has other channels |
| 413    | `too_large`                                  | The body exceeds a limit                                 |

## Names

- **Channel**: slash-separated segments of `[A-Za-z0-9._-]`, each starting
  with a letter or digit, at most 200 characters. By convention the first
  segment names the app: `mail/chat/default`.
- **Pattern**: a channel in which `*` matches exactly one segment and a final
  `**` matches any number of trailing segments, including none.
  `mail/**` matches `mail`, `mail/chat` and `mail/chat/default`.
- **Agent id**: names one agent session, `[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}`.
  Host adapters use `<host>:<session id>`, e.g. `claude:1f0c…`.
- **Group**: same character rules as an agent id.

## Scopes

| Scope                 | Grants                                                           |
|-----------------------|------------------------------------------------------------------|
| `admin`               | Everything, including tokens and pairing grants                  |
| `publish:<pattern>`   | `POST /v1/events` on channels the pattern matches                |
| `subscribe:<pattern>` | Create and join groups whose patterns lie inside `<pattern>`     |
| `read:<pattern>`      | History, single events and presence inside `<pattern>`           |
| `blobs`               | Upload and download blobs                                        |

A token may mint only tokens whose scopes it covers itself.

## Events

```json
{
  "id": "evt_Qm9…",
  "seq": 42,
  "channel": "mail/chat/default",
  "type": "message",
  "data": { "text": "Summarise today's mail" },
  "from": { "client": "thunderbird", "agent": null },
  "to": null,
  "reply_to": null,
  "created_at": "2026-09-30T20:15:03.120Z",
  "expires_at": null
}
```

- `seq` increases across the whole broker. Use it as a cursor.
- `type` is app-defined, `[A-Za-z0-9._-]{1,64}`. The defaults are `message`
  and `reply`.
- `data` is any JSON value, at most 256 KiB. By convention, human-readable
  text goes in `data.text`.
- `from.client` is the publishing token's name. `from.agent` is the agent id
  the publisher declared, which is used to keep an agent's own events from
  being delivered back to it.

### `POST /v1/events`: publish

```json
{ "channel": "mail/chat/default", "type": "message", "data": {…},
  "to": "claude:…", "reply_to": "evt_…", "ttl_ms": 600000, "agent": "claude:…",
  "wait_reply_ms": 60000 }
```

Only `channel` is required. The response is `201` with the event.

- With `wait_reply_ms`, the response is sent when the first reply exists or
  the time runs out, and carries `replies: [...]`.
- `to` restricts delivery to groups that contain that agent, and within those
  groups to that agent.
- `ttl_ms` makes the event expire: expired events are never delivered.

### `GET /v1/events?channel=<pattern>&after=<seq>&limit=<n>`: history

Returns `{ "events": [...] }`, oldest first. Use `before=<seq>` instead of
`after` to page backwards from the end; results are still returned oldest
first. `limit` is at most 500.

### `GET /v1/events/:id`

Returns the event plus `replies`: the events whose `reply_to` is this event.

## Groups and subscriptions

A **group** is a named list of channel patterns with its own queue. When an
event is published, it becomes *pending* in every group that has a pattern
matching the channel, except:

- groups that contain the publishing agent;
- when `to` is set, groups that don't contain the target.

A **subscription** is one agent's membership in one group.

### `POST /v1/groups`

```json
{ "name": "mail-chat", "channels": ["mail/chat/*"], "from": "earliest", "durable": true }
```

- Idempotent: creating a group again with the same channels returns it, while
  different channels give `409 group_mismatch`.
- `from: "earliest"` backfills retained events.
- A durable group outlives its members, so events queue while nobody is
  attached.

`GET /v1/groups` lists groups with their members and pending counts.
`DELETE /v1/groups/:name` deletes one.

### `POST /v1/subscriptions`: attach

```json
{ "agent": "claude:…", "group": "mail-chat", "channels": ["mail/chat/*"], "from": "now", "mode": "wake", "meta": {} }
```

- Without `group`, the agent gets a private, non-durable group
  `agent:<agent>`, which is removed when the agent leaves.
- Passing `channels` creates the group if it doesn't exist.
- `mode` (`wake` or `poll`) is informational: it records how the host
  delivers events.
- Attaching again updates the existing subscription.

The response is `{ subscription, group, pending }`.

- `GET /v1/subscriptions?agent=<id>`: the subscriptions this token owns (all
  of them for admin).
- `DELETE /v1/subscriptions/:id`: detach. Leases the subscription holds go
  back to the group.
- `POST /v1/subscriptions/:id/touch`: keeps the subscription alive and
  extends its leases. A subscription with no activity for 6 hours is removed.

## Delivery

```
pending ──lease──▶ leased ──ack──▶ acked
   ▲                 │
   └──nack/expiry────┘ (after max_attempts: dead)
```

### `GET /v1/subscriptions/:id/next` and `GET /v1/agents/:agent/next`

Query parameters: `wait_ms`, `waiter` and `max`.

- Leases up to `max` events (default 10, at most 50). The first form covers
  one subscription; the second covers every subscription of the agent that
  this token owns.
- If nothing is pending, the request is parked for up to `wait_ms`: `-1` means
  no limit, and the maximum otherwise is 86400000. It is answered as soon as
  a matching event is published.
- `waiter` is an opaque id for the waiting process.
  - A request with a new waiter id replaces the parked one, which receives
    `409 superseded`. The newest waiter always wins.
  - An id that has been replaced is refused from then on, so stale loops
    can't fight over a subscription.
  - The same waiter polling again (after a client-side timeout) simply
    continues.
- Response: `{ "events": [...], "timed_out": false }`. Each event carries
  `delivery: { subscription, group, attempt, lease_until }`.
- A lease counts only if the response was delivered in full. If the caller
  disconnects first, the events go back to pending at once.

Node's built-in `fetch` abandons response bodies after 300 s. Clients
therefore poll in chunks of 240 s with a constant `waiter`; the JS client does
this for you.

### `POST /v1/ack` and `POST /v1/nack`

```json
{ "event_ids": ["evt_…"], "subscription": "sub_…" }
```

`agent` can be given instead of `subscription`. `ack` marks the events
handled. `nack` returns leased events to pending for immediate redelivery. The
response lists a result per event: `acked`, `requeued` or `not_found`.

## Presence

### `GET /v1/presence?channel=<channel or pattern>`

```json
{
  "channel": "mail/chat/default",
  "listening": true,
  "busy": false,
  "attached": true,
  "groups": [{ "name": "mail-chat", "channels": ["mail/chat/*"], "durable": true, "pending": 0,
               "members": [{ "agent": "claude:…", "waiting": true, "working_on": [], "last_seen_at": "…" }] }]
}
```

- `listening`: some member has a wait parked right now.
- `busy`: some member holds an unexpired lease on a matching channel.
- `attached`: at least one member exists, even if it isn't parked right now.

## Blobs

- `POST /v1/blobs?name=<file name>&type=<mime>` with the raw bytes as the
  body stores a file (25 MiB at most). It returns
  `{ id, name, type, size, path, url }`, where `path` is the local file a
  same-machine agent can read directly. The file is named `<id>.<name>`, and
  ids never contain `.`, so a path can always be mapped back to its blob id.
- `GET /v1/blobs/:id` streams the file back. Images, PDF, plain text, JSON,
  audio and video are served inline. Everything else is served as an
  `application/octet-stream` download with a `sandbox` CSP.

## Tokens and pairing (admin)

- `POST /v1/tokens` with `{ name, scopes, origins?, replace? }` returns
  `{ token, id, … }`. The token is shown only in this response.
- `GET /v1/tokens` lists tokens. `DELETE /v1/tokens/:id-or-name` revokes one.
- `POST /v1/pairing-grants` with `{ name, scopes, origin, ttl_ms? }` opens a
  one-shot grant for a browser origin.
- `POST /v1/pair` requires no token; the browser's `Origin` header must match
  an open grant. Use POST: browsers must send `Origin` on it, while extension
  GET requests (Thunderbird, Firefox with host permissions) may omit it. GET is
  accepted too, for browsers that do send the header. It consumes the grant and returns `{ token, name, scopes }`
  for a new token bound to that origin. Earlier tokens with the same name are
  revoked.

## Health

`GET /v1/health` returns `{ "ok": true, "protocol": 1, "version": "0.1.2" }`
and needs no token. `GET /v1/whoami` describes the calling token.
