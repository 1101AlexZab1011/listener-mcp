// @ts-check
// Per-project settings, kept in `.listener-mcp.json` at the project root. The
// file holds no secrets: `credential` names a token saved in the user's
// config directory, so the file can be committed.
//
//   {
//     "version": 1,
//     "credential": "email-agent",
//     "attach": { "group": "mail-chat", "channels": ["mail/chat/**"], "from": "earliest" },
//     "auto_attach": false
//   }
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const PROJECT_FILE = ".listener-mcp.json";

export async function findProject(start = process.cwd()) {
  let directory = resolve(start);
  for (;;) {
    const path = join(directory, PROJECT_FILE);
    try {
      const config = JSON.parse(await readFile(path, "utf8"));
      if (config.version !== 1) throw new Error(`${path}: unsupported version ${config.version}`);
      return { root: directory, path, config };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function writeProject(root, config) {
  const path = join(root, PROJECT_FILE);
  await writeFile(path, `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`);
  return path;
}
