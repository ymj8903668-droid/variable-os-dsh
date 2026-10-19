// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync,
  fsyncSync, renameSync, unlinkSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { readRemoteConfig, remoteError } from "./config.js";
import { createPrivateJsonProfile } from "../../../dsh-desk-ui/lib/private-json-profile.js";

const invalid = () => remoteError("SOURCE_CONFIG_INVALID");
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fallbackEnvironment = env => env.VARIABLE_OS_SOURCE_SETTINGS_FILE
  ? { VARIABLE_OS_PROVIDER: env.VARIABLE_OS_PROVIDER ?? "remote" } : env;

export function sourceSettingsPath(env) {
  const file = env.VARIABLE_OS_SOURCE_SETTINGS_FILE
    || (env.DSH_HOME ? path.join(env.DSH_HOME, "variable-os", "source-connection.json") : null);
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0"))) throw invalid();
  return file;
}

function selectedEnvironment(value) {
  if (!plain(value) || Object.keys(value).some(key => ![
    "ownership", "endpoint", "token", "spki", "caCertificate",
  ].includes(key)) || !["provided", "self"].includes(value.ownership)) throw invalid();
  const env = {
    VARIABLE_OS_PROVIDER: "remote", VARIABLE_OS_EDGE_URL: value.endpoint,
    VARIABLE_OS_EDGE_TOKEN: value.token, VARIABLE_OS_EDGE_SPKI: value.spki,
    ...(value.caCertificate ? { VARIABLE_OS_EDGE_CA_PEM: value.caCertificate } : {}),
  };
  if (value.caCertificate !== undefined && typeof value.caCertificate !== "string") throw invalid();
  const config = readRemoteConfig(env);
  if (config.code) throw remoteError(config.code);
  return env;
}

function privateFile(stat) {
  return stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

function sourceRecord(value) {
  if (!plain(value) || Object.keys(value).some(key => !["schema", "connection", "revision"].includes(key))
    || value.schema !== 1 || Object.hasOwn(value, "revision") &&
      (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision))) throw invalid();
  if (value.connection === null) {
    if (!value.revision) throw invalid();
  } else selectedEnvironment(value.connection);
  return value;
}

function windowsProfile(file) {
  const absent = Object.freeze({ revision: randomBytes(32).toString("hex") });
  const profile = createPrivateJsonProfile({
    file, initial: () => absent, validate: value => Boolean(sourceRecord(value)),
    maxBytes: 131072, temporaryPrefix: ".source-",
    errors: { invalid: "SOURCE_CONFIG_INVALID", unavailable: "SOURCE_CONFIG_INVALID",
      write: "SOURCE_CONFIG_WRITE_FAILED", busy: "SOURCE_CONFIG_WRITE_FAILED", changed: "SOURCE_CONFIG_WRITE_FAILED" },
  });
  return {
    read() { const { record } = profile.current(); return record === absent ? null : record; },
    write(record) { return profile.write(record, profile.current()); },
  };
}

function load(file) {
  if (!file) return null;
  if (process.platform === "win32") return windowsProfile(file).read();
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!privateFile(stat) || stat.size > 131072) throw invalid();
    return sourceRecord(JSON.parse(readFileSync(fd, "utf8")));
  } catch (error) {
    if (fd === undefined && error.code === "ENOENT") return null;
    throw invalid();
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readSourceEnvironment(env) {
  return recordEnvironment(load(sourceSettingsPath(env)), env);
}

function recordEnvironment(selected, env) {
  if (!selected) return fallbackEnvironment(env);
  // A removal is durable intent, including for legacy DSH_HOME profiles.
  if (selected.connection === null) return { VARIABLE_OS_PROVIDER: "remote" };
  // Do not retain an old endpoint's CA, token or pin when switching sources.
  return selectedEnvironment(selected.connection);
}

function save(file, record) {
  if (process.platform === "win32") {
    try { windowsProfile(file).write(record); return; }
    catch { throw remoteError("SOURCE_CONFIG_WRITE_FAILED"); }
  }
  const directory = path.dirname(file);
  let temporary, fd;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && parent.uid !== process.getuid())) throw invalid();
    load(file);
    temporary = path.join(directory, `.source-${randomBytes(16).toString("hex")}`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(record) + "\n");
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file); temporary = undefined;
  } catch { throw remoteError("SOURCE_CONFIG_WRITE_FAILED"); }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary) { try { unlinkSync(temporary); } catch {} }
  }
}

