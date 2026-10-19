// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CONTRACT_VERSION, normalizeEvidenceRecord, normalizeLimit, normalizeScope,
  wikiEvidenceIdentity,
} from "./contracts.mjs";
import { EvidenceProviderError, providerError, runCancellable, unsupported } from "./errors.mjs";
import { bindImaEvidenceCache, createImaEvidenceCache } from "./ima-cache.mjs";
import { normalizeImaCandidates } from "./ima-candidates.mjs";
import { normalizeImaDirectoryLocation, normalizeImaDocumentSelections } from "./ima-directory.mjs";

const unavailable = (reason) => providerError("SOURCE_UNAVAILABLE", reason);
const forbidden = () => providerError("FORBIDDEN_SCOPE", "IMA_SCOPE_MISMATCH");
const plain = (value) => value && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const capabilities = Object.freeze({
  search: true, readFull: true, getEvidence: true, cancel: true,
  asOf: false, changes: false, getCard: false, listWiki: false, readWiki: false,
  timeBoundaries: Object.freeze(Object.fromEntries(
    ["search", "read", "getEvidence", "getCard", "listWiki", "readWiki", "changes"].map(key => [key, false]))),
});

function text(value, max = 2048, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max
    || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw unavailable("IMA_RESPONSE_INVALID");
  }
  return value;
}

function opaque(value, max = 512, empty = false) {
  const result = text(value, max, empty);
  if (result.trim() !== result) throw unavailable("IMA_RESPONSE_INVALID");
  return result;
}

function session(transport, budget) {
  if (typeof transport?.call !== "function" || typeof transport.downloadMarkdown !== "function"
    || typeof budget?.snapshot !== "function" || !(budget.signal instanceof AbortSignal)) {
    throw unavailable("IMA_PROVIDER_INVALID");
  }
  function active() {
    const { status } = budget.snapshot();
    if (status === "EXPIRED") throw unavailable("IMA_SESSION_TIMEOUT");
    if (status === "FAILED") throw unavailable("IMA_CLOCK_INVALID");
    if (status !== "ACTIVE" || budget.signal.aborted) throw providerError("CANCELLED");
  }
  return async (signal, operation) => {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw unavailable("INVALID_ARGUMENT");
    const checkpoint = () => {
      active();
      if (signal?.aborted) throw providerError("CANCELLED");
    };
    checkpoint();
    const combined = signal ? AbortSignal.any([budget.signal, signal]) : budget.signal;
    try {
      return await runCancellable(combined, async () => {
        checkpoint();
        const call = async (route, input) => {
          checkpoint();
          const value = await transport.call(route, input);
          checkpoint();
          return value;
        };
        const value = await operation(call, checkpoint);
        checkpoint();
        return value;
      });
    } catch (error) {
      active();
      throw error;
    }
  };
}

async function pages(call, operation, input, field, inspect, firstResponse) {
  let cursor = "";
  const seen = new Set(), rows = [];
  while (true) {
    const response = firstResponse !== undefined ? firstResponse : await call(operation, { ...input, cursor });
    firstResponse = undefined;
    if (!plain(response) || !Array.isArray(response[field])) {
      throw unavailable("IMA_PAGINATION_INVALID");
    }
    // The live content-search endpoint also returns a bounded snapshot without
    // pagination metadata. It establishes only observed hits, never exhaustion.
    // Do not apply this variant to catalogs or a truncated paginated response.
    if (operation === "search_knowledge" && cursor === ""
      && !Object.hasOwn(response, "is_end") && !Object.hasOwn(response, "next_cursor")) {
      inspect?.(response);
      return { rows: response[field], complete: false };
    }
    if (typeof response.is_end !== "boolean") throw unavailable("IMA_PAGINATION_INVALID");
    const next = opaque(response.next_cursor, 4096, true);
    inspect?.(response);
    rows.push(...response[field]);
    if (response.is_end) return { rows, complete: true };
    if (!next || seen.has(next)) throw unavailable("IMA_PAGINATION_INVALID");
    seen.add(next);
    cursor = next;
  }
}

