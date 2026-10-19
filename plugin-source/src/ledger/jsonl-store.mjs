// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "../schema/canonical-json.mjs";
import { validatePrivateWindowsMode } from "../runtime/windows-private-files.mjs";

export class LedgerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.details = details;
  }
}

const LEDGERS = Object.freeze({
  events: "events.jsonl",
  source_items: "source_items.jsonl",
});
const POSTGRES_CUTOVER_FREEZE = "postgres-cutover-freeze.json";

function decodeRows(buf) {
  if (buf.length === 0) {
    return [];
  }
  const parts = buf.toString("utf8").split("\n");
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  const rows = [];
  for (const line of parts) {
    if (line === "") {
      throw new LedgerError("JSONL_CORRUPT", "empty line");
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new LedgerError("JSONL_CORRUPT", "invalid json");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new LedgerError("JSONL_CORRUPT", "non-object line");
    }
    rows.push(parsed);
  }
  return rows;
}

export class JsonlStore {
  constructor({ root, lockTimeoutMs = 2000, privateWindows = false, privateInspectionSession = false }) {
    if (typeof privateInspectionSession !== "boolean" || privateInspectionSession && !privateWindows) {
      throw new LedgerError("WINDOWS_PRIVATE_MODE_INVALID", "private inspection sessions require private Windows mode");
    }
    validatePrivateWindowsMode(privateWindows);
    this.root = root;
    this.privateWindows = privateWindows;
    this.privateInspectionSession = privateInspectionSession;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockDir = path.join(root, ".write-lock");
    this._chain = Promise.resolve();
    this._fileLockHeld = false;
    this._privateLockIdentity = null;
    this._inspectionSession = null;
  }

  filePath(name) {
    const file = LEDGERS[name];
    if (!file) {
      throw new LedgerError("UNKNOWN_LEDGER", `unknown ledger ${name}`);
    }
    return path.join(this.root, file);
  }

  async readFileBytes(name) {
    try {
      if (this.privateWindows) {
        const { openPrivateLedgerFile } = await import("./windows-private-ledger.mjs");
        const handle = await openPrivateLedgerFile(this.filePath(name));
        if (!handle) return Buffer.alloc(0);
        try { return await handle.readFile(); } finally { await handle.close(); }
      }
      return await fs.readFile(this.filePath(name));
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return Buffer.alloc(0);
      }
      throw err;
    }
  }

  async readRevision() {
    if (this.privateWindows) {
      const { inspectPrivateLedger } = await import("./windows-private-ledger.mjs");
      inspectPrivateLedger(this.root);
    }
    const fileRevision = async (name) => {
      try {
        const stat = await fs.stat(this.filePath(name), { bigint: true });
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
          .map((value) => value.toString())
          .join(":");
      } catch (err) {
        if (err && err.code === "ENOENT") return "missing";
        throw err;
      }
    };
    const [events, sourceItems] = await Promise.all([
      fileRevision("events"),
      fileRevision("source_items"),
    ]);
    return `jsonl-v1:${path.resolve(this.root)}:${events}:${sourceItems}`;
  }

  async readAll(name) {
    return decodeRows(await this.readFileBytes(name));
  }

  async readLockedStreams() {
    if (!this._fileLockHeld) {
      throw new LedgerError("LOCK_REQUIRED", "paired ledger reads require the writer lock");
    }
    if (!this.privateWindows) {
      return { events: await this.readAll("events"), sourceItems: await this.readAll("source_items") };
    }
    const { readPrivateLedgerStreams } = await import("./windows-private-ledger.mjs");
    const { events, sourceItems } = await readPrivateLedgerStreams(this.root,
      { lock: this.lockDir, lockIdentity: this._privateLockIdentity, inspectionSession: this._inspectionSession });
    return { events: decodeRows(events), sourceItems: decodeRows(sourceItems) };
  }

  async append(name, record) {
    if (!this._fileLockHeld) {
      return this.withLock(() => this.append(name, record));
    }
    if (!this.privateWindows) await fs.mkdir(this.root, { recursive: true });
    const line = `${canonicalize(record)}\n`;
    let handle;
    if (this.privateWindows) {
      const { openPrivateLedgerFile } = await import("./windows-private-ledger.mjs");
      handle = await openPrivateLedgerFile(this.filePath(name), { append: true,
        lock: this.lockDir, lockIdentity: this._privateLockIdentity, inspectionSession: this._inspectionSession });
    } else handle = await fs.open(this.filePath(name), "a");
    let failed = false;
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try { await handle.close(); }
      catch (error) { if (!failed) throw error; }
    }
  }

  withLock(fn) {
    const run = this._chain.then(() => this._withFileLock(fn));
    this._chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async _withFileLock(fn) {
    const started = Date.now();
    const privateLedger = this.privateWindows ? await import("./windows-private-ledger.mjs") : null;
    if (privateLedger) privateLedger.inspectPrivateLedger(this.root);
    else await fs.mkdir(this.root, { recursive: true });
    while (true) {
      try {
        if (privateLedger) this._privateLockIdentity = privateLedger.createPrivateDirectoryExclusive(this.lockDir);
        else await fs.mkdir(this.lockDir);
        this._fileLockHeld = true;
        break;
      } catch (err) {
        if (!err || err.code !== "EEXIST") {
          throw err;
        }
        try {
          await fs.lstat(path.join(this.lockDir, POSTGRES_CUTOVER_FREEZE));
          throw new LedgerError("AUTHORITY_FROZEN", "JSONL authority is frozen");
        } catch (markerError) {
          if (markerError instanceof LedgerError) {
            throw markerError;
          }
          if (!markerError || markerError.code !== "ENOENT") {
            throw markerError;
          }
        }
        if (Date.now() - started >= this.lockTimeoutMs) {
          throw new LedgerError("LOCK_TIMEOUT", "write lock held");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (this.privateInspectionSession) return this._runWithPrivateInspection(fn, privateLedger);
    try {
      return await fn();
    } finally {
      this._fileLockHeld = false;
      if (privateLedger) {
        const identity = this._privateLockIdentity;
        this._privateLockIdentity = null;
        privateLedger.releasePrivateLock(this.lockDir, identity);
      } else await fs.rm(this.lockDir, { recursive: true, force: true });
    }
  }

  async _runWithPrivateInspection(fn, privateLedger) {
    let session, result, failure, failed = false;
    const remember = error => { if (!failed) { failed = true; failure = error; } };
    try {
      const { createWindowsPrivateInspectionSession } = await import(
        "../../packages/dsh-desk-ui/lib/windows-private-inspection-session.js");
      session = createWindowsPrivateInspectionSession({
        root: this.root, lock: this.lockDir, lockIdentity: this._privateLockIdentity,
      });
      this._inspectionSession = session;
      result = await fn();
    } catch (error) { remember(error); }
    try { await session?.close(); } catch (error) { remember(error); }
    this._inspectionSession = null;
    this._fileLockHeld = false;
    const identity = this._privateLockIdentity;
    this._privateLockIdentity = null;
    // Unconfirmed child termination leaves the lock in place, never taken over.
    if (!session || session.closed) {
      try { privateLedger.releasePrivateLock(this.lockDir, identity); } catch (error) { remember(error); }
    } else remember(new LedgerError("WINDOWS_PRIVATE_INSPECTION_CLOSE_UNCONFIRMED", "inspection child close unconfirmed"));
    if (failed) throw failure;
    return result;
  }
}
