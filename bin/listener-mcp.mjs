#!/usr/bin/env node
import { main } from "../src/cli.mjs";

// Output piped into `head` and friends may close early; that is not an error.
process.stdout.on("error", (error) => { if (error.code === "EPIPE") process.exit(0); throw error; });

await main(process.argv.slice(2));
