// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
/** @jsxRuntime classic */
/** @jsx SetupReact.createElement */
/** @jsxFrag SetupReact.Fragment */
import * as SetupReact from "react";
import { DeskIcon } from "./icons";
import { remoteRpc } from "./remote-client";
const { useEffect, useRef, useState } = SetupReact;

const styles = `
.vos-public-setup{box-sizing:border-box;width:min(480px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:24px;border:1px solid #87938d;border-radius:6px;background:#fff;color:#20252b;font:14px/1.5 system-ui,sans-serif;letter-spacing:0}
.vos-public-setup::backdrop{background:rgb(0 0 0 / .35)}.vos-public-setup *{box-sizing:border-box;letter-spacing:0}
.vos-public-setup h2{font-size:22px;margin:0 0 16px}.vos-public-setup output{display:block;min-height:24px}
.vos-public-setup [role=alert]{color:#86341d;overflow-wrap:anywhere}.vos-public-setup .setup-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
.vos-public-setup button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:8px 12px;border:1px solid #7b8782;border-radius:4px;font:inherit;background:#fff;color:#20252b;cursor:pointer}
.vos-public-setup button:first-child{background:#205940;color:#fff;border-color:#205940}.vos-public-setup button:disabled{opacity:.6;cursor:default}
.vos-public-setup :focus-visible{outline:3px solid #163d65;outline-offset:2px}
`;

export function publicSetupMarker(value: any) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.version === 1;
}

function status(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3 || value.enabled !== true || value.version !== 1
    || ![null, "configure", "later"].includes(value.choice)) {
    throw Object.assign(Error("Onboarding response invalid"), { code: "RESPONSE_INVALID" });
  }
  return value;
}

export function PublicOnboarding({ complete, openSection, openDesk, call = remoteRpc }: any) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement | null>(null);
  const active = useRef<AbortController | null>(null);
  const finished = useRef(false);
  const navigation = useRef({ complete, openSection, openDesk });
  navigation.current = { complete, openSection, openDesk };
  const run = async (choice?: "configure" | "later") => {
    if (active.current || finished.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setReady(false); setError("");
    try {
      await call("bootstrap", {}, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const value = status(await call(choice ? "publicOnboardingComplete" : "publicOnboardingStatus",
        choice ? { choice } : {}, { signal: controller.signal }));
      if (controller.signal.aborted) return;
      if (choice && value.choice !== choice) throw Object.assign(Error("Onboarding response mismatch"),
        { code: "RESPONSE_INVALID" });
      if (value.choice !== null) {
        finished.current = true;
        if (choice === "configure") navigation.current.openSection("variable-os-desk");
        else navigation.current.openDesk();
        navigation.current.complete();
      } else setReady(true);
    } catch (failure: any) {
      if (!controller.signal.aborted) {
        setError(/^[A-Z_]{2,64}$/.test(failure?.code ?? "") ? failure.code : "SOURCE_UNAVAILABLE");
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  };
  useEffect(() => {
    void run();
    if (!dialog.current?.open) dialog.current?.showModal();
    return () => { active.current?.abort(); active.current = null; dialog.current?.close(); };
  }, [call]);
  return <><style>{styles}</style>
    <dialog ref={dialog} className="vos-public-setup" aria-label="变量发现台设置"
      onCancel={event => event.preventDefault()}>
      <h2>变量发现台</h2>
      <output>{busy ? "正在读取设置" : error ? "设置待重新检查" : "首次设置"}</output>
      {error ? <p role="alert">{error}</p> : null}
      <div className="setup-actions">
        <button type="button" disabled={!ready || busy} onClick={() => void run("configure")}>
          <DeskIcon name="edit" size={16} />配置服务</button>
        <button type="button" disabled={!ready || busy} onClick={() => void run("later")}>稍后配置</button>
        {error ? <button type="button" disabled={busy} onClick={() => void run()}
          title="重新读取首次设置状态"><DeskIcon name="refresh" size={16} />重新检查</button> : null}
      </div>
    </dialog>
  </>;
}
