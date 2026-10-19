// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
/** @jsxRuntime classic */
/** @jsx ModelReact.createElement */
/** @jsxFrag ModelReact.Fragment */
import * as ModelReact from "react";
import { DeskIcon } from "./icons";
import { modelSettingsIssue, modelSettingsProvider } from "./remote-client";
import { modelReadinessLabel } from "./model-readiness.mjs";
const { useEffect, useRef, useState } = ModelReact;

const styles = `
.vos-model-settings{font:14px/1.5 system-ui,sans-serif;letter-spacing:0;color:#20252b;max-width:760px;padding:16px 0;min-width:0;border-top:1px solid #bdc7c3}
.vos-model-settings *{box-sizing:border-box;letter-spacing:0}.vos-model-settings h3{font-size:16px;margin:0 0 12px}
.vos-model-settings label{display:grid;gap:4px;margin:12px 0}
.vos-model-settings input,.vos-model-settings select{min-width:0;width:100%;font:inherit;padding:8px;border:1px solid #7b8782;border-radius:4px;background:#fff;color:#20252b}
.vos-model-settings button{font:inherit;min-height:38px;padding:6px 10px;display:inline-flex;align-items:center;gap:6px;border:1px solid #7b8782;border-radius:4px;background:#fff;color:#20252b;cursor:pointer}
.vos-model-settings button:disabled{opacity:.65;cursor:default}.vos-model-settings :focus-visible{outline:3px solid #163d65;outline-offset:2px}
.vos-model-settings dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:4px;margin:12px 0}
.vos-model-settings dt,.vos-model-settings dd{margin:0;overflow-wrap:anywhere}.vos-model-settings dt{color:#47525e}
.vos-model-settings .model-actions{display:flex;gap:8px;flex-wrap:wrap}.vos-model-settings>button{margin-top:8px}
.vos-model-settings [role=alert]{color:#86341d;overflow-wrap:anywhere}.vos-model-settings output{display:block;min-height:24px}
.vos-model-settings fieldset{border:0;border-top:1px solid #bdc7c3;min-width:0;padding:16px 0 0;margin:20px 0 0}
.vos-model-settings legend{font-size:16px;font-weight:600;padding:0 8px 0 0}.vos-model-settings .model-checkbox{display:flex;align-items:center;gap:8px}
.vos-model-settings input[type=checkbox]{width:18px;height:18px;margin:0}
`;
const safeCode = (error: any) => /^[A-Z_]{2,64}$/.test(error?.code ?? "") ? error.code : "MODEL_SETTINGS_UNAVAILABLE";

