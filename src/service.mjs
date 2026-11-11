// @ts-check
// Run a program as a per-user background service that starts at login and is
// restarted when it fails: a systemd user unit on Linux, a launchd agent on
// macOS, a logon task on Windows. The broker is one; apps built on
// listener-mcp use the same code for their own services (`listener-mcp/service`).
//
// Windows has no per-user service manager, so the logon task runs a hidden
// PowerShell that keeps the program running: it restarts it after a failure,
// appends its output to the log, and records its own pid so stop() can end the
// whole process tree.
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { files } from "./config.mjs";

const run = promisify(execFile);
const exists = (path) => access(path).then(() => true, () => false);

/**
 * @typedef {object} ServiceSpec
 * @property {string} name          systemd unit and Windows task name ("listener-mcp" → listener-mcp.service)
 * @property {string} label         launchd label, reverse-DNS ("dev.listener-mcp.broker")
 * @property {string} description
 * @property {string[]} command     the program and its arguments
 * @property {string} [cwd]         working directory
 * @property {string} [log]         where output goes on macOS and Windows (Linux: the journal)
 * @property {string} [after]       systemd unit to start after
 * @property {number} [restartSec]  pause before a restart (default 2)
 * @property {Record<string, string>} [env] extra environment
 */

// ---- systemd ---------------------------------------------------------------

const systemdQuote = (/** @type {string} */ arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\])/g, "\\$1")}"`);

