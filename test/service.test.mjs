import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { launchdPlist, systemdUnit, userService, windowsScript, windowsTask } from "../src/service.mjs";
import { serverCommand } from "../src/hosts/common.mjs";
import { cmdArgument, runSync } from "../src/command.mjs";

const spec = {
  name: "demo-service",
  label: "dev.listener-mcp.demo",
  description: "Demo & test",
  command: ["/opt/node js/node", "/srv/app.mjs", "serve"],
  log: "/var/log/it's.log",
  cwd: "/srv",
  env: { MODE: "a b" },
};

test("a systemd unit quotes arguments that need it", () => {
  const unit = systemdUnit({ ...spec, after: "listener-mcp.service" });
  assert.match(unit, /^ExecStart="\/opt\/node js\/node" \/srv\/app\.mjs serve$/m);
  assert.match(unit, /^Environment="MODE=a b"$/m);
  assert.match(unit, /^After=listener-mcp\.service$/m);
  assert.match(unit, /^Restart=on-failure$/m);
});

test("a launchd agent escapes XML and brings PATH along", () => {
  const plist = launchdPlist(spec);
  assert.match(plist, /<string>dev\.listener-mcp\.demo<\/string>/);
  assert.match(plist, /<array><string>\/opt\/node js\/node<\/string><string>\/srv\/app\.mjs<\/string><string>serve<\/string><\/array>/);
  assert.match(plist, /<string>\/var\/log\/it's\.log<\/string>/);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /<key>MODE<\/key><string>a b<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
});

test("the Windows keeper restarts on failure, logs through cmd and records its pid", () => {
  const script = windowsScript(spec, "C:\\Users\\a\\AppData\\Local\\demo.pid");
  assert.match(script, /Set-Content -LiteralPath 'C:\\Users\\a\\AppData\\Local\\demo\.pid' -Value \$PID/);
  assert.match(script, /'\/d \/s \/c ""\/opt\/node js\/node" "\/srv\/app\.mjs" "serve" >> "\/var\/log\/it''s\.log" 2>&1"'/);
  assert.match(script, /if \(\$p\.ExitCode -eq 0\) \{ break \}/);
  assert.match(script, /\$env:MODE = 'a b'/);
  const task = windowsTask(spec, { user: "PC\\a", pidFile: "x.pid" });
  assert.match(task, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  const encoded = /-EncodedCommand (\S+)<\/Arguments>/.exec(task)[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), windowsScript(spec, "x.pid"));
});

test("agents start the MCP server through cmd on Windows", () => {
  assert.deepEqual(serverCommand("listener-mcp", "linux"), { command: "listener-mcp", args: [] });
  assert.deepEqual(serverCommand("listener-mcp", "win32"), { command: "cmd", args: ["/c", "listener-mcp"] });
  assert.deepEqual(serverCommand('"C:\\\\node\\\\node.exe" cli.mjs', "win32"), { command: "C:\\node\\node.exe", args: ["cli.mjs"] });
});

test("arguments for a .cmd shim survive cmd", () => {
  assert.equal(cmdArgument('{"a":"b c"}', false), '^"{\\^"a\\^":\\^"b^ c\\^"}^"');
});

// A real install, run where the CI machine has a per-user service manager.
const live = process.env.CI && (process.platform === "win32" || process.platform === "darwin");
test("a service installs, runs, stops and uninstalls", { skip: !live && "needs CI on Windows or macOS", timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "listener-mcp-service-"));
  const marker = join(dir, "ran.txt");
  const service = userService({
    name: `listener-mcp-test-${process.pid}`,
    label: `dev.listener-mcp.test${process.pid}`,
    description: "listener-mcp test service",
    command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1e6)`],
    log: join(dir, "out.log"),
  });
  t.after(async () => { await service.uninstall().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  await service.install();
  let pid = 0;
  for (let i = 0; i < 60 && !pid; i++) { await new Promise((r) => setTimeout(r, 500)); pid = Number(await readFile(marker, "utf8").catch(() => "")); }
  assert.ok(pid, `the service never ran: ${await readFile(join(dir, "out.log"), "utf8").catch(() => "(no log)")}`);
  assert.equal((await service.status()).state, "active");
  assert.equal(await service.uninstall(), true);
  await new Promise((r) => setTimeout(r, 2000));
  assert.throws(() => process.kill(pid, 0), "the program was left running");
  assert.equal((await service.status()).installed, false);
});

test("a .cmd shim gets its arguments intact", { skip: process.platform !== "win32" && "Windows only" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "listener-mcp-shim-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // What npm writes for a CLI: a batch file that hands %* to node.
  await writeFile(join(dir, "echo-args.cmd"), `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`);
  const args = ["mcp", "add-json", '{"type":"stdio","command":"cmd","args":["/c","x y"]}', "100%", "a&b|c", "^caret", 'tail\\'];
  const out = runSync("echo-args", args, { encoding: "utf8", env: { ...process.env, PATH: `${dir};${process.env.PATH}` } });
  assert.deepEqual(JSON.parse(String(out)), args);
});
