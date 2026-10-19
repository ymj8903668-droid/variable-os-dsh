// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
/** @jsxRuntime classic */
/** @jsx WikiReact.createElement */
/** @jsxFrag WikiReact.Fragment */
import * as WikiReact from "react";
import { DeskIcon } from "./icons";
import { sourceConnectionLabel } from "./view-model.mjs";
import { wikiSourceMonitor } from "./wiki-source-monitor.mjs";
const { useEffect, useRef, useState } = WikiReact;

const styles = `
.vos-wiki-settings{font:14px/1.5 system-ui,sans-serif;letter-spacing:0;color:#20252b;background:#fff;max-width:760px;padding:16px 0;min-width:0}
.vos-wiki-settings *{box-sizing:border-box;letter-spacing:0}.vos-wiki-settings h3{font-size:16px;margin:0 0 12px}
.vos-wiki-settings fieldset{margin:0;padding:0;border:0}.vos-wiki-settings legend{margin-bottom:6px}
.vos-wiki-settings .wiki-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}
.vos-wiki-settings .wiki-modes label{border:1px solid #7b8782;border-radius:4px;display:flex;align-items:center;gap:6px;padding:8px}
.vos-wiki-settings input[type=radio],.vos-wiki-settings input[type=checkbox]{width:16px;height:16px;min-height:0;margin:0;flex-shrink:0}
.vos-wiki-settings .wiki-field{display:grid;gap:4px;margin:12px 0}
.vos-wiki-settings input:not([type]),.vos-wiki-settings input[type=password],.vos-wiki-settings select{min-width:0;width:100%;max-width:100%;font:inherit;padding:8px;border:1px solid #7b8782;border-radius:4px;background:#fff;color:#20252b}
.vos-wiki-settings .wiki-consent{display:flex;align-items:center;gap:8px;margin:12px 0}
.vos-wiki-settings button{font:inherit;border:1px solid #7b8782;background:#fff;color:#20252b;border-radius:4px;min-height:38px;padding:6px 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}
.vos-wiki-settings button:disabled{opacity:.65;cursor:default}.vos-wiki-settings :focus-visible{outline:3px solid #163d65;outline-offset:2px}
.vos-wiki-settings dl{display:grid;grid-template-columns:minmax(100px,.6fr) minmax(0,1fr);gap:4px;margin:12px 0}
.vos-wiki-settings dt,.vos-wiki-settings dd{margin:0;overflow-wrap:anywhere}.vos-wiki-settings dt{color:#47525e}
.vos-wiki-settings .wiki-actions{display:flex;gap:8px;flex-wrap:wrap}.vos-wiki-settings .wiki-error{color:#86341d;overflow-wrap:anywhere}
.vos-wiki-settings form{margin-bottom:8px}.vos-wiki-settings>button{margin-top:8px}
.vos-wiki-settings details{margin-top:16px;border-top:1px solid #bdc7c3;padding-top:12px}.vos-wiki-settings summary{cursor:pointer}
.vos-wiki-settings output{display:block;min-height:24px;margin-top:8px;overflow-wrap:anywhere}
.vos-wiki-settings .wiki-directory{margin-top:16px;padding-top:12px;border-top:1px solid #bdc7c3;min-width:0}
.wiki-directory nav{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0}
.wiki-directory .wiki-directory-path{flex:1;min-width:100px;overflow-wrap:anywhere}
.wiki-directory ul{list-style:none;padding:0;margin:8px 0;max-height:320px;overflow:auto;border-block:1px solid #dde2df}
.wiki-directory li{border-bottom:1px solid #dde2df;min-height:40px;padding:4px 0}
.wiki-directory li:last-child{border-bottom:0}.wiki-directory li button{width:100%;justify-content:flex-start;text-align:left;border:0}
.wiki-directory li label{display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer}
.wiki-directory li span{min-width:0;overflow-wrap:anywhere}.wiki-directory svg{flex-shrink:0}
.wiki-directory .wiki-back svg{transform:rotate(180deg)}
`;
const safeCode = (error: any) => /^[A-Z_]{2,64}$/.test(error?.code ?? "") ? error.code : "SOURCE_UNAVAILABLE";
const diagnosticLabels: Record<string, string> = {
  AUTH_REQUIRED: "凭证未配置或鉴权失败",
  FORBIDDEN_SCOPE: "当前账号无此访问权限",
  CANCELLED: "连接检查已取消",
  SOURCE_UNAVAILABLE: "信源暂不可用",
  IMA_REQUEST_TIMEOUT: "连接超时",
  IMA_SESSION_TIMEOUT: "本次检查超时",
  IMA_TLS_OR_NETWORK_FAILURE: "网络或 TLS 校验未通过",
  IMA_DNS_REJECTED: "DNS 检查未通过",
  IMA_PAGINATION_INVALID: "IMA 分页信息不完整",
  IMA_RESPONSE_INVALID: "IMA 响应格式不兼容",
  IMA_IDENTITY_AMBIGUOUS: "返回记录身份冲突",
  IMA_API_BUDGET_EXHAUSTED: "达到本次请求上限",
  IMA_RATE_LIMITED: "IMA 调用受限",
};