function unique(rows, key) {
  const byId = new Map();
  for (const row of rows) {
    const previous = byId.get(row[key]);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
      throw unavailable("IMA_IDENTITY_AMBIGUOUS");
    }
    byId.set(row[key], row);
  }
  return [...byId.values()].sort((a, b) => order(a[key], b[key]));
}

function library(row) {
  if (!plain(row)) throw unavailable("IMA_RESPONSE_INVALID");
  const wire = Object.hasOwn(row, "kb_id") || Object.hasOwn(row, "kb_name");
  const legacy = Object.hasOwn(row, "id") || Object.hasOwn(row, "name");
  const value = wire
    ? { id: opaque(row.kb_id), name: text(row.kb_name) }
    : { id: opaque(row.id), name: text(row.name) };
  if (wire && legacy && (opaque(row.id) !== value.id || text(row.name) !== value.name)) {
    throw unavailable("IMA_RESPONSE_INVALID");
  }
  return value;
}

function descriptor(row) {
  if (!plain(row) || (row.media_id === undefined) === (row.folder_id === undefined)) {
    throw unavailable("IMA_RESPONSE_INVALID");
  }
  if (Object.hasOwn(row, "media_type") && (!Number.isSafeInteger(row.media_type) || row.media_type < 1)) {
    throw unavailable("IMA_RESPONSE_INVALID");
  }
  const parent = opaque(row.parent_folder_id);
  if (row.folder_id !== undefined) {
    if (row.media_type !== undefined && row.media_type !== 99) throw unavailable("IMA_RESPONSE_INVALID");
    return { folder_id: opaque(row.folder_id), name: text(row.name), parent_folder_id: parent };
  }
  if (row.media_type === 99) {
    return { folder_id: opaque(row.media_id), name: text(row.title), parent_folder_id: parent };
  }
  const title = text(row.title);
  if (row.highlight_content !== undefined && (typeof row.highlight_content !== "string"
    || !row.highlight_content.isWellFormed() || row.highlight_content.includes("\0"))) {
    throw unavailable("IMA_RESPONSE_INVALID");
  }
  return {
    media_id: opaque(row.media_id), title, parent_folder_id: parent,
    excerpt: row.highlight_content || title,
  };
}

export async function listImaKnowledgeBases({ transport, budget, query = "" } = {}, signal) {
  const execute = session(transport, budget);
  const input = opaque(query, 2048, true);
  return execute(signal, async call => unique(
    (await pages(call, "search_knowledge_base", { query: input, limit: 20 }, "info_list")).rows.map(library), "id"));
}

