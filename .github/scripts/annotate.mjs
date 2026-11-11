// Turn the failing tests in a node --test log into annotations, so a failure
// can be read on the run's page (and through the API) without its logs.
import { readFileSync } from "node:fs";

const log = readFileSync(process.argv[2] ?? "test-output.txt", "utf8").replace(/\x1b\[[0-9;]*m/g, "");
const start = log.lastIndexOf("✖ failing tests:");
const section = start >= 0 ? log.slice(start) : log.slice(-6000);
const blocks = section.split(/\n(?=test at )/).slice(start >= 0 ? 1 : 0);
const escape = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
for (const block of (blocks.length ? blocks : [section]).slice(0, 10)) {
  const title = /^✖ (.+?)(?: \(\d|$)/m.exec(block)?.[1] ?? "test failure";
  console.log(`::error title=${escape(title).replace(/[:,]/g, " ")}::${escape(block.slice(0, 3500))}`);
}
