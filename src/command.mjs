// @ts-check
// Run a program found on PATH. On Windows npm installs CLIs as .cmd shims,
// which Node only starts through cmd.exe, so the arguments are quoted for cmd
// (twice: once for cmd itself, once for the shim that passes them on), the way
// cross-spawn does it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

const META = /([()\][%!^"`<>&|;, *?])/g;

/** @param {string} arg */
export function cmdArgument(arg, shim = true) {
  let quoted = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  quoted = quoted.replace(META, "^$1");
  return shim ? quoted.replace(META, "^$1") : quoted;
}

/** The file a command name resolves to on Windows (PATH × PATHEXT), or null. */
export function whichWindows(name, env = process.env) {
  if (extname(name) && existsSync(name)) return name;
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of extname(name) ? [""] : exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * execFileSync that also starts .cmd/.bat programs on Windows.
 * @param {string} name
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
export function runSync(name, args, options = {}) {
  if (process.platform !== "win32") return execFileSync(name, args, options);
  const file = whichWindows(name, options.env ?? process.env) ?? name;
  if (!/\.(cmd|bat)$/i.test(file)) return execFileSync(file, args, options);
  const line = [cmdArgument(file, false), ...args.map((arg) => cmdArgument(arg))].join(" ");
  return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true });
}
