// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
/** @jsxRuntime classic */
/** @jsx VoiceReact.createElement */
/** @jsxFrag VoiceReact.Fragment */
import * as VoiceReact from "react";
import { DeskIcon } from "./icons";
import { isVoiceSettingsSnapshot, voiceSettingsIssue } from "./remote-client";
const { useEffect, useRef, useState } = VoiceReact;

const styles = `
.vos-voice-settings{font:14px/1.5 system-ui,sans-serif;letter-spacing:0;color:#20252b;max-width:760px;min-width:0;padding:16px 0;border-top:1px solid #bdc7c3}
.vos-voice-settings *{box-sizing:border-box;letter-spacing:0}.vos-voice-settings h3{font-size:16px;margin:0 0 12px}
.vos-voice-settings label{display:grid;gap:4px;margin:12px 0}
.vos-voice-settings input{min-width:0;width:100%;font:inherit;padding:8px;border:1px solid #7b8782;border-radius:4px;background:#fff;color:#20252b}
.vos-voice-settings button{font:inherit;min-height:38px;padding:6px 10px;display:inline-flex;align-items:center;gap:6px;border:1px solid #7b8782;border-radius:4px;background:#fff;color:#20252b;cursor:pointer}
.vos-voice-settings button:disabled{opacity:.65;cursor:default}.vos-voice-settings :focus-visible{outline:3px solid #163d65;outline-offset:2px}
.vos-voice-settings dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:4px}
.vos-voice-settings dt,.vos-voice-settings dd{margin:0;overflow-wrap:anywhere}.vos-voice-settings dt{color:#47525e}
.vos-voice-settings .voice-actions{display:flex;gap:8px;flex-wrap:wrap}.vos-voice-settings>button{margin-top:8px}
.vos-voice-settings [role=alert]{color:#86341d;overflow-wrap:anywhere}.vos-voice-settings output{display:block;min-height:24px}
`;
const safeCode = (error: any) => /^[A-Z_]{2,64}$/.test(error?.code ?? "") ? error.code : "VOICE_SETTINGS_UNAVAILABLE";

export function voiceSettingsLabel(value: any) {
  if (!isVoiceSettingsSnapshot(value)) return "语音配置待重新读取";
  if (!value.available) return "Host 语音凭证未接入";
  return value.configured ? "API Key 已配置 · 连接未验证 · 通话需按次授权" : "语音 API Key 未配置";
}

export function VoiceServiceSettings({ call, onStatus, readVersion = 0 }: any) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(voiceSettingsIssue);
  const current = useRef<AbortController | null>(null);
  const observedRead = useRef(readVersion);
  async function run(method: string, params = {}) {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    setBusy(true); setError(""); setApiKey(""); onStatus?.(null);
    try {
      const result = await call(method, params, { signal: controller.signal });
      if (!controller.signal.aborted) { setSnapshot(result); onStatus?.(result); }
    } catch (failure) {
      if (!controller.signal.aborted) {
        const code = safeCode(failure); setError(code);
        if (["VOICE_SETTINGS_WRITE_FAILED", "VOICE_SETTINGS_RECHECK_REQUIRED",
          "VOICE_SETTINGS_CHANGED", "VOICE_SETTINGS_UNAVAILABLE"].includes(code)) setSnapshot(null);
      }
    } finally { if (current.current === controller) setBusy(false); }
  }
  useEffect(() => {
    const explicit = observedRead.current !== readVersion;
    observedRead.current = readVersion;
    if (explicit || !voiceSettingsIssue()) void run("voiceServiceStatus");
    return () => current.current?.abort();
  }, [call, onStatus, readVersion]);
  const write = (clear = false) => void run("voiceServiceCredentials", {
    revision: snapshot.revision, apiKey: clear ? null : apiKey,
  });
  return <section className="vos-voice-settings" aria-label="豆包实时语音">
    <style>{styles}</style><h3>豆包实时语音</h3>
    {!snapshot ? <output>{busy ? "正在读取设置" : error ? "待重新检查" : "未读取"}</output>
      : !snapshot.available ? <output>未接入 Host 语音凭证</output> : <>
        <dl><dt>API Key</dt><dd>{snapshot.configured ? "Host 已配置" : "未配置"}</dd>
          <dt>连接验证</dt><dd>未检查</dd>
          <dt>通话</dt><dd>未启用</dd>
          <dt>修改权限</dt><dd>{snapshot.writable ? "可修改" : "Host 只读"}</dd></dl>
        <form autoComplete="off" onSubmit={event => { event.preventDefault(); write(); }}>
          <label>豆包语音 API Key<input type="password" value={apiKey} autoComplete="new-password"
            spellCheck={false} maxLength={512} disabled={busy || !snapshot.writable}
            onChange={event => setApiKey(event.target.value)} /></label>
          <div className="voice-actions">
            <button type="submit" disabled={busy || !snapshot.writable || !/^[A-Za-z0-9._~-]{1,512}$/.test(apiKey)}>
              <DeskIcon name="lock" size={16} />保存豆包 API Key</button>
            <button type="button" disabled={busy || !snapshot.writable || !snapshot.configured}
              onClick={() => write(true)}><DeskIcon name="close" size={16} />清除豆包 API Key</button>
          </div>
        </form>
      </>}
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" disabled={busy} aria-label="重新读取豆包设置" title="重新读取豆包设置"
      onClick={() => void run("voiceServiceStatus")}><DeskIcon name="refresh" size={16} /></button>
  </section>;
}
