/** @jsxRuntime classic */
/** @jsx RemoteReact.createElement */
/** @jsxFrag RemoteReact.Fragment */
// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import * as RemoteReact from "react";
import { DeskIcon } from "./icons";
import { createRemoteSession } from "./remote-session.mjs";
import { remoteStyles } from "./remote-styles.mjs";
import { readRemoteStream, resyncRemote } from "./remote-stream.mjs";
import { WikiSourceSettings } from "./wiki-source-settings";
import { SourceConnectionSettings } from "./source-connection-settings";
import { personalConnection } from "./personal-connection.mjs";
import { wikiSourceMonitor } from "./wiki-source-monitor.mjs";
import { invalidateIndependentResearch } from "./independent-research-events.mjs";
import { isModelReadiness } from "./model-readiness.mjs";
import { isWebReadiness, isWebServiceSettings } from "./web-readiness.mjs";
const { useEffect, useMemo, useRef, useState } = RemoteReact;

let bootstrapPromise: Promise<any> | null = null;
let csrf = "";
let modelSettingsProblem = "";
let modelSettingsGeneration = 0;
export const modelSettingsIssue = () => modelSettingsProblem;
let voiceSettingsProblem = "";
export const voiceSettingsIssue = () => voiceSettingsProblem;
let sourceSettingsProblem = "";
let sourceSettingsGeneration = 0;
let webSettingsGeneration = 0;
let webServiceGeneration = 0, webServiceWrites = 0;
let webServiceProblem = "";
export const webServiceIssue = () => webServiceProblem;
export const sourceSettingsIssue = () => sourceSettingsProblem;
let preferredModelProvider = "";
export const modelSettingsProvider = () => preferredModelProvider;
let overlayOpen = false;
const overlayListeners = new Set<(open: boolean) => void>();
function setOverlayOpen(open: boolean) {
  overlayOpen = open;
  for (const listener of overlayListeners) listener(open);
}

export function RemoteOverlay({ initial }: any) {
  const [open, setOpen] = useState(overlayOpen);
  const dialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    overlayListeners.add(setOpen);
    setOpen(overlayOpen);
    return () => { overlayListeners.delete(setOpen); };
  }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return <><style>{remoteStyles}</style>
    <dialog ref={dialog} className="remote-dialog" aria-label="Remote research"
      onCancel={() => setOverlayOpen(false)} onClose={() => setOverlayOpen(false)}>
      <div className="vos-remote remote-dialog-actions">
        <button type="button" aria-label="Close remote research" title="Close remote research"
          onClick={() => setOverlayOpen(false)}><DeskIcon name="close" /></button>
      </div>
      {open ? <RemoteDesk initial={initial} /> : null}
    </dialog></>;
}