export function WikiCheckDiagnostic({ code }: { code?: string | null }) {
  if (typeof code !== "string" || !Object.hasOwn(diagnosticLabels, code)) return null;
  return <p className="wiki-error" role="alert">{diagnosticLabels[code]} <code>{code}</code></p>;
}

export function WikiDirectoryBrowser({ snapshot, call, onSelect, disabled = false }: any) {
  const [page, setPage] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [selection, setSelection] = useState<any[]>(snapshot.selectedDocuments ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);
  const saved = JSON.stringify(selection) === JSON.stringify(snapshot.selectedDocuments ?? []);
  const load = async (location = { folderPath: [], cursor: "" }, trail: any[] = []) => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setBusy(true); setError(""); setPage(null);
    try {
      const result = await call("wikiSourceBrowse", {
        profileRevision: snapshot.profileRevision, location,
      }, { signal: controller.signal });
      if (!controller.signal.aborted) { setPage(result); setHistory(trail); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(safeCode(failure));
    } finally { if (current.current === controller) setBusy(false); }
  };
  const toggle = (row: any, checked: boolean) => setSelection(previous => checked
    ? [...previous, { evidenceId: row.evidenceId, location: row.location }]
    : previous.filter(item => item.evidenceId !== row.evidenceId));
  return <section className="wiki-directory" aria-label="IMA 资料目录" data-selection-saved={String(saved)}>
    <div className="wiki-actions">
      <button type="button" disabled={busy || disabled} onClick={() => void load()}>
        <DeskIcon name="book" size={16} />浏览资料</button>
      {busy ? <button type="button" aria-label="取消读取" title="取消读取" onClick={() => {
        current.current?.abort(); setBusy(false); setError("CANCELLED");
      }}><DeskIcon name="stop" size={16} /></button> : null}
    </div>
    {page ? <>
      <nav aria-label="资料目录导航">
        <button type="button" className="wiki-back" disabled={busy || disabled || !history.length}
          aria-label="返回上一页" title="返回上一页" onClick={() => void load(history.at(-1), history.slice(0, -1))}>
          <DeskIcon name="chevron" size={16} /></button>
        <span className="wiki-directory-path">{page.path.map((row: any) => row.name).join(" / ")}</span>
        <button type="button" disabled={busy || disabled || !page.nextLocation} aria-label="下一页" title="下一页"
          onClick={() => void load(page.nextLocation, [...history, page.location])}><DeskIcon name="chevron" size={16} /></button>
      </nav>
      <ul aria-label="当前页资料">
        {page.folders.map((row: any) => <li key={`folder:${row.id}`}>
          <button type="button" disabled={busy || disabled} aria-label={`进入 ${row.name}`}
            onClick={() => void load(row.location, [...history, page.location])}>
            <DeskIcon name="book" size={16} /><span>{row.name}</span><DeskIcon name="chevron" size={16} /></button>
        </li>)}
        {page.documents.map((row: any) => {
          const checked = selection.some(item => item.evidenceId === row.evidenceId);
          return <li key={row.evidenceId}><label><input type="checkbox" checked={checked}
            aria-label={`选择 ${row.title}`} disabled={busy || disabled || (!checked && selection.length >= 3)}
            onChange={event => toggle(row, event.target.checked)} /><span>{row.title}</span></label></li>;
        })}
      </ul>
      {!page.documents.length && !page.folders.length ? <output>此页无资料</output> : null}
    </> : busy ? <output>正在读取目录</output> : null}
    <output>已选资料：{selection.length}</output>
    <div className="wiki-actions">
      <button type="button" disabled={busy || disabled || saved} onClick={() => onSelect(selection)}>
        <DeskIcon name="pin" size={16} />使用所选资料</button>
      <button type="button" disabled={busy || disabled || !selection.length} onClick={() => setSelection([])}
        aria-label="清除资料选择" title="清除资料选择"><DeskIcon name="close" size={16} /></button>
    </div>
    {error ? <p role="alert" className="wiki-error">{error}</p> : null}
  </section>;
}