export function ModelServiceSettings({ call }: any) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [provider, setProvider] = useState(modelSettingsProvider);
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(modelSettingsIssue);
  const current = useRef<AbortController | null>(null);
  const select = (value: any, preferred = provider) => {
    const row = value.providers.find((item: any) => item.provider === preferred) ?? value.providers[0];
    setProvider(row?.provider ?? "");
    setModel(row?.models.find((item: any) => item.id === value.selection?.model)?.id ?? row?.models[0]?.id ?? "");
  };
  const run = async (method: string, params: any = {}) => {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    setBusy(true); setError(""); setApiKey("");
    try {
      const value = await call(method, params, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSnapshot(value); select(value, method === "modelServiceRoute"
        ? modelSettingsProvider() : provider || value.selection?.provider);
    } catch (failure) {
      if (!controller.signal.aborted) {
        const code = safeCode(failure);
        setError(code);
        if (["MODEL_SETTINGS_WRITE_FAILED", "MODEL_SETTINGS_RECHECK_REQUIRED",
          "MODEL_SETTINGS_CHANGED", "MODEL_SETTINGS_UNAVAILABLE"].includes(code)) setSnapshot(null);
      }
    } finally { if (current.current === controller) setBusy(false); }
  };
  useEffect(() => {
    if (!modelSettingsIssue()) void run("modelServiceStatus");
    return () => current.current?.abort();
  }, [call]);
  const selected = snapshot?.providers.find((row: any) => row.provider === provider);
  const credentials = (clear = false) => void run("modelServiceCredentials", {
    provider, apiKey: clear ? null : apiKey, revision: snapshot.revision,
  });
  return <section className="vos-model-settings" aria-label="卡片与研究模型">
    <style>{styles}</style><h3>卡片与研究模型</h3>
    {!snapshot ? <output>{busy ? "正在读取设置" : error ? "待重新检查" : "未读取"}</output> : !snapshot.available
      ? <output>未接入 Host 模型设置</output> : <>
        <dl><dt>配置状态</dt><dd>{modelReadinessLabel(snapshot.readiness)}</dd>
          <dt>当前模型</dt><dd>{snapshot.selection ? `${snapshot.selection.provider} / ${snapshot.selection.model}` : "未选择"}</dd>
          <dt>连接验证</dt><dd>未检查</dd></dl>
        <label>模型提供方<select value={provider} disabled={busy || !snapshot.providers.length}
          onChange={event => { setProvider(event.target.value); setApiKey(""); setError("");
            setModel(snapshot.providers.find((row: any) => row.provider === event.target.value)?.models[0]?.id ?? ""); }}>
          {snapshot.providers.map((row: any) => <option key={row.provider} value={row.provider}>{row.name}</option>)}
        </select></label>
        {selected ? <>
          <dl><dt>API Key</dt><dd>{selected.credentialConfigured ? "Host 已配置" : "未配置"}</dd>
            <dt>修改权限</dt><dd>{selected.credentialWritable ? "可修改" : "Host 只读"}</dd></dl>
          <form autoComplete="off" onSubmit={event => { event.preventDefault(); credentials(); }}>
            <label>模型 API Key<input type="password" value={apiKey} autoComplete="new-password" spellCheck={false}
              maxLength={8192} disabled={busy || !selected.credentialWritable} onChange={event => setApiKey(event.target.value)} /></label>
            <div className="model-actions">
              <button type="submit" disabled={busy || !selected.credentialWritable || !/^[\x21-\x7e]{1,8192}$/.test(apiKey)}>
                <DeskIcon name="lock" size={16} />保存 API Key</button>
              <button type="button" disabled={busy || !selected.credentialWritable || !selected.credentialConfigured}
                onClick={() => credentials(true)}><DeskIcon name="close" size={16} />清除 API Key</button>
            </div>
          </form>
          <label>模型<select value={model} disabled={busy || !selected.models.length} onChange={event => setModel(event.target.value)}>
            {!selected.models.length ? <option value="">Host 未提供模型目录</option> : null}
            {selected.models.map((row: any) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select></label>
          <div className="model-actions"><button type="button"
            disabled={busy || !model || !selected.credentialConfigured || !snapshot.writable}
            onClick={() => void run("modelServiceSelect", { provider, model, revision: snapshot.revision })}>
            <DeskIcon name="play" size={16} />使用所选模型</button></div>
        </> : <output>Host 未提供可配置的 API 模型</output>}
        <CustomModelSettings snapshot={snapshot} busy={busy} run={run} />
      </>}
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" disabled={busy} title="重新读取模型设置" aria-label="重新读取模型设置"
      onClick={() => void run("modelServiceStatus")}><DeskIcon name="refresh" size={16} /></button>
  </section>;
}

function CustomModelSettings({ snapshot, busy, run }: any) {
  const route = snapshot.customRoute;
  const [endpoint, setEndpoint] = useState("");
  const [protocol, setProtocol] = useState("openai-completions");
  const [model, setModel] = useState("");
  const [loopback, setLoopback] = useState(false);
  useEffect(() => {
    setEndpoint(route?.endpoint ?? ""); setProtocol(route?.protocol ?? "openai-completions");
    setModel(route?.model ?? ""); setLoopback(route?.allowLoopbackHttp === true);
  }, [snapshot.revision]);
  const locked = busy || !route?.available || !route.managed || route.credentialConfigured;
  return <fieldset>
    <legend>自定义模型 API</legend>
    {!route?.available ? <output>Host 未接入自定义模型设置</output> : !route.managed
      ? <output>此路由由 Host 管理</output> : <>
        <label>接口协议<select value={protocol} disabled={locked} onChange={event => setProtocol(event.target.value)}>
          <option value="openai-completions">OpenAI 兼容 Chat Completions</option>
          <option value="openai-responses">OpenAI 兼容 Responses</option>
          <option value="anthropic-messages">Anthropic 兼容 Messages</option>
        </select></label>
        <label>API 地址<input type="url" value={endpoint} disabled={locked} maxLength={2048}
          placeholder="https://gateway.example/v1" autoComplete="off" spellCheck={false}
          onChange={event => setEndpoint(event.target.value)} /></label>
        <label>模型 ID<input value={model} disabled={locked} maxLength={160} autoComplete="off" spellCheck={false}
          onChange={event => setModel(event.target.value)} /></label>
        <label className="model-checkbox"><input type="checkbox" checked={loopback} disabled={locked}
          onChange={event => setLoopback(event.target.checked)} />允许本机回环 HTTP</label>
        {route.credentialConfigured ? <output>连接修改已锁定：API Key 已配置</output> : null}
        <div className="model-actions">
          <button type="button" disabled={locked || !endpoint || !model}
            onClick={() => void run("modelServiceRoute", { action: "save", endpoint, protocol, model,
              allowLoopbackHttp: loopback, revision: snapshot.revision })}>
            <DeskIcon name="link" size={16} />保存自定义接口</button>
          <button type="button" disabled={locked || !route.configured || snapshot.selection?.provider === "variable-os-custom"}
            onClick={() => void run("modelServiceRoute", { action: "remove", revision: snapshot.revision })}>
            <DeskIcon name="close" size={16} />删除自定义接口</button>
        </div>
      </>}
  </fieldset>;
}
