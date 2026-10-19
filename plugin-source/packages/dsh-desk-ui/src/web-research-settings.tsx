// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
/** @jsxRuntime classic */
/** @jsx WebReact.createElement */
/** @jsxFrag WebReact.Fragment */
import * as WebReact from "react";
import { DeskIcon } from "./icons";
import { webReadinessLabel } from "./web-readiness.mjs";
import { webServiceIssue } from "./remote-client";
const { useEffect, useRef, useState } = WebReact;

export function WebResearchSettings({ call }: any) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [edge, setEdge] = useState<any>(null);
  const [mode, setMode] = useState("edge");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(webServiceIssue);
  const current = useRef<AbortController | null>(null);
  async function run(method = "webServiceStatus", params = {}) {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setBusy(true); setError(""); setApiKey("");
    try {
      const value = await call(method, params, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (method === "webResearchCheck") setEdge(value);
      else {
        setSnapshot(value); setMode(value.mode); setEdge(null);
        if (value.mode === "edge") {
          const status = await call("webResearchStatus", {}, { signal: controller.signal });
          if (!controller.signal.aborted) setEdge(status);
        }
      }
    } catch (failure: any) {
      if (!controller.signal.aborted) {
        setError(/^[A-Z_]{2,64}$/.test(failure?.code ?? "") ? failure.code : "WEB_SERVICE_UNAVAILABLE");
        setSnapshot(null); setEdge(null);
      }
    } finally { if (current.current === controller) setBusy(false); }
  }
  useEffect(() => {
    if (!webServiceIssue()) void run();
    return () => current.current?.abort();
  }, [call]);
  const keyValid = !apiKey || /^[\x21-\x7e]{1,512}$/.test(apiKey);
  return <section className="vos-source-settings" aria-label="联网研究服务">
    <style>{`.vos-web-fields{display:grid;gap:12px;max-width:760px;min-width:0}
.vos-web-fields label{display:grid;gap:4px}.vos-web-fields input,.vos-web-fields select{font:inherit;letter-spacing:0;width:100%;min-width:0;box-sizing:border-box;padding:8px;border:1px solid #7b8782;border-radius:4px;background:#fff;color:#20252b}`}</style>
    <h3>联网研究服务</h3>
    <dl><dt>网页检索</dt><dd>{snapshot?.mode === "own" ? "我的 Tavily API" : snapshot?.mode === "off" ? "已关闭" : "当前 API 信源服务"}</dd>
      <dt>服务配置</dt><dd role="status">{busy ? "正在读取网页服务状态" : !snapshot ? "待重新检查"
        : snapshot.mode === "edge" ? webReadinessLabel(edge) : snapshot.mode === "off" ? "未启用"
          : snapshot.configured ? "Host 已配置" : "API Key 未配置"}</dd>
      <dt>上游连接</dt><dd>未验证</dd>
      <dt>调用授权</dt><dd>每次研究单独确认</dd>
      {snapshot ? <><dt>保存位置</dt><dd>{snapshot.persistence === "HOST_FILE" ? "Host 私有文件" : "仅本次会话"}</dd></> : null}
    </dl>
    {snapshot ? <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      void run("webServiceConfigure", { revision: snapshot.revision, mode, ...(apiKey ? { apiKey } : {}) });
    }}>
      <div className="vos-web-fields">
        <label>网页检索服务<select aria-label="网页检索服务" value={mode} disabled={busy}
          onChange={event => { setMode(event.target.value); setApiKey(""); }}>
          <option value="off">关闭网页检索</option>
          <option value="edge">使用当前 API 信源服务</option>
          <option value="own">使用我的 Tavily API</option>
        </select></label>
        {mode === "own" ? <label>Tavily API Key<input aria-label="Tavily API Key" type="password"
          value={apiKey} maxLength={512} autoComplete="new-password" spellCheck={false} disabled={busy}
          onChange={event => setApiKey(event.target.value)} /></label> : null}
      </div>
      <div className="vos-source-actions">
        <button type="submit" disabled={busy || !keyValid}><DeskIcon name="lock" size={16} />保存网页设置</button>
        <button type="button" aria-label="清除自配密钥并关闭网页检索" disabled={busy || !snapshot.configured && snapshot.mode === "off"}
          onClick={() => void run("webServiceRemove", { revision: snapshot.revision })}>
          <DeskIcon name="close" size={16} />清除自配密钥并关闭</button>
      </div>
    </form> : null}
    <div className="vos-source-actions">
      {snapshot?.mode === "edge" ? <button type="button" disabled={busy || !edge || edge.reason === "SOURCE_UNAVAILABLE"}
        onClick={() => void run("webResearchCheck", { revision: edge.sourceRevision })}>
        <DeskIcon name="refresh" size={16} />检查网页服务配置</button> : null}
      <button type="button" disabled={busy} aria-label="重新读取网页服务状态"
        title="重新读取网页服务状态" onClick={() => void run()}><DeskIcon name="refresh" size={16} /></button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
