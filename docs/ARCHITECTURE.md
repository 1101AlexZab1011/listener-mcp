# Architecture

## The problem

MCP connects an agent to an app in one direction: the agent calls the app's
tools. Many apps need the other direction as well:

- an in-app chat that talks to the agent;
- a process that tells the agent something happened (new mail, a failed
  build);
- a workflow with a non-linear lifecycle that needs the agent to react at
  arbitrary points.

Agent runtimes have no general inbound channel. The obvious workaround is an
MCP tool that blocks until the app has something to say, and it has a serious
flaw: the agent's turn never ends while the tool waits, so the user can't talk
to the agent. listener-mcp does the waiting **outside the turn** wherever the
runtime allows it, and has the app's events wake the agent.

## Pieces

```
src/
  protocol.mjs        names, patterns, scopes, error types: no I/O
  config.mjs          file locations, config, credentials (0600 files)
  client.mjs          HTTP client for apps and adapters (Node and browsers)
  broker/
    server.mjs        HTTP front door: Host/Origin/token checks, routes
    http.mjs          JSON bodies, responses, route table
    auth.mjs          token minting, scope checks
    bus.mjs           delivery policy: groups, leases, waiters, presence
    store.mjs         SQLite persistence (the only file with SQL)
    blobs.mjs         file storage for attachments
  agent.mjs           shared agent-side logic: connect, attach, format, wait
  hosts/              one module per agent runtime (claude, codex)
  mcp/server.mjs      the `listener` MCP server
  service.mjs         systemd / launchd integration
  project.mjs         .listener-mcp.json
  cli.mjs             `listener-mcp` commands
skill/SKILL.md        instructions installed into agent runtimes
```

Dependencies only point downwards. `protocol` depends on nothing. `store`
knows nothing about policy, and `bus` knows nothing about HTTP. Host adapters
know nothing about the broker's internals and use only `client`.

## Design decisions

**One broker per user, routing by name.** A port per agent or per app would
make every app track every agent's address, and an agent listening to two apps
would need two connections. Instead, channels name what happened, groups name
who handles it, and subscriptions tie agents to groups. That covers N apps × M
agents, load sharing and fan-out on a single port. A second broker, with its
own `LISTENER_MCP_HOME` and port, remains available for hard isolation.

**Waiting outside the turn.** Claude Code runs `asyncRewake` hooks in the
background and turns an exit code of 2 into a new message for the model. The
Stop hook therefore parks on the broker after each turn, and the user can keep
chatting in the meantime. Codex has no such mechanism yet, so there the Stop
hook waits inside the turn and returns the events as a continuation. Where
hooks don't run at all, the `listener_wait` tool is the fallback. The broker
is identical in every case; only the host module differs.

**Delivery rows created at publish time.** Publishing an event writes one
`pending` row per group that should receive it. Leasing is then an indexed
scan of that group's rows. The group's own replies and events that match only
a prefix never enter its queue, so they can't pile up in front of real work.

**Leases, not deletes.** An event is leased when it is delivered, and becomes
final only when it is acked. A process that dies mid-task causes redelivery
after the lease expires. A response that never reached its caller causes
immediate redelivery.

**Newest waiter wins.** Every wait carries a waiter id. After a turn ends,
Claude Code starts a new Stop hook while the previous one may still be parked.
The broker hands the subscription to the newest waiter and refuses the old id
from then on, which prevents two loops from taking turns to steal it.

**Presence is parked requests.** A heartbeat only proves that a process is
alive. `listening` is true only while a wait is actually parked, and it drops
the moment the connection closes.

**Secrets never touch the repo.** `.listener-mcp.json` names a credential. The
token itself lives in `~/.config/listener-mcp/credentials/` with mode 0600,
and the broker stores only its hash.

## Extension points

- **A new agent runtime:** add a module to `src/hosts/` exporting
  `{ name, mode, agentId, install, uninstall, hooks }`, and register it in
  `src/hosts/index.mjs`. `init --agent <name>` and
  `hook <event> --host <name>` pick it up automatically.
- **A new client language:** implement the HTTP API in
  [PROTOCOL.md](PROTOCOL.md). Only the endpoints the app needs are required;
  usually that's publish, history and presence.
- **A different store:** reimplement the methods of `src/broker/store.mjs`.
  `bus.mjs` depends on nothing else.
- **Embedding:** `startBroker({ config, database, port })` from
  `listener-mcp/broker` runs a broker inside another process. The tests do
  this.
- **Protocol evolution:** new fields may be added within version 1, and
  clients must ignore fields they don't know. Breaking changes go under
  `/v2/`, and `GET /v1/health` reports the protocol version.

## Roadmap

- **Drive adapter:** when an event arrives and no agent is attached, start one
  headlessly (`claude -p --resume`, `codex exec resume`, Codex app-server) to
  handle it.
- **Claude Code channels:** push events through `claude/channel` notifications
  where that research preview is enabled.
- **Streaming:** a Server-Sent Events endpoint for apps that want to follow a
  channel without polling history.
- **Windows service:** a scheduled task or service wrapper. Today the broker
  starts on demand.