export function createImaEvidenceProvider({
  libraryId, transport, budget, modelUseAllowed = false, now = () => new Date().toISOString(),
  cache = createImaEvidenceCache({ budget }), selectedContentHashes = {}, selectedDocuments = [],
} = {}) {
  const execute = session(transport, budget);
  const selected = opaque(libraryId);
  const { datasetId } = wikiEvidenceIdentity({ provider: "ima", libraryId: selected, documentId: selected });
  if (typeof modelUseAllowed !== "boolean" || typeof now !== "function") throw unavailable("IMA_PROVIDER_INVALID");
  const datasets = Object.freeze([Object.freeze({ datasetId, capabilities })]);
  const contentCache = bindImaEvidenceCache(cache, { budget, transport, datasetId });
  const documentLocations = new Map(normalizeImaDocumentSelections(selectedDocuments, selected)
    .map(row => [row.evidenceId, row.location]));
  const selections = new Map();
  try {
    if (!plain(selectedContentHashes)) throw new Error();
    for (const [evidenceId, contentHash] of Object.entries(selectedContentHashes)) {
      mediaIdentity({ datasetId, evidenceId });
      if (typeof contentHash !== "string" || !/^[a-f0-9]{64}$/.test(contentHash)) throw new Error();
      selections.set(evidenceId, contentHash);
    }
  } catch { throw unavailable("IMA_CONTENT_SELECTION_INVALID"); }
  const cursors = new Map(), searchFolders = new Map();
  budget.signal.addEventListener("abort", () => { cursors.clear(); searchFolders.clear(); }, { once: true });

  function scope(query, search = false) {
    if (search) {
      const requested = normalizeScope(query?.scope);
      if (requested.datasetIds.length !== 1 || requested.datasetIds[0] !== datasetId) throw forbidden();
    } else if (query?.datasetId !== datasetId) throw forbidden();
    if (query.asOf !== undefined || query.knownAt !== undefined) {
      throw providerError("TIME_BOUNDARY", "IMA_HISTORY_UNAVAILABLE");
    }
  }

  function mediaIdentity(query) {
    scope(query);
    try {
      if (typeof query.evidenceId !== "string" || !query.evidenceId.startsWith(`${datasetId}:`)) throw new Error();
      const encoded = query.evidenceId.slice(datasetId.length + 1);
      const documentId = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url"));
      const identity = wikiEvidenceIdentity({ provider: "ima", libraryId: selected, documentId });
      if (identity.evidenceId !== query.evidenceId) throw new Error();
      return documentId;
    } catch { throw forbidden(); }
  }

  async function bind(call) {
    const result = await call("get_knowledge_base", { ids: [selected] });
    if (!plain(result?.infos) || !Object.hasOwn(result.infos, selected)) throw forbidden();
    const row = library(result.infos[selected]);
    if (row.id !== selected) throw forbidden();
  }

  function record(row, content) {
    const identity = wikiEvidenceIdentity({ provider: "ima", libraryId: selected, documentId: row.media_id });
    const observedAt = now();
    return normalizeEvidenceRecord({
      ...identity, datasetVersion: "UNKNOWN", sourceFamily: "wiki",
      eventAt: null, availableAt: null, recordedAt: observedAt, knownAt: observedAt,
      epistemicType: "UNKNOWN", excerpt: row.excerpt, exportAllowed: false, modelUseAllowed, license: null,
      contentHash: content?.normalizedTextHash ?? hash(row.excerpt),
      ...(content ? { content: content.text } : {}),
      wikiOrigin: {
        provider: "ima", libraryId: selected, documentId: row.media_id, title: row.title,
        observedAt, versionId: null, permission: "GRANTED", completeness: content ? "COMPLETE" : "PARTIAL",
        originalByteHash: content?.originalByteHash ?? null, normalizedTextHash: content?.normalizedTextHash ?? null,
        metadataSize: null, downloadedBytes: content?.downloadedBytes ?? null,
      },
    });
  }

  async function catalog(call, firstRootPage) {
    const folders = [[]], seen = new Set(), files = [];
    let root = selected, rootParent, withPaths;
    // Complete the scoped catalog before using the API's globally addressed media route.
    for (const ancestors of folders) {
      const folder = ancestors.at(-1);
      const rows = (await pages(call, "get_knowledge_list", {
        knowledge_base_id: selected, limit: 50, ...(folder === undefined ? {} : { folder_id: folder }),
      }, "knowledge_list", response => {
        const hasPath = Object.hasOwn(response, "current_path");
        withPaths ??= hasPath;
        if (withPaths !== hasPath) throw unavailable("IMA_CATALOG_INVALID");
        if (hasPath) {
          let path;
          try {
            if (!Array.isArray(response.current_path) || response.current_path.length !== ancestors.length + 1) {
              throw new Error();
            }
            path = response.current_path.map(row => {
              if (!plain(row)) throw new Error();
              return { id: opaque(row.folder_id), parent: opaque(row.parent_folder_id, 512, true) };
            });
          } catch { throw unavailable("IMA_CATALOG_INVALID"); }
          // The scoped root response supplies the root ID; never derive it from the library ID.
          if (!seen.size) { root = path[0].id; rootParent = path[0].parent; }
          const expected = [root, ...ancestors];
          if (path[0].parent !== rootParent || path.some((row, index) => row.id !== expected[index]
            || index > 0 && row.parent !== expected[index - 1])) throw unavailable("IMA_CATALOG_INVALID");
        }
        seen.add(root);
      }, ancestors.length === 0 ? firstRootPage : undefined)).rows.map(descriptor);
      for (const row of rows) {
        if (row.parent_folder_id !== (folder ?? root)) throw unavailable("IMA_CATALOG_INVALID");
        if (row.media_id !== undefined) files.push(row);
        else {
          if (seen.has(row.folder_id)) throw unavailable("IMA_CATALOG_INVALID");
          seen.add(row.folder_id);
          folders.push([...ancestors, row.folder_id]);
        }
      }
    }
    return unique(files, "media_id");
  }

  function parseDirectoryPage(response, folderPath, cursor) {
    if (!plain(response) || !Array.isArray(response.knowledge_list) || response.knowledge_list.length > 50
      || typeof response.is_end !== "boolean") throw unavailable("IMA_PAGINATION_INVALID");
    const next = opaque(response.next_cursor, 4096, true);
    if (!response.is_end && (!next || next === cursor)) throw unavailable("IMA_PAGINATION_INVALID");
    if (!Array.isArray(response.current_path) || response.current_path.length < 1 || response.current_path.length > 33
      || folderPath !== null && response.current_path.length !== folderPath.length + 1) {
      throw unavailable("IMA_CATALOG_INVALID");
    }
    let path;
    try {
      path = response.current_path.map(row => {
        if (!plain(row)) throw new Error();
        return { id: opaque(row.folder_id), parent: opaque(row.parent_folder_id, 512, true), name: text(row.name) };
      });
    } catch { throw unavailable("IMA_CATALOG_INVALID"); }
    if (new Set(path.map(row => row.id)).size !== path.length
      || path.some((row, index) => index > 0 && (folderPath !== null && row.id !== folderPath[index - 1]
        || row.parent !== path[index - 1].id))) throw unavailable("IMA_CATALOG_INVALID");
    const rows = response.knowledge_list.map(descriptor);
    if (rows.some(row => row.parent_folder_id !== path.at(-1).id
      || row.folder_id !== undefined && path.some(ancestor => ancestor.id === row.folder_id))) {
      throw unavailable("IMA_CATALOG_INVALID");
    }
    const files = unique(rows.filter(row => row.media_id !== undefined), "media_id");
    const folders = unique(rows.filter(row => row.folder_id !== undefined), "folder_id");
    if (folders.some(folder => files.some(file => file.media_id === folder.folder_id))) {
      throw unavailable("IMA_IDENTITY_AMBIGUOUS");
    }
    return { path, files, folders, next, end: response.is_end };
  }

  async function fetchDirectoryPage(call, folderPath, cursor, folderId) {
    return parseDirectoryPage(await call("get_knowledge_list", { knowledge_base_id: selected, limit: 50, cursor,
      ...(folderId !== undefined ? { folder_id: folderId }
        : folderPath.length ? { folder_id: folderPath.at(-1) } : {}) }), folderPath, cursor);
  }

  async function directoryPage(call, location) {
    // Even a persisted/caller-supplied page hint must bind to the current scoped root.
    const root = await fetchDirectoryPage(call, [], "");
    if (!location.folderPath.length && !location.cursor) return root;
    const result = await fetchDirectoryPage(call, location.folderPath, location.cursor);
    if (result.path[0].id !== root.path[0].id || result.path[0].parent !== root.path[0].parent) {
      throw unavailable("IMA_CATALOG_INVALID");
    }
    return result;
  }

  async function searchDirectoryRow(call, mediaId, folderId) {
    const first = await call("get_knowledge_list", { knowledge_base_id: selected, limit: 50, cursor: "" });
    // Legacy catalogs have no path proof. Preserve their complete scoped scan,
    // including its budget, without fetching the already observed root twice.
    if (plain(first) && !Object.hasOwn(first, "current_path")) {
      return (await catalog(call, first)).find(row => row.media_id === mediaId);
    }
    const root = parseDirectoryPage(first, [], "");
    let result = folderId === root.path[0].id ? root : await fetchDirectoryPage(call, null, "", folderId);
    if (result.path[0].id !== root.path[0].id || result.path[0].parent !== root.path[0].parent
      || result.path.at(-1).id !== folderId) throw unavailable("IMA_CATALOG_INVALID");
    const folderPath = result.path.slice(1).map(row => row.id), ancestry = result.path.map(({ id, parent }) => ({ id, parent }));
    const seen = new Set();
    while (true) {
      if (JSON.stringify(result.path.map(({ id, parent }) => ({ id, parent }))) !== JSON.stringify(ancestry)) {
        throw unavailable("IMA_CATALOG_INVALID");
      }
      const row = result.files.find(row => row.media_id === mediaId);
      if (row) return row;
      if (result.end) return undefined;
      if (seen.has(result.next)) throw unavailable("IMA_PAGINATION_INVALID");
      seen.add(result.next);
      result = await fetchDirectoryPage(call, folderPath, result.next);
    }
  }

  async function selectedRow(call, evidenceId) {
    const location = documentLocations.get(evidenceId);
    const mediaId = mediaIdentity({ datasetId, evidenceId });
    const row = location ? (await directoryPage(call, location)).files.find(value => value.media_id === mediaId)
      : searchFolders.has(evidenceId) ? await searchDirectoryRow(call, mediaId, searchFolders.get(evidenceId))
        : (await catalog(call)).find(value => value.media_id === mediaId);
    if (!row) throw providerError("NO_RESULT");
    return row;
  }

  function read(query, full, signal) {
    query = { ...query };
    return execute(signal, async (call, checkpoint) => {
      const mediaId = mediaIdentity(query);
      if (query.version !== undefined) throw unavailable("IMA_VERSION_UNAVAILABLE");
      if (full === "access" && Object.keys(query).some(key => !["datasetId", "evidenceId"].includes(key))) {
        throw unavailable("INVALID_ARGUMENT");
      }
      await bind(call);
      const row = await selectedRow(call, query.evidenceId);
      if (!full) return record(row);
      const info = await call("get_media_info", { media_id: mediaId });
      if (!plain(info)) throw unavailable("IMA_RESPONSE_INVALID");
      if (info.media_id !== undefined && info.media_id !== mediaId) throw forbidden();
      if (info.media_type !== 7) throw unavailable("IMA_FORMAT_UNSUPPORTED");
      if (!plain(info.url_info)) throw providerError("FORBIDDEN_SCOPE", "IMA_MEDIA_UNREADABLE");
      checkpoint();
      // Media metadata may invalidate a displayed result; it cannot prove the
      // current body, grant model use or replace a subsequent full read.
      if (full === "access") {
        if (typeof info.url_info.url !== "string" || !info.url_info.url.trim()) {
          throw unavailable("IMA_RESPONSE_INVALID");
        }
        return Object.freeze({
          datasetId, evidenceId: query.evidenceId, status: "METADATA_VISIBLE", contentVerified: false,
        });
      }
      const content = await transport.downloadMarkdown(info.url_info);
      checkpoint();
      const verified = record(row, content);
      return contentCache.accept(verified, selections.get(verified.evidenceId));
    }).catch(error => {
      if (error.code === "FORBIDDEN_SCOPE") contentCache.revoke();
      throw error;
    });
  }

  return Object.freeze({
    async capabilities() { return { ...capabilities, datasets }; },
    checkLibraryAccess(query, signal) {
      if (!plain(query) || Object.keys(query).some(key => key !== "scope")) throw unavailable("INVALID_ARGUMENT");
      query = { scope: { datasetIds: [...(query.scope?.datasetIds ?? [])] } };
      return execute(signal, async call => {
        scope(query, true);
        await bind(call);
        return { datasetId };
      });
    },
    browseDirectory(query, signal) {
      query = { ...query, scope: { datasetIds: [...(query?.scope?.datasetIds ?? [])] } };
      return execute(signal, async call => {
        scope(query, true);
        if (Object.keys(query).some(key => !["scope", "location"].includes(key))) throw unavailable("INVALID_ARGUMENT");
        const location = normalizeImaDirectoryLocation(query.location);
        await bind(call);
        const page = await directoryPage(call, location);
        return {
          schema: "ima-directory-page-v1", datasetId, location, complete: false, directoryComplete: page.end,
          path: page.path.map(({ id, name }) => ({ id, name })),
          folders: page.folders.map(row => ({ id: row.folder_id, name: row.name,
            location: { folderPath: [...location.folderPath, row.folder_id], cursor: "" } })),
          documents: page.files.map(row => ({
            ...wikiEvidenceIdentity({ provider: "ima", libraryId: selected, documentId: row.media_id }),
            title: row.title, location,
          })),
          nextLocation: page.end ? null : { folderPath: [...location.folderPath], cursor: page.next },
        };
      });
    },
    listCardCandidates(query, signal) {
      query = { ...query, scope: { datasetIds: [...(query?.scope?.datasetIds ?? [])] } };
      return execute(signal, async call => {
        scope(query, true);
        if (Object.keys(query).some(key => key !== "scope")) throw unavailable("INVALID_ARGUMENT");
        await bind(call);
        const rows = documentLocations.size ? [] : await catalog(call);
        for (const evidenceId of documentLocations.keys()) rows.push(await selectedRow(call, evidenceId));
        return normalizeImaCandidates({
          schema: "ima-candidate-intake-v1",
          coverage: documentLocations.size ? "SELECTED_IMA_METADATA" : "CURRENT_IMA_METADATA",
          scope: normalizeScope(query.scope), observedAt: now(), complete: true,
          asOf: null, knownAt: null, version: null, modelUseAllowed: false, exportAllowed: false,
          records: rows.map(row => ({
            ...wikiEvidenceIdentity({ provider: "ima", libraryId: selected, documentId: row.media_id }),
            title: row.title,
          })),
        });
      });
    },
    search(query, signal) {
      query = { ...query, scope: { datasetIds: [...(query?.scope?.datasetIds ?? [])] } };
      return execute(signal, async call => {
        const started = performance.now();
        scope(query, true);
        const requested = normalizeScope(query.scope);
        const needle = opaque(query.query, 2048), limit = normalizeLimit(query.limit);
        const requestHash = hash(JSON.stringify({ query: needle, scope: requested, limit }));
        const previous = query.cursor === undefined ? undefined : cursors.get(query.cursor);
        if (query.cursor !== undefined && (!previous || previous.requestHash !== requestHash)) {
          throw unavailable("CURSOR_INVALID_OR_STALE");
        }
        await bind(call);
        const snapshot = await pages(call, "search_knowledge", {
          query: needle, knowledge_base_id: selected,
        }, "info_list");
        const rows = unique(snapshot.rows.map(descriptor).filter(row => row.media_id !== undefined), "media_id");
        const fingerprint = hash(JSON.stringify({ rows, complete: snapshot.complete }));
        if (previous && previous.fingerprint !== fingerprint) throw unavailable("CURSOR_INVALID_OR_STALE");
        const hits = previous?.hits ?? rows.map(row => ({ ...record(row), mirrors: [] }));
        const offset = previous?.offset ?? 0, items = hits.slice(offset, offset + limit);
        const byMediaId = new Map(rows.map(row => [row.media_id, row]));
        // Navigation hints never authorize a media read: selectedRow verifies
        // the current scoped root, ancestry and directory membership each time.
        for (const hit of items) searchFolders.set(hit.evidenceId,
          byMediaId.get(mediaIdentity({ datasetId: hit.datasetId, evidenceId: hit.evidenceId })).parent_folder_id);
        let nextCursor;
        if (offset + items.length < hits.length) {
          nextCursor = randomUUID();
          cursors.set(nextCursor, { requestHash, fingerprint, hits, offset: offset + items.length });
        }
        const receipt = {
          schema: CONTRACT_VERSION, provider: "ima", query: needle, scope: requested,
          datasetVersions: [{ datasetId, version: "UNKNOWN" }], datasetCapabilities: datasets,
          asOf: null, knownAt: null, hitCount: items.length, totalHits: hits.length,
          durationMs: performance.now() - started, dataAge: null, rateRemaining: null,
          complete: snapshot.complete, timeBoundary: "UNBOUNDED", excluded: { future: 0, mirrors: 0, withdrawn: 0 },
        };
        if (!hits.length) throw new EvidenceProviderError("NO_RESULT", { receipt });
        return { hits: structuredClone(items), ...(nextCursor ? { nextCursor } : {}), receipt };
      });
    },
    read(id, version, signal) { return read({ ...id, version }, true, signal); },
    getEvidence(query, signal) { return read(query, false, signal); },
    checkReadAccess(query, signal) { return read(query, "access", signal); },
    ...Object.fromEntries(["getCard", "listWiki", "readWiki", "changes"].map(operation => [
      operation, (query, signal) => execute(signal, () => { scope(query); throw unsupported(operation); }),
    ])),
  });
}