const codeOf = (value: any) => /^[A-Z_]{2,64}$/.test(value || "") ? value : "SOURCE_UNAVAILABLE";
function isModelSettingsSnapshot(value: any) {
  const object = (row: any) => row && typeof row === "object" && !Array.isArray(row);
  const id = (text: any) => typeof text === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(text);
  const label = (text: any) => typeof text === "string" && text.length <= 160 && !/[\x00-\x1f]/.test(text);
  const flags = (row: any, keys: string[]) => object(row) && keys.every(key => typeof row[key] === "boolean");
  const custom = value?.customRoute, selected = value?.selection;
  return flags(value, ["available", "writable"]) && typeof value.revision === "string"
    && /^[a-f0-9]{64}$/.test(value.revision)
    && value.connection === "NOT_CHECKED" && Array.isArray(value.providers)
    && (value.readiness === undefined || isModelReadiness(value.readiness))
    && value.providers.every((row: any) => flags(row, ["credentialConfigured", "credentialWritable"])
      && id(row.provider) && label(row.name) && Array.isArray(row.models)
      && row.models.every((model: any) => object(model) && id(model.id) && label(model.name)))
    && (selected === null || object(selected) && id(selected.provider) && id(selected.model)
      && (selected.reasoningEffort === undefined || id(selected.reasoningEffort)))
    && flags(custom, ["available", "configured", "managed", "credentialConfigured", "allowLoopbackHttp"])
    && typeof custom.endpoint === "string" && custom.endpoint.length <= 2048
    && ["openai-completions", "openai-responses", "anthropic-messages"].includes(custom.protocol)
    && (custom.model === "" || id(custom.model));
}
function isSourceSettingsSnapshot(value: any) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision)
    && ["ready", "urlConfigured", "tokenConfigured", "pinConfigured"].every(key => typeof value[key] === "boolean")
    && (value.endpoint === null || typeof value.endpoint === "string")
    && ["self", "provided"].includes(value.ownership)
    && ["HOST_FILE", "SESSION_ONLY"].includes(value.persistence)
    && ["NOT_CHECKED", "CHECKING", "CONNECTED", "FAILED"].includes(value.connection)
    && (value.checkedAt === null || typeof value.checkedAt === "string")
    && value.modelUseAllowed === false && typeof value.mcp?.profileShared === "boolean";
}
export function isVoiceSettingsSnapshot(value: any) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 5
    && ["available", "configured", "writable"].every(key => typeof value[key] === "boolean")
    && (value.available || !value.configured && !value.writable)
    && value.connection === "NOT_CHECKED" && typeof value.revision === "string"
    && /^[a-f0-9]{64}$/.test(value.revision);
}
export async function remoteRpc(method: string, params: any = {}, options: any = {}) {
  if (["modelServiceCredentials", "modelServiceSelect", "modelServiceRoute", "wikiSourceConfigure",
    "wikiSourceCredentials", "webServiceConfigure", "webServiceRemove", "sourceConnectionConfigure",
    "sourceConnectionRemove"].includes(method)) invalidateIndependentResearch();
  const sourceGeneration = sourceSettingsGeneration;
  const sourceScope = personalConnection.settingsScopeKey();
  const webGeneration = webSettingsGeneration;
  const serviceGeneration = webServiceGeneration;
  const webWrite = ["webServiceConfigure", "webServiceRemove"].includes(method);
  if (method === "webServiceStatus" && webServiceWrites) throw Object.assign(Error("Web settings busy"), { code: "CLIENT_BUSY" });
  if (method === "webResearchCheck") webSettingsGeneration++;
  const modelGeneration = modelSettingsGeneration;
  const modelWrite = ["modelServiceCredentials", "modelServiceSelect", "modelServiceRoute"].includes(method);
  const voiceWrite = method === "voiceServiceCredentials";
  const sourceRemove = method === "sourceConnectionRemove";
  const uncertainRemoval = (code = "SOURCE_CONFIG_RECHECK_REQUIRED") => {
    sourceSettingsProblem = code;
    sourceSettingsGeneration++;
    return Object.assign(Error("Source removal requires recheck"), { code });
  };
  const uncertainVoice = (code = "VOICE_SETTINGS_RECHECK_REQUIRED") => {
    voiceSettingsProblem = code;
    personalConnection.invalidate();
    return Object.assign(Error("Voice configuration requires recheck"), { code });
  };
  const uncertainWeb = (code = "WEB_SERVICE_RECHECK_REQUIRED") => {
    webServiceProblem = code;
    personalConnection.invalidate({ keepSelection: true, preserveSettings: true });
    return Object.assign(Error("Web configuration requires recheck"), { code });
  };
  const uncertainWrite = (code = "MODEL_SETTINGS_RECHECK_REQUIRED") => {
    modelSettingsProblem = code;
    modelSettingsGeneration++;
    preferredModelProvider = "";
    personalConnection.invalidate();
    return Object.assign(Error("Model configuration requires recheck"), { code });
  };
  if ((modelWrite || voiceWrite || sourceRemove || webWrite) && options.signal?.aborted) throw Object.assign(Error("Request cancelled"), { code: "CANCELLED" });
  if (modelWrite) modelSettingsGeneration++;
  if (webWrite) { webServiceGeneration++; webServiceWrites++; webSettingsGeneration++; }
  const wikiSourceRevision = method === "deepResearch"
    ? wikiSourceMonitor.researchRevision(options.wikiSourceRevision) : null;
  const requestBody = JSON.stringify({ method, params });
  let body: any;
  try {
    const response = await fetch("/variable-os-desk/rpc", {
      method: "POST", cache: "no-store", credentials: "same-origin", signal: options.signal,
      headers: { "content-type": "application/json", ...(csrf ? { "x-variable-os-csrf": csrf } : {}),
        ...(wikiSourceRevision ? { "x-variable-os-wiki-revision": wikiSourceRevision } : {}) },
      body: requestBody,
    });
    body = await response.json();
  } catch (error) {
    if (modelWrite) throw uncertainWrite();
    if (voiceWrite) throw uncertainVoice();
    if (sourceRemove) throw uncertainRemoval();
    if (webWrite) throw uncertainWeb();
    throw error;
  } finally {
    // Reads begun while a write was pending also belong to its old generation.
    if (modelWrite) modelSettingsGeneration++;
    if (method === "webResearchCheck") webSettingsGeneration++;
    if (webWrite) {
      webServiceGeneration++; webServiceWrites--; webSettingsGeneration++;
      personalConnection.invalidate({ keepSelection: true, preserveSettings: true });
    }
    // A sent removal may have committed even when its reply is lost.
    if (sourceRemove) { bootstrapPromise = null; personalConnection.invalidate(); }
    if (method === "webResearchCheck" && sourceScope === personalConnection.settingsScopeKey()) {
      personalConnection.invalidate({ keepSelection: true, preserveSettings: true });
    }
  }
  if (webWrite || method === "webServiceStatus") {
    if (sourceScope !== personalConnection.settingsScopeKey()) {
      if (webWrite) throw uncertainWeb();
      throw Object.assign(Error("Source changed"), { code: "SOURCE_CHANGED" });
    }
    if (webServiceGeneration !== serviceGeneration + (webWrite ? 2 : 0)) {
      if (webWrite) throw uncertainWeb();
      throw Object.assign(Error("Web settings changed"), { code: "WEB_STATUS_CHANGED" });
    }
    if (typeof body?.ok !== "boolean" || body.ok && (!isWebServiceSettings(body.result) ||
      webWrite && (body.result.revision === params.revision ||
        method === "webServiceRemove" && (body.result.mode !== "off" || body.result.configured) ||
        method === "webServiceConfigure" && (body.result.mode !== params.mode ||
          params.apiKey === null && body.result.configured ||
          typeof params.apiKey === "string" && !body.result.configured)))) {
      if (webWrite) throw uncertainWeb();
      throw Object.assign(Error("Invalid web settings"), { code: "RESPONSE_INVALID" });
    }
    if (webWrite && !body.ok && !["INVALID_REQUEST", "SOURCE_CHANGED", "WEB_SERVICE_INVALID",
      "CLIENT_BUSY", "CSRF_INVALID", "METHOD_NOT_ALLOWED"].includes(body.error?.code)) {
      throw uncertainWeb(body.error?.code === "WEB_SERVICE_WRITE_FAILED" ? body.error.code : undefined);
    }
    if (body.ok) webServiceProblem = "";
  }
  if (["webResearchStatus", "webResearchCheck"].includes(method)) {
    if (sourceScope !== personalConnection.settingsScopeKey()) {
      throw Object.assign(Error("Source changed"), { code: "SOURCE_CHANGED" });
    }
    if (webSettingsGeneration !== webGeneration + (method === "webResearchCheck" ? 2 : 0)) {
      throw Object.assign(Error("Web status changed"), { code: "WEB_STATUS_CHANGED" });
    }
    if (typeof body?.ok !== "boolean" || body.ok && (!isWebReadiness(body.result)
      || method === "webResearchCheck" && body.result.sourceRevision !== params.revision)) {
      throw Object.assign(Error("Invalid web service status"), { code: "RESPONSE_INVALID" });
    }
  }
  if (method === "sourceConnectionStatus" && sourceSettingsProblem && sourceGeneration !== sourceSettingsGeneration) {
    throw Object.assign(Error("Source status requires recheck"), { code: sourceSettingsProblem });
  }
  if (method === "modelServiceStatus" && modelGeneration !== modelSettingsGeneration) {
    throw Object.assign(Error("Model status requires recheck"), {
      code: modelSettingsProblem || "MODEL_SETTINGS_CHANGED",
    });
  }
  if (sourceRemove) {
    const value = body?.result;
    if (typeof body?.ok !== "boolean" || body.ok && (!value
      || ["ready", "tokenConfigured", "pinConfigured", "urlConfigured", "modelUseAllowed"]
        .some(key => value[key] !== false)
      || value.endpoint !== null || value.checkedAt !== null || value.connection !== "NOT_CHECKED"
      || value.mcp?.profileShared !== false || typeof value.revision !== "string"
      || !/^[a-f0-9]{64}$/.test(value.revision)
      || value.revision === params.revision)) throw uncertainRemoval();
  }
  if (method === "sourceConnectionStatus" && sourceSettingsProblem
    && (typeof body?.ok !== "boolean" || body.ok && !isSourceSettingsSnapshot(body.result))) throw uncertainRemoval();
  if (voiceWrite || method === "voiceServiceStatus") {
    const value = body?.result;
    if (typeof body?.ok !== "boolean" || body.ok && (!isVoiceSettingsSnapshot(value)
      || voiceWrite && value.configured !== (params.apiKey !== null))) throw uncertainVoice();
  }
  if ((modelWrite || method === "modelServiceStatus") && (typeof body?.ok !== "boolean"
    || body.ok && !isModelSettingsSnapshot(body.result))) throw uncertainWrite();
  if (wikiSourceRevision) wikiSourceMonitor.researchRevision(wikiSourceRevision);
  if (!body.ok) {
    const code = codeOf(body.error?.code);
    if (sourceRemove) throw uncertainRemoval(["SOURCE_CHANGED", "SOURCE_CONFIG_INVALID", "SOURCE_CONFIG_WRITE_FAILED",
      "INVALID_REQUEST", "CSRF_INVALID", "METHOD_NOT_ALLOWED", "CLIENT_BUSY"].includes(code)
      ? code : "SOURCE_CONFIG_RECHECK_REQUIRED");
    if (voiceWrite && !["VOICE_SETTINGS_INVALID", "VOICE_SETTINGS_CHANGED", "VOICE_SETTINGS_UNAVAILABLE",
      "VOICE_CREDENTIAL_READ_ONLY", "CLIENT_BUSY", "CSRF_INVALID", "METHOD_NOT_ALLOWED", "INVALID_REQUEST"].includes(code)) {
      throw uncertainVoice(code === "VOICE_SETTINGS_WRITE_FAILED" ? code : "VOICE_SETTINGS_RECHECK_REQUIRED");
    }
    if (modelWrite && !["MODEL_SETTINGS_CHANGED", "MODEL_SETTINGS_INVALID", "MODEL_SETTINGS_UNAVAILABLE",
      "MODEL_CREDENTIAL_REQUIRED", "MODEL_CREDENTIAL_READ_ONLY", "CLIENT_BUSY", "CSRF_INVALID",
      "MODEL_ROUTE_CREDENTIAL_PRESENT", "MODEL_ROUTE_UNMANAGED", "MODEL_ROUTE_IN_USE",
      "METHOD_NOT_ALLOWED", "INVALID_REQUEST"].includes(code)) {
      throw uncertainWrite(code === "MODEL_SETTINGS_WRITE_FAILED" ? code : "MODEL_SETTINGS_RECHECK_REQUIRED");
    }
    throw Object.assign(Error("Remote read failed"), { code });
  }
  if (method === "bootstrap" && body.result?.csrfToken) {
    csrf = body.result.csrfToken;
    delete body.result.csrfToken;
  }
  if (modelWrite) {
    const desired = method === "modelServiceRoute" ? params.action === "save" ? "variable-os-custom" : "" : params.provider;
    preferredModelProvider = body.result.providers.find((row: any) => row.provider === desired)?.provider ?? "";
  }
  if (method === "sourceConnectionConfigure" || modelWrite || voiceWrite) personalConnection.invalidate();
  if (method === "modelServiceStatus") modelSettingsProblem = "";
  if (method === "voiceServiceStatus") voiceSettingsProblem = "";
  if (["sourceConnectionStatus", "sourceConnectionConfigure", "sourceConnectionRemove"].includes(method)
    && sourceGeneration === sourceSettingsGeneration) sourceSettingsProblem = "";
  if (["wikiSourceConfigure", "wikiSourceCredentials"].includes(method)) wikiSourceMonitor.observe(body.result);
  return body.result;
}
function bootstrap() {
  if (!bootstrapPromise) bootstrapPromise = remoteRpc("bootstrap").then((value) => {
    if (value?.wiki) wikiSourceMonitor.observe(value.wiki);
    if (value?.provider === "remote" && value.settings?.provider === "remote") {
      personalConnection.select(value); return value;
    }
    if (value?.provider === "local" || (!value?.provider && value?.diagnostics?.version === "variable-desk-v1" && value?.health)) return value;
    throw Object.assign(Error("Unknown provider"), { code: "RESPONSE_INVALID" });
  }).catch((error) => {
    bootstrapPromise = null; throw error;
  });
  return bootstrapPromise;
}

