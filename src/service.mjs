// @ts-check
// Run the broker as a per-user background service: systemd on Linux, launchd
// on macOS. Elsewhere the broker is started on demand by the agent tools, or
// by hand with `listener-mcp broker`.
import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { files } from "./config.mjs";

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL("../bin/listener-mcp.mjs", import.meta.url));
const UNIT = "listener-mcp.service";
const LABEL = "dev.listener-mcp.broker";

const systemdUnit = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", UNIT);
const launchdPlist = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const exists = (path) => access(path).then(() => true, () => false);

export async function installService() {
  const os = platform();
  if (os === "linux") {
    const path = systemdUnit();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [
      "[Unit]",
      "Description=listener-mcp broker (app → agent event bridge)",
      "",
      "[Service]",
      `ExecStart=${process.execPath} ${cliPath} broker`,
      "Restart=on-failure",
      "RestartSec=2",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"), { mode: 0o644 });
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", UNIT]);
    // restart, not start: a broker that is already running must pick up this install.
    await run("systemctl", ["--user", "restart", UNIT]);
    return { manager: "systemd", path };
  }
  if (os === "darwin") {
    const path = launchdPlist();
    const log = files().log;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${cliPath}</string><string>broker</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`);
    await run("launchctl", ["load", "-w", path]);
    return { manager: "launchd", path };
  }
  throw new Error(`No service manager support for ${os}. Run "listener-mcp broker" at login instead; agent tools also start it on demand.`);
}

export async function uninstallService() {
  const os = platform();
  if (os === "linux" && (await exists(systemdUnit()))) {
    await run("systemctl", ["--user", "disable", "--now", UNIT]).catch(() => {});
    await rm(systemdUnit(), { force: true });
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
    return true;
  }
  if (os === "darwin" && (await exists(launchdPlist()))) {
    await run("launchctl", ["unload", "-w", launchdPlist()]).catch(() => {});
    await rm(launchdPlist(), { force: true });
    return true;
  }
  return false;
}

/** Start the installed service, if there is one. Resolves false when none is installed. */
export async function startService() {
  const os = platform();
  if (os === "linux" && (await exists(systemdUnit()))) { await run("systemctl", ["--user", "start", UNIT]); return true; }
  if (os === "darwin" && (await exists(launchdPlist()))) { await run("launchctl", ["kickstart", `gui/${process.getuid?.()}/${LABEL}`]); return true; }
  return false;
}

export async function serviceStatus() {
  const os = platform();
  if (os === "linux") {
    if (!(await exists(systemdUnit()))) return { installed: false };
    const state = await run("systemctl", ["--user", "is-active", UNIT]).then((r) => r.stdout.trim(), (e) => String(e.stdout ?? "inactive").trim());
    return { installed: true, manager: "systemd", state };
  }
  if (os === "darwin") return { installed: await exists(launchdPlist()), manager: "launchd" };
  return { installed: false };
}
