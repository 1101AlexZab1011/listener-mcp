// @ts-check
// Files apps hand to agents (screenshots, attachments). Events stay small JSON;
// a blob is uploaded once and referenced by id and by its local path, which a
// local agent can read directly.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { errors, newId } from "../protocol.mjs";

const safeName = (name) => String(name ?? "blob").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(-100) || "blob";
const mimeType = /^[a-z0-9]+\/[a-z0-9.+-]+$/i;

// Types a browser could execute are served as downloads, never rendered.
const inlineTypes = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain|text\/csv|text\/markdown|application\/json|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;

export class BlobStore {
  constructor({ root, store, maxBytes, clock = Date.now }) {
    this.root = resolve(root);
    this.store = store;
    this.maxBytes = maxBytes;
    this.now = clock;
  }

  async save(request, { name, type, principal }) {
    const id = newId("blob");
    const cleanType = typeof type === "string" && mimeType.test(type) ? type.toLowerCase() : "application/octet-stream";
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const directory = join(this.root, day);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}-${safeName(name)}`);
    let size = 0;
    const limit = this.maxBytes;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > limit) return callback(errors.tooLarge(`Blob exceeds ${limit} bytes`));
        callback(null, chunk);
      },
    });
    try { await pipeline(request, counter, createWriteStream(path, { mode: 0o600 })); }
    catch (error) { await rm(path, { force: true }); throw error; }
    if (!size) { await rm(path, { force: true }); throw errors.badRequest("Blob is empty"); }
    const blob = { id, path, name: safeName(name), type: cleanType, size, token_id: principal.id, created_at: this.now() };
    this.store.insertBlob(blob);
    return this.describe(blob);
  }

  describe(blob) {
    return { id: blob.id, name: blob.name, type: blob.type, size: blob.size, path: blob.path, url: `/v1/blobs/${blob.id}`, created_at: new Date(blob.created_at).toISOString() };
  }

  async serve(id, response, extraHeaders) {
    const blob = this.store.blob(String(id));
    if (!blob) throw errors.notFound("No such blob");
    const info = await stat(blob.path).catch(() => null);
    if (!info) throw errors.notFound("The blob's file is gone");
    const inline = inlineTypes.test(blob.type);
    response.writeHead(200, {
      ...extraHeaders,
      "content-type": inline ? blob.type : "application/octet-stream",
      "content-length": info.size,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${blob.name}"`,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    });
    await pipeline(createReadStream(blob.path), response);
  }

  async prune(before) {
    for (const blob of this.store.oldBlobs(before)) {
      await rm(String(blob.path), { force: true });
      this.store.deleteBlob(blob.id);
    }
  }
}