function Settings({ settings }: any) {
  return <section className="remote-settings" aria-label="Remote settings">
    <h3>Connection settings</h3>
    <dl>{[
      ["Provider", "remote"], ["Endpoint", settings.urlConfigured ? "Configured" : "Missing: VARIABLE_OS_EDGE_URL"],
      ["Credential", settings.tokenConfigured ? "Host configured" : "Missing host credential"],
      ["Certificate pin", settings.pinConfigured ? "Configured" : "Missing: VARIABLE_OS_EDGE_SPKI"],
      ["TLS", settings.tls || "TLSv1.3"], ["Trust", settings.trust || "SYSTEM_CA"], ["Status", settings.code],
    ].map(([label, value]) => <RemoteReact.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></RemoteReact.Fragment>)}</dl>
    {!settings.ready ? <p className="remote-alert" role="alert">{settings.code}</p> : null}
  </section>;
}

export function RemoteDesk({ initial, settingsOnly = false, compact = false }: any) {
  const [settings, setSettings] = useState(initial.settings);
  const [view, setView] = useState(settingsOnly ? "settings" : "inbox");
  const [query, setQuery] = useState("");
  const [dataset, setDataset] = useState("");
  const [datasets, setDatasets] = useState<any[]>([]);
  const [streamVersion, setStreamVersion] = useState(0);
  const resume = useRef<string | null>(null);
  const session = useMemo(() => createRemoteSession({ call: remoteRpc }), []);
  const [snapshot, setSnapshot] = useState(session.snapshot());
  useEffect(() => session.subscribe(setSnapshot), [session]);
  useEffect(() => () => session.close(), [session]);
  useEffect(() => {
    if (!settings.ready || compact || settingsOnly) return;
    const abort = new AbortController();
    void remoteRpc("datasets", {}, { signal: abort.signal }).then((result) => {
      if (!abort.signal.aborted) setDatasets(result.datasets ?? []);
    }).catch((error) => { if (!abort.signal.aborted) session.invalidate(codeOf(error.code)); });
    void readRemoteStream({
      // Research spans every granted dataset, regardless of the visible list filter.
      csrf, signal: abort.signal, resume,
      onEvent: ({ event }: any) => session.invalidate(event),
      onState: (state: any) => {
        if (state.code === "CONNECTED") session.connection(state.code);
        else {
          session.invalidate(state.code === "RESYNC_REQUIRED" ? "RESYNC_REQUIRED" : "DISCONNECTED");
          if (state.error) session.failure(state.error);
        }
      },
    });
    return () => abort.abort();
  }, [settings.ready, streamVersion, session, compact, settingsOnly]);
  const refresh = async () => {
    if (view === "settings") {
      try { const result = await remoteRpc("bootstrap"); setSettings(result.settings); }
      catch (error: any) { setSettings({ ...settings, ready: false, code: codeOf(error.code) }); }
      return;
    }
    if (snapshot.streamCode === "RESYNC_REQUIRED") {
      await session.load("changes", { cursor: "start", ...(dataset ? { datasetId: dataset } : {}) });
      return;
    }
    const params = dataset ? { datasetId: dataset } : {};
    await session.load(view === "wiki" ? "wikiIndex" : view === "evidence" ? "search" : "inbox",
      view === "evidence" ? { query, ...(dataset ? { datasetIds: [dataset] } : {}) } : params);
  };
  const changeView = (next: string) => { session.invalidate(snapshot.streamCode); setView(next); };
  if (compact) return <div className="vos-remote remote-compact"><style>{remoteStyles}</style>
    <button type="button" aria-label="Open remote research" title="Open remote research"
      onClick={() => setOverlayOpen(true)}><DeskIcon name="crosshair" />
      <span>Remote research</span><small>{settings.code}</small></button>
  </div>;
  return <section className="vos-remote" aria-label="Remote research">
    <style>{remoteStyles}</style>
    <header><h2>Remote research</h2><span className="remote-badge">Read-only</span></header>
    {!settingsOnly ? <nav role="tablist" aria-label="Research views">{["inbox", "evidence", "wiki", "settings"].map((tab) =>
      <button key={tab} role="tab" aria-selected={view === tab} onClick={() => changeView(tab)}>{({ inbox: "Inbox", evidence: "Evidence", wiki: "Wiki excerpts", settings: "Settings" } as any)[tab]}</button>)}</nav> : null}
    {view === "settings" ? <><SourceConnectionSettings call={remoteRpc} onChange={(source: any) => {
      resume.current = null; setDatasets([]); setDataset(""); session.invalidate("CONNECTING");
      setSettings({ ...source, ready: source.connection === "CONNECTED" });
      setStreamVersion(value => value + 1); bootstrapPromise = null;
    }} /><WikiSourceSettings call={remoteRpc} onChange={() => session.invalidate(snapshot.streamCode)} /><Settings settings={settings} /><button title="Read settings" aria-label="Read settings" onClick={refresh}><DeskIcon name="refresh" /></button></> : <>
      {!settings.ready ? <Settings settings={settings} /> : <>
        <div className="remote-status" role="status" aria-live="polite">
          <span>{snapshot.streamCode}</span>
          {snapshot.streamCode === "DISCONNECTED" ? <button onClick={() => setStreamVersion((value) => value + 1)}>Reconnect</button> : null}
          {snapshot.streamCode === "RESYNC_REQUIRED" ? <span className="remote-alert">Resync required</span> : null}
        </div>
        <div className="remote-toolbar">
          <select aria-label="Dataset" value={dataset} onChange={(event) => { session.invalidate(snapshot.streamCode); setDataset(event.target.value); }}>
            <option value="">All granted datasets</option>{datasets.map((item) => <option key={item.datasetId} value={item.datasetId}>{item.datasetId}</option>)}
          </select>
          <button title="Read current snapshot" aria-label="Read current snapshot" disabled={snapshot.busy || (view === "evidence" && !query.trim())} onClick={refresh}><DeskIcon name="refresh" /></button>
          {snapshot.streamCode === "RESYNC_REQUIRED" ? <button onClick={async () => {
            try {
              await resyncRemote(remoteRpc);
              resume.current = null; session.invalidate("CONNECTING"); setStreamVersion((value) => value + 1);
            } catch (error: any) { session.failure(codeOf(error.code)); }
          }}>Resync</button> : null}
        </div>
        <form className="remote-toolbar" onSubmit={(event) => { event.preventDefault(); if (view === "evidence") void refresh(); else void session.research(query); }}>
          <input aria-label="Research question" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} />
          <button className="remote-primary" disabled={snapshot.busy || query.trim().length < 2 ||
            (view !== "evidence" && ["CONNECTING", "DISCONNECTED", "RESYNC_REQUIRED"].includes(snapshot.streamCode))} type="submit"><DeskIcon name={view === "evidence" ? "eye" : "sparkle"} size={16} />{view === "evidence" ? "Search" : "Synthesize"}</button>
          {snapshot.busy ? <button type="button" aria-label="Cancel" title="Cancel" onClick={() => session.invalidate(snapshot.streamCode)}><DeskIcon name="stop" size={16} /></button> : null}
        </form>
        {snapshot.error ? <p className="remote-alert" role="alert">{snapshot.error}</p> : null}
        {snapshot.busy ? <p role="status">Reading</p> : null}
        <div className="remote-layout">
          <div><h3>{view === "wiki" ? "Wiki excerpts" : view === "evidence" ? "Evidence" : "Cards"}</h3>
            <ul className="remote-list">{snapshot.rows.map((item: any) => <li key={`${item.datasetId}:${item.evidenceId || item.path}`}>
              <button onClick={() => session.load(view === "wiki" ? "wiki" : view === "inbox" ? "casefile" : "evidence", {
                datasetId: item.datasetId, ...(view === "wiki" ? { path: item.path } : view === "inbox" ? { card: item.cardId } : { id: item.evidenceId }),
              })}><strong>{item.title || item.cardId || item.evidenceId || item.path}</strong><DeskIcon name="chevron" size={16} /></button>
              {item.excerpt ? <p>{item.excerpt}</p> : null}<small>{item.datasetId} / {item.knownAt || "UNKNOWN"}</small>
            </li>)}</ul>
            {!snapshot.rows.length && !snapshot.busy ? <p className="remote-empty">No current snapshot</p> : null}
            {snapshot.nextCursor ? <button onClick={() => session.load(view === "wiki" ? "wikiIndex" : view === "evidence" ? "search" : "inbox", {
              cursor: snapshot.nextCursor, ...(dataset && view !== "evidence" ? { datasetId: dataset } : {}),
              ...(view === "evidence" ? { query, ...(dataset ? { datasetIds: [dataset] } : {}) } : {}),
            })}>Next page</button> : null}
          </div>
          <article aria-label="Evidence details">
            <h3>Evidence details</h3>
            {snapshot.record ? <><strong>{snapshot.record.cardId || snapshot.record.evidenceId}</strong><p>{snapshot.record.excerpt}</p><small>Known: {snapshot.record.knownAt || "UNKNOWN"} / License: {snapshot.record.license || "UNKNOWN"}</small></> : null}
            {snapshot.research ? <><p className={snapshot.research.status === "partial" ? "remote-alert" : "remote-muted"} role="status">{snapshot.research.status === "partial" ? `Partial: web ${snapshot.research.web.status}` : "Synthesis complete"}</p>
              {snapshot.research.wiki ? <p role="status">Wiki {snapshot.research.wiki.mode}: {snapshot.research.wiki.status} / {snapshot.research.wiki.included ?? "UNKNOWN"} included</p> : null}
              <pre>{snapshot.research.synthesisMarkdown}</pre>
              <h3>References</h3><ul>{snapshot.research.refs?.map((ref: any, index: number) => <li key={index}>{ref.ref || ref.evidenceId || ref.id || "UNKNOWN"}</li>)}</ul></> : null}
            {snapshot.receipt ? <dl><dt>As of</dt><dd>{snapshot.receipt.asOf || "UNKNOWN"}</dd><dt>Data age (ms)</dt><dd>{snapshot.receipt.dataAge ?? "UNKNOWN"}</dd><dt>Rate remaining</dt><dd>{snapshot.receipt.rateRemaining ?? "UNKNOWN"}</dd></dl> : null}
          </article>
        </div>
      </>}
    </>}
  </section>;
}

