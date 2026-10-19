// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
/** @jsxRuntime classic */
/** @jsx SourceReact.createElement */
/** @jsxFrag SourceReact.Fragment */
import * as SourceReact from "react";
import { DeskIcon } from "./icons";
import { sourceConnectionLabel } from "./view-model.mjs";
import { sourceSettingsIssue } from "./remote-client";
import { parseSourceConnectionInfo, parseSourceConnectionEndpoint, SOURCE_CONNECTION_INFO_LIMIT } from "../lib/source-connection-import.js";
const { useEffect, useRef, useState } = SourceReact;

const styles = `
.vos-source-settings{font:14px/1.5 system-ui,sans-serif;letter-spacing:0;max-width:760px;min-width:0;padding:16px 0;color:#20252b}
.vos-source-settings *{box-sizing:border-box;letter-spacing:0}.vos-source-settings h3{font-size:16px;margin:0 0 12px}
.vos-source-settings fieldset{border:0;padding:0;margin:0}.vos-source-modes{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 16px}
.vos-source-modes label{display:flex;align-items:center;gap:6px}.vos-source-modes input{width:16px;height:16px;min-height:0;margin:0}
.vos-source-field{display:grid;gap:4px;margin:12px 0}
.vos-source-field input,.vos-source-field textarea{width:100%;min-width:0;border:1px solid #7b8782;border-radius:4px;font:inherit;background:#fff;color:#20252b;padding:8px}
.vos-source-field textarea{resize:vertical;min-height:110px}.vos-source-settings details{margin:12px 0}
.vos-source-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.vos-source-actions button{display:inline-flex;align-items:center;gap:6px;font:inherit;min-height:38px;padding:6px 10px;border:1px solid #7b8782;border-radius:4px;background:#fff;color:#20252b;cursor:pointer}
.vos-source-actions button:disabled{opacity:.55;cursor:default}
.vos-source-settings dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:6px}
.vos-source-settings dd,.vos-source-settings dt{margin:0;overflow-wrap:anywhere}.vos-source-settings dt{color:#47525e}
.vos-source-settings [role=alert]{color:#983b28;overflow-wrap:anywhere}
.vos-source-settings :focus-visible{outline:3px solid #163d65;outline-offset:2px}
`;
const safeCode = (error: any) => /^[A-Z_]{2,64}$/.test(error?.code ?? "") ? error.code : "SOURCE_UNAVAILABLE";