/** @param {ServiceSpec} spec */
export function systemdUnit(spec) {
  return [
    "[Unit]",
    `Description=${spec.description}`,
    ...(spec.after ? [`After=${spec.after}`] : []),
    "",
    "[Service]",
    ...(spec.cwd ? [`WorkingDirectory=${spec.cwd}`] : []),
    ...Object.entries(spec.env ?? {}).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    `ExecStart=${spec.command.map(systemdQuote).join(" ")}`,
    "Restart=on-failure",
    `RestartSec=${spec.restartSec ?? 2}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

// ---- launchd ---------------------------------------------------------------

const xml = (/** @type {unknown} */ text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** @param {ServiceSpec} spec */
export function launchdPlist(spec) {
  // Agents start with a bare PATH (/usr/bin:/bin:…), so tools from Homebrew would not be found.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", ...(spec.env ?? {}) };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(spec.label)}</string>
  <key>ProgramArguments</key><array>${spec.command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
${spec.cwd ? `  <key>WorkingDirectory</key><string>${xml(spec.cwd)}</string>\n` : ""}  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>${Math.max(1, spec.restartSec ?? 2)}</integer>
${spec.log ? `  <key>StandardOutPath</key><string>${xml(spec.log)}</string>\n  <key>StandardErrorPath</key><string>${xml(spec.log)}</string>\n` : ""}</dict></plist>
`;
}

// ---- Windows ---------------------------------------------------------------

const psQuote = (/** @type {unknown} */ text) => `'${String(text).replace(/'/g, "''")}'`;
const cmdQuote = (/** @type {unknown} */ arg) => `"${String(arg).replace(/"/g, '""')}"`;

/**
 * The PowerShell that the logon task runs (hidden): keep the program running, log its output.
 * @param {ServiceSpec} spec
 * @param {string} pidFile
 */
export function windowsScript(spec, pidFile) {
  const line = spec.command.map(cmdQuote).join(" ") + (spec.log ? ` >> ${cmdQuote(spec.log)} 2>&1` : "");
  return [
    "$ErrorActionPreference = 'Continue'",
    `Set-Content -LiteralPath ${psQuote(pidFile)} -Value $PID -Encoding ascii`,
    ...(spec.cwd ? [`Set-Location -LiteralPath ${psQuote(spec.cwd)}`] : []),
    ...Object.entries(spec.env ?? {}).map(([key, value]) => `$env:${key} = ${psQuote(value)}`),
    "while ($true) {",
    // cmd does the redirection (PowerShell 5 would re-encode the output); /s keeps the quoting as written.
    `  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList ${psQuote(`/d /s /c "${line}"`)} -NoNewWindow -Wait -PassThru`,
    "  if ($p.ExitCode -eq 0) { break }",
    `  Start-Sleep -Seconds ${Math.max(1, spec.restartSec ?? 2)}`,
    "}",
  ].join("\n");
}

/**
 * Task Scheduler XML: at logon of this user, without a time limit, also on battery.
 * @param {ServiceSpec} spec
 * @param {{ user: string, pidFile: string }} where
 */
export function windowsTask(spec, { user, pidFile }) {
  const encoded = Buffer.from(windowsScript(spec, pidFile), "utf16le").toString("base64");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(spec.description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}</Arguments></Exec></Actions>
</Task>
`;
}

// ---- the service -----------------------------------------------------------

/** @param {ServiceSpec} spec */
export function userService(spec) {
  const os = platform();
  const unitPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", `${spec.name}.service`);
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${spec.label}.plist`);
  const pidFile = join(process.env.LOCALAPPDATA ?? tmpdir(), `${spec.name}.service.pid`);
  const unit = `${spec.name}.service`;
  const domain = `gui/${process.getuid?.() ?? 0}`;

  const windowsPid = async () => Number((await readFile(pidFile, "utf8").catch(() => "")).trim()) || 0;
  const taskExists = () => run("schtasks", ["/Query", "/TN", spec.name]).then(() => true, () => false);

  async function stop() {
    if (os === "linux" && (await exists(unitPath))) await run("systemctl", ["--user", "stop", unit]).catch(() => {});
    if (os === "darwin" && (await exists(plistPath))) await run("launchctl", ["kill", "SIGTERM", `${domain}/${spec.label}`]).catch(() => {});
    if (os === "win32") {
      const pid = await windowsPid();
      // The keeper, cmd and the program: /T ends the tree, which /End alone may leave running.
      if (pid) await run("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
      await run("schtasks", ["/End", "/TN", spec.name]).catch(() => {});
      await rm(pidFile, { force: true });
    }
  }

  return {
    manager: os === "linux" ? "systemd" : os === "darwin" ? "launchd" : os === "win32" ? "task-scheduler" : null,
    stop,

    /** Install (or update) and (re)start, so a running copy picks up the new definition. */
    async install() {
      if (os === "linux") {
        await mkdir(dirname(unitPath), { recursive: true });
        await writeFile(unitPath, systemdUnit(spec), { mode: 0o644 });
        await run("systemctl", ["--user", "daemon-reload"]);
        await run("systemctl", ["--user", "enable", unit]);
        await run("systemctl", ["--user", "restart", unit]);
        return { manager: "systemd", path: unitPath };
      }
      if (os === "darwin") {
        await mkdir(dirname(plistPath), { recursive: true });
        if (spec.log) await mkdir(dirname(spec.log), { recursive: true });
        await run("launchctl", ["unload", plistPath]).catch(() => {});
        await writeFile(plistPath, launchdPlist(spec));
        await run("launchctl", ["load", "-w", plistPath]);
        return { manager: "launchd", path: plistPath };
      }
      if (os === "win32") {
        if (spec.log) await mkdir(dirname(spec.log), { recursive: true });
        await stop();
        const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : String(process.env.USERNAME);
        const definition = join(tmpdir(), `${spec.name}-${process.pid}.xml`);
        // Task Scheduler reads its XML as UTF-16.
        await writeFile(definition, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(windowsTask(spec, { user, pidFile }), "utf16le")]));
        try { await run("schtasks", ["/Create", "/TN", spec.name, "/XML", definition, "/F"]); }
        finally { await rm(definition, { force: true }); }
        await run("schtasks", ["/Run", "/TN", spec.name]);
        return { manager: "task-scheduler", task: spec.name };
      }
      throw new Error(`No service manager support for ${os}`);
    },

    async uninstall() {
      if (os === "linux" && (await exists(unitPath))) {
        await run("systemctl", ["--user", "disable", "--now", unit]).catch(() => {});
        await rm(unitPath, { force: true });
        await run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
        return true;
      }
      if (os === "darwin" && (await exists(plistPath))) {
        await run("launchctl", ["unload", "-w", plistPath]).catch(() => {});
        await rm(plistPath, { force: true });
        return true;
      }
      if (os === "win32" && (await taskExists())) {
        await stop();
        await run("schtasks", ["/Delete", "/TN", spec.name, "/F"]);
        return true;
      }
      return false;
    },

    /** Start the installed service; false when it is not installed. */
    async start() {
      if (os === "linux" && (await exists(unitPath))) { await run("systemctl", ["--user", "start", unit]); return true; }
      if (os === "darwin" && (await exists(plistPath))) { await run("launchctl", ["kickstart", `${domain}/${spec.label}`]); return true; }
      if (os === "win32" && (await taskExists())) { await run("schtasks", ["/Run", "/TN", spec.name]); return true; }
      return false;
    },

    async status() {
      if (os === "linux") {
        if (!(await exists(unitPath))) return { installed: false };
        const state = await run("systemctl", ["--user", "is-active", unit]).then((r) => r.stdout.trim(), (e) => String(e.stdout ?? "inactive").trim());
        return { installed: true, manager: "systemd", state };
      }
      if (os === "darwin") {
        if (!(await exists(plistPath))) return { installed: false };
        const state = await run("launchctl", ["list", spec.label]).then((r) => (/"PID"\s*=/.test(r.stdout) ? "active" : "inactive"), () => "inactive");
        return { installed: true, manager: "launchd", state };
      }
      if (os === "win32") {
        const query = await run("schtasks", ["/Query", "/TN", spec.name, "/FO", "CSV", "/NH"]).catch(() => null);
        if (!query) return { installed: false };
        return { installed: true, manager: "task-scheduler", state: /"Running"/i.test(query.stdout) ? "active" : "inactive" };
      }
      return { installed: false };
    },
  };
}

// ---- the broker ------------------------------------------------------------

const cliPath = fileURLToPath(new URL("../bin/listener-mcp.mjs", import.meta.url));
const broker = () => userService({
  name: "listener-mcp",
  label: "dev.listener-mcp.broker",
  description: "listener-mcp broker (app → agent event bridge)",
  command: [process.execPath, cliPath, "broker"],
  log: files().log,
});

export const installService = () => broker().install();
export const uninstallService = () => broker().uninstall();
export const startService = () => broker().start();
export const serviceStatus = () => broker().status();
