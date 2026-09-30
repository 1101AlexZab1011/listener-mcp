// @ts-check
// Public API. Apps usually need only the client:
//
//   import { ListenerClient } from "listener-mcp/client";
//
// The broker and protocol helpers are exported for embedding and extensions.
export { ListenerClient, ListenerError, pair } from "./client.mjs";
export { startBroker, BROKER_VERSION } from "./broker/index.mjs";
export { matches, covers, assertChannel, assertPattern, PROTOCOL_VERSION, DEFAULT_PORT } from "./protocol.mjs";
export { hosts } from "./hosts/index.mjs";