export function WikiSourceSettings({ call, onChange }: any) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [pendingConfig, setPendingConfig] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const [hash, setHash] = useState("");
  const [clientId, setClientId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const current = useRef<AbortController | null>(null);
  const run = async (method: string, params = {}) => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    const observed = wikiSourceMonitor.snapshot().generation;
    setBusy(method); setError("");
    if (["wikiSourceConfigure", "wikiSourceCredentials"].includes(method)) onChange?.();
    try {
      const result = await call(method, params, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const latest = wikiSourceMonitor.snapshot();
      setSnapshot(latest.generation !== observed && latest.value?.profileRevision !== result.profileRevision
        ? latest.value : result);
      setPendingConfig(null);
    } catch (failure) {
      if (!controller.signal.aborted) { setError(safeCode(failure)); setPendingConfig(null); }
    } finally { if (current.current === controller) setBusy(""); }
  };
  useEffect(() => {
    void run("wikiSourceStatus");
    return () => current.current?.abort();
  }, [call]);
  useEffect(() => wikiSourceMonitor.subscribe(value => {
    setClientId(""); setApiKey(""); setPendingConfig(null);
    setSnapshot(value.value);
    setError(value.status === "UNAVAILABLE" ? "WIKI_SOURCE_UNAVAILABLE" : "");
  }), []);
  const configure = (patch: any) => {
    const next = {
      mode: snapshot.mode, libraryId: snapshot.libraryId, modelUseAllowed: snapshot.modelUseAllowed,
      selectedContentHashes: snapshot.selectedContentHashes, selectedDocuments: snapshot.selectedDocuments ?? [],
      ...patch, profileRevision: snapshot.profileRevision,
    };
    setPendingConfig(next);
    void run("wikiSourceConfigure", next);
  };
  const credentials = (clear = false) => {
    const params = { clientId: clear ? null : clientId, apiKey: clear ? null : apiKey, profileRevision: snapshot.profileRevision };
    setClientId(""); setApiKey("");
    void run("wikiSourceCredentials", params);
  };
  return <section className="vos-wiki-settings" aria-label="Wiki 信源设置" data-wiki-consent={String(snapshot?.modelUseAllowed === true)}>
    <style>{styles}</style><h3>Wiki 信源</h3>
    {!snapshot ? <button type="button" onClick={() => void run("wikiSourceStatus")} disabled={!!busy}>
      <DeskIcon name="refresh" size={16} />{busy ? "正在读取设置" : "读取设置"}
    </button> : <>
      <fieldset><legend>信源</legend><div className="wiki-modes">
        {[["local", "本地 Wiki"], ["ima", "IMA"], ["none", "不使用 Wiki"]].map(([mode, label]) =>
          <label key={mode}><input type="radio" name="wiki-source" checked={(pendingConfig ?? snapshot).mode === mode}
            onChange={() => configure({ mode, libraryId: null, modelUseAllowed: false, selectedContentHashes: {}, selectedDocuments: [] })} />{label}</label>)}
      </div></fieldset>
      {snapshot.mode === "ima" ? <>
        <dl><dt>凭证</dt><dd>{snapshot.credentialsConfigured ? "Host 已配置" : "未配置"}</dd>
          <dt>保存位置</dt><dd>{snapshot.persistence === "HOST_FILE" ? "Host 私有文件" : "仅本次会话"}</dd>
          <dt>连接</dt><dd>{sourceConnectionLabel(busy === "wikiSourceCheck" ? "CHECKING" : snapshot.connection)}</dd>
          <dt>检查时间</dt><dd>{snapshot.checkedAt ?? "暂无有效检查记录"}</dd></dl>
        {snapshot.connection === "FAILED" && busy !== "wikiSourceCheck"
          ? <WikiCheckDiagnostic code={snapshot.checkError} /> : null}
        <form onSubmit={event => { event.preventDefault(); credentials(); }} autoComplete="off">
          <label className="wiki-field">IMA Client ID<input type="password" autoComplete="off" spellCheck={false}
            value={clientId} maxLength={8192} disabled={!!busy} onChange={event => setClientId(event.target.value)} /></label>
          <label className="wiki-field">IMA API Key<input type="password" autoComplete="new-password" spellCheck={false}
            value={apiKey} maxLength={8192} disabled={!!busy} onChange={event => setApiKey(event.target.value)} /></label>
          <div className="wiki-actions">
            <button type="submit" disabled={!!busy || !clientId || !apiKey}><DeskIcon name="lock" size={16} />保存 IMA 凭证</button>
            <button type="button" disabled={!!busy || !snapshot.credentialsConfigured}
              onClick={() => credentials(true)}><DeskIcon name="close" size={16} />清除 IMA 凭证</button>
          </div>
        </form>
        <div className="wiki-actions"><button type="button" disabled={!!busy || !snapshot.credentialsConfigured}
          onClick={() => void run("wikiSourceCheck")}><DeskIcon name="link" size={16} />检查 IMA 连接</button>
          {busy === "wikiSourceCheck" ? <button type="button" aria-label="取消连接检查" title="取消连接检查"
            onClick={() => { current.current?.abort(); setBusy(""); setError("CANCELLED"); }}><DeskIcon name="stop" size={16} /></button> : null}</div>
        <label className="wiki-field">知识库<select value={(pendingConfig ?? snapshot).libraryId ?? ""} disabled={!!busy}
          onChange={event => configure({ libraryId: event.target.value || null, selectedContentHashes: {}, selectedDocuments: [] })}>
          <option value="">选择知识库</option>
          {snapshot.libraryId && !snapshot.libraries.some((row: any) => row.id === snapshot.libraryId)
            ? <option value={snapshot.libraryId}>{snapshot.libraryId}</option> : null}
          {snapshot.libraries.map((row: any) => <option key={row.id} value={row.id}>{row.name} / {row.id}</option>)}
        </select></label>
        <label className="wiki-consent"><input type="checkbox" checked={(pendingConfig ?? snapshot).modelUseAllowed} disabled={!!busy}
          onChange={event => configure({ modelUseAllowed: event.target.checked })} />允许 IMA 摘录用于我的模型</label>
        {snapshot.libraryId && snapshot.credentialsConfigured ? <WikiDirectoryBrowser key={snapshot.profileRevision}
          snapshot={snapshot} call={call} disabled={!!busy}
          onSelect={(selectedDocuments: any[]) => configure({ selectedDocuments })} /> : null}
        <details><summary>内容版本</summary>
          <label className="wiki-field">证据 ID<input value={evidenceId} maxLength={1600} onChange={event => setEvidenceId(event.target.value)} /></label>
          <label className="wiki-field">内容 SHA-256<input value={hash} maxLength={64} onChange={event => setHash(event.target.value)} /></label>
          <div className="wiki-actions"><button type="button" disabled={!!busy || !snapshot.libraryId || !evidenceId || !/^[a-f0-9]{64}$/.test(hash)}
            onClick={() => configure({ selectedContentHashes: { ...snapshot.selectedContentHashes, [evidenceId]: hash } })}>
            <DeskIcon name="pin" size={16} />固定内容版本</button>
            <button type="button" disabled={!!busy || !Object.keys(snapshot.selectedContentHashes).length}
              onClick={() => configure({ selectedContentHashes: {} })}><DeskIcon name="close" size={16} />清除选择</button></div>
          <output>已选择 {Object.keys(snapshot.selectedContentHashes).length} 项</output>
        </details>
      </> : <output>{snapshot.mode === "none" ? "未启用" : "本地 Wiki"}</output>}
      <button type="button" disabled={!!busy} aria-label="重新读取 Wiki 设置" title="重新读取 Wiki 设置"
        onClick={() => { setClientId(""); setApiKey(""); void run("wikiSourceStatus"); }}><DeskIcon name="refresh" size={16} /></button>
    </>}
    {error ? <p className="wiki-error" role="alert">{error}</p> : null}
  </section>;
}