export function providerSurface(Local: any, mode = "desk") {
  return function ProviderSurface(props: any) {
    const [result, setResult] = useState<any>(null);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const [generation, setGeneration] = useState(0);
    useEffect(() => personalConnection.subscribe(setGeneration), []);
    useEffect(() => result?.provider === "remote" ? personalConnection.watch(csrf) : undefined, [result]);
    useEffect(() => result ? wikiSourceMonitor.watch(options => remoteRpc("wikiSourceStatus", {}, options)) : undefined, [result]);
    useEffect(() => {
      let active = true;
      setError("");
      setResult(null);
      void bootstrap().then((value) => { if (active) setResult(value); })
        .catch((failure) => { if (active) setError(codeOf(failure.code)); });
      return () => { active = false; };
    }, [attempt]);
    if (error) return <div className="vos-remote"><style>{remoteStyles}</style><p role="alert">{error}</p>
      <button onClick={() => setAttempt((value) => value + 1)}><DeskIcon name="refresh" size={16} />重新连接</button></div>;
    if (!result) return <div role="status">正在连接变量台</div>;
    return <Local key={mode === "settings" ? personalConnection.settingsScopeKey() : generation} {...props} />;
  };
}

export function providerSlots(slots: any) {
  const modes: Record<string, string> = {
    "conversation.view": "desk", "conversation.input.dock": "compact",
    "sidebar.footer.action": "compact", "shell.overlay": "overlay", "settings.section": "settings",
  };
  return {
    inject: (...args: any[]) => slots.inject(...args),
    register: (meta: any, component: any) => slots.register(meta,
      modes[meta.name] ? providerSurface(component, modes[meta.name]) : component),
  };
}