export function SourceConnectionSettings({ call, onChange }: any) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [ownership, setOwnership] = useState("self");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [spki, setSpki] = useState("");
  const [caCertificate, setCaCertificate] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(sourceSettingsIssue);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const current = useRef<AbortController | null>(null);
  const fileReader = useRef<FileReader | null>(null);
  function cancelImport() {
    const reader = fileReader.current;
    fileReader.current = null;
    reader?.abort();
  }
  function importConnection(file?: File) {
    if (!file) return;
    cancelImport();
    if (file.size > SOURCE_CONNECTION_INFO_LIMIT) { setError("SOURCE_IMPORT_INVALID"); return; }
    const reader = new FileReader();
    fileReader.current = reader;
    setBusy("sourceConnectionImport"); setError("");
    reader.onload = () => {
      if (fileReader.current !== reader) return;
      try {
        const value = parseSourceConnectionInfo(reader.result);
        setEndpoint(value.endpoint); setSpki(value.spki); setCaCertificate(value.caCertificate);
        setToken(""); setConfirmRemoval(false);
      } catch { setError("SOURCE_IMPORT_INVALID"); }
      finally { fileReader.current = null; setBusy(""); }
    };
    const readFailed = () => {
      if (fileReader.current !== reader) return;
      fileReader.current = null; setBusy(""); setError("SOURCE_IMPORT_READ_FAILED");
    };
    reader.onerror = readFailed;
    try { reader.readAsText(file); } catch { readFailed(); }
  }
  async function run(method: string, params = {}) {
    cancelImport();
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setBusy(method); setError("");
    const changed = ["sourceConnectionConfigure", "sourceConnectionRemove"].includes(method);
    if (changed) { setToken(""); setCaCertificate(""); setSpki(""); setConfirmRemoval(false); }
    try {
      // The committed source can notify/remount this form before its reply arrives.
      // Let that single write finish, while the disposed form still ignores it.
      const signal = changed ? AbortSignal.timeout(15000) : controller.signal;
      const result = await call(method, params, { signal });
      if (controller.signal.aborted) return;
      if (method === "sourceConnectionMcpExport") {
        const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2) + "\n"], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url; link.download = "variable-os-mcp.json";
        document.body.append(link);
        try { link.click(); } finally {
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        return;
      }
      setSnapshot(result); setEndpoint(result.endpoint ?? ""); setOwnership(result.ownership);
      if (changed) {
        setToken(""); setCaCertificate(""); setSpki("");
        onChange?.(result);
      }
      if (method === "sourceConnectionCheck") onChange?.(result);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(safeCode(failure));
        if (method === "sourceConnectionCheck") {
          setSnapshot(previous => previous ? { ...previous, connection: "FAILED", checkedAt: null } : previous);
        }
        if (method === "sourceConnectionRemove") setSnapshot(null);
      }
    } finally { if (current.current === controller) setBusy(""); }
  }
  useEffect(() => {
    if (!sourceSettingsIssue()) void run("sourceConnectionStatus");
    return () => { current.current?.abort(); cancelImport(); };
  }, [call]);
  let apiEndpoint = "";
  try { apiEndpoint = parseSourceConnectionEndpoint(endpoint); } catch { /* Keep invalid drafts editable. */ }
  const valid = !!apiEndpoint
    && /^[A-Za-z0-9_-]{32,256}$/.test(token) && /^sha256\/[A-Za-z0-9+/]{43}=$/.test(spki);
  const saved = snapshot?.ready && snapshot?.mcp?.profileShared
    && endpoint === snapshot.endpoint && ownership === snapshot.ownership && !token && !spki && !caCertificate;
  return <section className="vos-source-settings" aria-label="信源连接">
    <style>{styles}</style><h3>信源连接</h3>
    <form onSubmit={event => {
      event.preventDefault();
      if (valid && !busy) void run("sourceConnectionConfigure", { ownership, endpoint: apiEndpoint, token, spki, caCertificate });
    }}>
      <fieldset disabled={!!busy}><legend>信息来源</legend><div className="vos-source-modes">
        {[["self", "自配信源"], ["provided", "提供的信源"]].map(([value, label]) =>
          <label key={value}><input type="radio" name="source-ownership" value={value} checked={ownership === value}
            onChange={() => setOwnership(value)} />{label}</label>)}
      </div>
      <label className="vos-source-field">导入接入信息<input type="file" accept=".json,application/json"
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          importConnection(file);
        }} /></label>
      <label className="vos-source-field">API 服务地址<input type="url" value={endpoint} required autoComplete="off"
        maxLength={2048} placeholder="https://..." onChange={event => setEndpoint(event.target.value)} /></label>
      <p>也可填写远程 MCP 地址（以 /mcp 结尾）。原卡从同站 HTTP/SSE 自动同步，无需模型 Key。</p>
      <label className="vos-source-field">访问令牌<input type="password" value={token} required autoComplete="new-password"
        maxLength={256} placeholder={snapshot?.tokenConfigured ? "已配置" : ""} onChange={event => setToken(event.target.value)} /></label>
      <label className="vos-source-field">证书指纹<input value={spki} required autoComplete="off" spellCheck={false}
        maxLength={51} placeholder="sha256/..." onChange={event => setSpki(event.target.value)} /></label>
      <details><summary>自签证书</summary><label className="vos-source-field">CA 证书 PEM
        <textarea value={caCertificate} autoComplete="off" spellCheck={false} maxLength={8192}
          onChange={event => setCaCertificate(event.target.value)} /></label></details>
      </fieldset>
      <div className="vos-source-actions">
        <button type="submit" disabled={!valid || !!busy}><DeskIcon name="link" size={16} />保存连接</button>
        <button type="button" disabled={!snapshot?.ready || !!busy}
          onClick={() => void run("sourceConnectionCheck")}><DeskIcon name="refresh" size={16} />检查连接</button>
        <button type="button" disabled={!saved || !!busy} title="导出本机只读 MCP 配置"
          onClick={() => void run("sourceConnectionMcpExport", { revision: snapshot.revision })}>
          <DeskIcon name="link" size={16} />导出 MCP 配置</button>
        <button type="button" disabled={!snapshot?.ready || !!busy || confirmRemoval}
          onClick={() => setConfirmRemoval(true)}><DeskIcon name="close" size={16} />移除连接</button>
      </div>
      {confirmRemoval ? <div role="group" aria-label="确认移除信源连接" className="vos-source-actions">
        <button type="button" disabled={!!busy} onClick={() => void run("sourceConnectionRemove", { revision: snapshot.revision })}>
          <DeskIcon name="close" size={16} />确认移除</button>
        <button type="button" disabled={!!busy} onClick={() => setConfirmRemoval(false)}>取消</button>
      </div> : null}
    </form>
    {snapshot ? <dl>
      <dt>连接状态</dt><dd role="status">{sourceConnectionLabel(busy === "sourceConnectionCheck" ? "CHECKING" : snapshot.connection)}</dd>
      <dt>最近检查</dt><dd>{snapshot.checkedAt ?? "暂无有效检查记录"}</dd>
      <dt>本机保存</dt><dd>{snapshot.persistence === "HOST_FILE" ? "已启用" : "仅本次会话"}</dd>
      <dt>MCP</dt><dd>{snapshot.mcp?.profileShared ? "stdio · 共用本机连接" : "stdio · 尚未保存连接"}</dd>
    </dl> : <button type="button" disabled={!!busy} onClick={() => void run("sourceConnectionStatus")}>读取连接</button>}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
