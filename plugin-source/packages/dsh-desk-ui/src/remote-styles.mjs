// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export const remotePalette = [
  ["#20252b", "#ffffff"], ["#47525e", "#ffffff"], ["#ffffff", "#14644d"],
  ["#86341d", "#fff5ee"], ["#163d65", "#edf4fa"], ["#20252b", "#f2f5f4"],
];
export const remoteStyles = `
.remote-dialog{width:min(1180px,calc(100% - 24px));max-width:calc(100% - 24px);max-height:calc(100% - 24px);padding:0;border:1px solid #7b8782;border-radius:8px;background:#fff;color:#20252b;overflow:auto}
.remote-dialog::backdrop{background:rgba(0,0,0,.35)}
.vos-remote.remote-dialog-actions{display:flex;justify-content:flex-end;padding:8px 16px 0}
.vos-remote.remote-compact{padding:8px 12px;font-size:12px}
.vos-remote.remote-compact button{flex-wrap:wrap}
.vos-remote{color:#20252b;background:#ffffff;font:14px/1.5 system-ui,sans-serif;letter-spacing:0;min-width:0;max-width:1180px;margin:0 auto;padding:24px;box-sizing:border-box}
.vos-remote *{box-sizing:border-box;letter-spacing:0}
.vos-remote h2{font-size:22px;margin:0;font-weight:650}.vos-remote h3{font-size:16px;margin:16px 0 8px}
.vos-remote p{margin:8px 0}.vos-remote header,.vos-remote nav,.vos-remote .remote-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.vos-remote header{justify-content:space-between;border-bottom:1px solid #bdc7c3;padding-bottom:16px}
.vos-remote .remote-badge{color:#163d65;background:#edf4fa;padding:3px 8px;font-size:12px}
.vos-remote nav{gap:0;border-bottom:1px solid #bdc7c3;margin:18px 0}
.vos-remote button,.vos-remote input,.vos-remote select{font:inherit;min-height:38px;border:1px solid #7b8782;border-radius:4px;background:#fff;color:#20252b;padding:7px 10px;max-width:100%}
.vos-remote button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.vos-remote button:hover{background:#f2f5f4}.vos-remote button:disabled{cursor:default;color:#47525e;background:#f2f5f4}
.vos-remote button[aria-selected=true]{border-bottom:3px solid #14644d;background:#f2f5f4}
.vos-remote .remote-primary{background:#14644d;color:#fff;border-color:#14644d}.vos-remote .remote-primary:hover{background:#0c503c}
.vos-remote :focus-visible{outline:3px solid #163d65;outline-offset:2px}
.vos-remote .remote-toolbar{margin:14px 0}.vos-remote .remote-toolbar input{flex:1;min-width:160px}
.vos-remote .remote-muted,.vos-remote small{color:#47525e}
.vos-remote .remote-alert{color:#86341d;background:#fff5ee;padding:12px;border-left:3px solid #86341d;overflow-wrap:anywhere}
.vos-remote .remote-layout{display:grid;grid-template-columns:minmax(250px,1fr) minmax(280px,1.25fr);gap:24px}
.vos-remote .remote-list{list-style:none;margin:0;padding:0}.vos-remote .remote-list li{border-bottom:1px solid #bdc7c3;padding:12px 0}
.vos-remote .remote-list button{border:0;text-align:left;justify-content:space-between;width:100%;padding:4px 0;border-radius:0}
.vos-remote .remote-list strong,.vos-remote .remote-list p{overflow-wrap:anywhere}
.vos-remote .remote-list small{display:block;margin-top:4px}
.vos-remote article{min-width:0}.vos-remote article>p,.vos-remote article pre{white-space:pre-wrap;overflow-wrap:anywhere}
.vos-remote pre{font:14px/1.6 system-ui,sans-serif;max-width:100%}
.vos-remote dl{margin:12px 0;display:grid;grid-template-columns:minmax(130px,.6fr) minmax(150px,1fr);gap:0}
.vos-remote dt,.vos-remote dd{padding:10px 0;border-bottom:1px solid #bdc7c3;margin:0;overflow-wrap:anywhere}
.vos-remote dt{color:#47525e}
.vos-remote .remote-status{margin:12px 0;min-height:24px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vos-remote .remote-empty{padding:36px 0;color:#47525e}
.vos-remote .remote-settings{max-width:760px}.vos-remote .remote-compact{padding:8px 12px;font-size:12px}
@media(max-width:680px){.vos-remote{padding:16px}.vos-remote .remote-layout{grid-template-columns:minmax(0,1fr)}.vos-remote dl{grid-template-columns:minmax(110px,.7fr) minmax(0,1fr)}.vos-remote .remote-toolbar input{width:100%;flex-basis:100%}}
@media(prefers-reduced-motion:reduce){.vos-remote *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