export function createSourceSettings({ env = {}, now = () => new Date().toISOString() } = {}) {
  env = { ...env };
  const file = sourceSettingsPath(env);
  let memory = null, checkedRevision = null, connection = "NOT_CHECKED", checkedAt = null;
  const selected = () => file ? load(file) : memory;
  const resolveEnv = () => recordEnvironment(selected(), env);
  const recordRevision = choice => {
    const source = recordEnvironment(choice, env);
    return fingerprint(choice?.revision ? { source, revision: choice.revision } : source);
  };
  const revision = () => recordRevision(selected());
  // Internal transport capture: one fully checked record supplies both the
  // credential and its fence. Callers must recheck revision after awaiting IO.
  const capture = () => {
    const choice = selected(), source = recordEnvironment(choice, env);
    return Object.freeze({ env: Object.freeze({ ...source }), revision: recordRevision(choice),
      fromProfile: source !== env });
  };
  function snapshot() {
    const choice = selected(), config = readRemoteConfig(recordEnvironment(choice, env));
    const current = recordRevision(choice);
    return Object.freeze({
      ...config.public, endpoint: config.url?.origin ?? null,
      ownership: choice?.connection?.ownership ?? "self", revision: current,
      connection: checkedRevision === current ? connection : "NOT_CHECKED",
      checkedAt: checkedRevision === current ? checkedAt : null,
      persistence: file ? "HOST_FILE" : "SESSION_ONLY", modelUseAllowed: false,
      mcp: Object.freeze({ transport: "stdio", contract: "variable-os-edge-readonly", profileShared: Boolean(file && choice?.connection) }),
    });
  }
  return Object.freeze({
    resolveEnv, revision, snapshot, capture,
    configure(value) {
      const next = selectedEnvironment(value);
      const config = readRemoteConfig(next);
      const choice = {
        ownership: value.ownership, endpoint: config.url.origin,
        token: config.token, spki: config.pin,
        ...(config.ca ? { caCertificate: config.ca.toString() } : {}),
      };
      // A save is a new source intent even when credentials are restored.
      const record = { schema: 1, revision: randomBytes(32).toString("hex"), connection: choice };
      if (file) save(file, record); else memory = Object.freeze(record);
      checkedRevision = null; checkedAt = null; connection = "NOT_CHECKED";
      return snapshot();
    },
    remove(params) {
      if (!plain(params) || Object.keys(params).length !== 1 || typeof params.revision !== "string"
        || !/^[a-f0-9]{64}$/.test(params.revision)) throw remoteError("INVALID_REQUEST");
      if (params.revision !== revision()) throw remoteError("SOURCE_CHANGED");
      const record = { schema: 1, revision: randomBytes(32).toString("hex"), connection: null };
      if (file) save(file, record); else memory = Object.freeze(record);
      checkedRevision = null; checkedAt = null; connection = "NOT_CHECKED";
      return snapshot();
    },
    async check(provider, options) {
      const version = revision();
      checkedRevision = version; checkedAt = null; connection = "CHECKING";
      try {
        await provider.call("datasets", {}, options);
        if (revision() !== version || options?.signal?.aborted) throw remoteError("CANCELLED");
        connection = "CONNECTED"; checkedAt = now();
        return snapshot();
      } catch (error) {
        if (revision() === version) { connection = "FAILED"; checkedAt = null; }
        throw error;
      }
    },
  });
}
