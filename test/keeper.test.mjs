// The Windows keeper (windowsScript in src/service.mjs), run for real: it keeps the program running
// whatever ends it, a Ctrl+C included, and a Ctrl+C cannot end the keeper itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { windowsScript } from "../src/service.mjs";

const windowsOnly = process.platform === "win32" ? {} : { skip: "the keeper is a Windows logon task" };
const STATUS_CONTROL_C_EXIT = 0xC000013A;
const run = promisify(execFile);
const quotePs = (text) => text.replace(/'/g, "''");

async function until(check, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const starts = async (dir) => (await readFile(join(dir, "starts.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
const alive = (pid) => run("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { windowsHide: true }).then((r) => r.stdout.includes(String(pid)));

/** Run the keeper hidden, as the logon task does, around `program`; returns the keeper's pid. */
async function keeper(dir, program, t) {
  await writeFile(join(dir, "program.mjs"), program);
  const script = windowsScript({ name: "t", label: "t", description: "t", command: [process.execPath, join(dir, "program.mjs")], log: join(dir, "out.log"), restartSec: 1 }, join(dir, "keeper.pid"));
  await writeFile(join(dir, "keeper.ps1"), script);
  // In a hidden console of its own, as Task Scheduler starts it, and apart from this test's console.
  // Ctrl+C is first made to count again: a process ignores it when its parent did (a test runner
  // started from an agent or a CI service often does), and Task Scheduler starts the keeper without
  // that, so a keeper that inherited it would pass for the wrong reason.
  // The keeper writes its pid to keeper.pid, as it does for the service's stop().
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
    "Add-Type -Namespace L -Name K -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool a);'",
    "[L.K]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $false) | Out-Null",
    `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${join(dir, "keeper.ps1")}"'`,
  ].join("; ")], { stdio: "ignore", windowsHide: true });
  const pid = await until(async () => Number((await readFile(join(dir, "keeper.pid"), "utf8").catch(() => "")).trim()) || 0, 20_000);
  assert.ok(pid, "the keeper started");
  // Stop it as stop() does (the keeper's tree), then anything else still running from this folder
  // (a program started while the tree was being ended); then remove the folder.
  t.after(async () => {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ([string]$_.CommandLine).Contains('${quotePs(dir)}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return pid;
}

/**
 * Raise Ctrl+C on the console of `pid`, as any process sharing that console can. The helper first
 * lists every process on that console and refuses (exit 4) unless each belongs to this test (its
 * command line names `dir`), so it cannot reach a real service such as the installed broker.
 */
const ctrlC = (pid, dir) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
  "Add-Type -Namespace T -Name K -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool FreeConsole(); [DllImport(\"kernel32.dll\")] public static extern bool AttachConsole(uint p); [DllImport(\"kernel32.dll\")] public static extern uint GetConsoleProcessList(uint[] l, uint n); [DllImport(\"kernel32.dll\")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool a); [DllImport(\"kernel32.dll\")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'",
  "[T.K]::FreeConsole() | Out-Null",
  `if (-not [T.K]::AttachConsole(${Number(pid)})) { exit 3 }`,
  "$list = New-Object 'uint32[]' 64; $n = [T.K]::GetConsoleProcessList($list, 64)",
  `foreach ($id in $list[0..($n - 1)]) { if ($id -eq $PID) { continue }; $line = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").CommandLine; if ($line -and -not $line.Contains('${quotePs(dir)}')) { exit 4 } }`,
  "[T.K]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null",
  "[T.K]::GenerateConsoleCtrlEvent(0, 0) | Out-Null",
].join("; ")], { windowsHide: true });

test("a program that exits with STATUS_CONTROL_C_EXIT (0xC000013A), or with 0, is started again", { ...windowsOnly, timeout: 60_000 }, async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "listener-mcp-keeper-")));
  // Each start is recorded: the first ends as a Ctrl+C ends a program, the second as the broker's
  // SIGINT handler ends it (exit 0); the third keeps running.
  await keeper(dir, `import { appendFileSync, readFileSync } from "node:fs";
const file = ${JSON.stringify(join(dir, "starts.log"))};
appendFileSync(file, process.pid + "\\n");
const count = readFileSync(file, "utf8").trim().split("\\n").length;
if (count === 1) process.exit(${STATUS_CONTROL_C_EXIT});
if (count === 2) process.exit(0);
setInterval(() => {}, 1 << 30);
`, t);
  const seen = await until(async () => ((await starts(dir)).length >= 3 ? starts(dir) : null));
  assert.equal(seen?.length, 3, "started, ended by 0xC000013A and by exit 0, and started again each time");
});

test("a Ctrl+C on the program's console or on the keeper's leaves both running", { ...windowsOnly, timeout: 60_000 }, async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "listener-mcp-keeper-")));
  // Like the broker: a SIGINT handler that exits 0.
  const keeperPid = await keeper(dir, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(dir, "starts.log"))}, process.pid + "\\n");
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`, t);
  const [programPid] = (await until(() => starts(dir).then((s) => (s.length ? s : null)))) ?? [];
  assert.ok(programPid, "the program started");

  // The guard itself: aimed at a console that is not this test's (a decoy started from another
  // folder, in a hidden console of its own), the helper refuses with exit 4 and the decoy lives on.
  const other = await realpath(await mkdtemp(join(tmpdir(), "listener-mcp-decoy-")));
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -Command "Set-Content -LiteralPath ''${join(other, "pid")}'' -Value $PID -Encoding ascii; Start-Sleep 60"'`], { stdio: "ignore", windowsHide: true });
  const decoy = await until(async () => Number((await readFile(join(other, "pid"), "utf8").catch(() => "")).trim()) || 0, 20_000);
  t.after(async () => { await run("taskkill", ["/PID", String(decoy), "/T", "/F"]).catch(() => {}); await rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  assert.ok(decoy, "the decoy started");
  await assert.rejects(ctrlC(decoy, dir), (error) => error.code === 4, "refused: that console is not the test's");
  assert.ok(await alive(decoy), "the decoy is untouched");

  await ctrlC(programPid, dir);
  await ctrlC(keeperPid, dir);
  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(await alive(keeperPid), "the keeper survives a Ctrl+C");
  // The program either ignored it (it inherits the keeper's choice) or ended and was started again.
  const now = await starts(dir);
  const running = await Promise.all(now.map(alive));
  assert.ok(running.some(Boolean), `a program is running (starts: ${now.length})`);
});
