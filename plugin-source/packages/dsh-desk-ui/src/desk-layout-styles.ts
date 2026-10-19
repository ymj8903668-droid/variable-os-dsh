// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export const DESK_LAYOUT_CSS = `
.vos-paper-shell:has(.vos-home-layout){min-width:0}
.vos-workbench:has(>.vos-home-layout){display:flex;min-width:0}
.vos-home-layout{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;font:13px/1.6 ui-sans-serif,-apple-system,sans-serif;container-type:inline-size}
.vos-home-layout [hidden]{display:none!important}
.vos-home-toolbar{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--vos-line);background:var(--vos-paper-soft);flex:none}
.vos-home-toolbar button,.vos-home-reference button,.vos-home-drawer-header button,.vos-home-rail-tools button,.vos-home-rail-stub button{min-height:36px;padding:5px 10px;border:1px solid var(--vos-line);border-radius:4px;background:var(--vos-paper-soft);color:var(--vos-ink);cursor:pointer}
.vos-home-toolbar [aria-pressed=true],.vos-home-drawer-header [aria-pressed=true]{color:var(--vos-green);border-color:var(--vos-green);background:var(--vos-green-soft)}
.vos-home-toolbar>div[role=group]{display:flex;gap:4px;margin-right:auto}
.vos-home-pending{position:absolute;right:12px;top:100%;z-index:24;display:grid;gap:8px;width:min(320px,calc(100% - 24px));padding:12px;border:1px solid var(--vos-line-dark);background:var(--vos-paper-soft);box-shadow:0 6px 18px #0002}
.vos-home-narrow-note{padding:3px 12px;color:var(--vos-ink-soft);background:var(--vos-paper-soft)}
.vos-home-grid{position:relative;display:grid;grid-template-columns:var(--desk-rail) minmax(0,1fr);flex:1;min-height:0;overflow:hidden}
.vos-home-rail{grid-column:1;grid-row:1;display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--vos-line);background:var(--vos-paper)}
.vos-home-rail>.vos-radar-column{flex:1;padding:12px;border:0}
.vos-home-rail-tools{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--vos-line);font-size:11px}
.vos-home-rail-tools label{display:flex;align-items:center;gap:6px;min-width:0}.vos-home-rail-tools input{min-width:0;width:130px}
.vos-home-rail-stub{grid-column:1;grid-row:1;border-right:1px solid var(--vos-line);padding:8px 3px;background:var(--vos-paper-soft)}
.vos-home-rail-stub button{writing-mode:vertical-rl;padding:8px 4px}
.vos-home-workspace{grid-column:2;grid-row:1;min-height:0;min-width:0;overflow:auto;overflow-anchor:none;padding:12px}
.vos-home-reference{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:4px 0 10px;color:var(--vos-ink-soft);font-size:12px;overflow-wrap:anywhere}
.vos-home-reference button{flex:none;min-height:32px}
.vos-home-workspace>.vos-timeline-column,.vos-home-assistant>.vos-timeline-column{overflow:visible;padding:0}
.vos-home-reading{overflow:visible}.vos-home-reading>.vos-timeline-column{padding:0}
.vos-home-drawer{position:absolute;inset:0 0 0 auto;z-index:20;display:flex;flex-direction:column;width:var(--desk-drawer);min-width:0;min-height:0;border-left:1px solid var(--vos-line-dark);background:var(--vos-paper-soft);box-shadow:-8px 0 24px #0002}
.vos-home-drawer-header{display:flex;flex-wrap:wrap;align-items:start;gap:8px;padding:12px;border-bottom:1px solid var(--vos-line);flex:none;max-height:180px;overflow:auto}
.vos-home-drawer-header>div:first-child{flex:1;min-width:0}.vos-home-drawer-header strong,.vos-home-drawer-header small{display:block;overflow-wrap:anywhere}
.vos-home-drawer-header strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:15px}.vos-home-drawer-header small{color:var(--vos-ink-soft);font-size:11px}
.vos-home-drawer-header>div[role=group]{flex-basis:100%;display:flex;gap:8px}
.vos-home-details,.vos-home-decision{min-height:0;min-width:0;overflow:auto;flex:1;overflow-wrap:anywhere}
.vos-home-details>.vos-timeline-column,.vos-home-decision>.vos-decision-column{overflow:visible;border:0;padding:14px}
.vos-home-details .vos-gap-note{position:static;width:auto;writing-mode:horizontal-tb;flex-wrap:wrap;margin:0 0 12px;line-height:1.6}
.vos-home-details .vos-gap-note:before,.vos-home-details .vos-gap-note:after{width:24px;height:1px;flex:none}
.vos-home-details .vos-gap-note strong{min-width:0;overflow-wrap:anywhere}
.vos-home-grid.is-docked{grid-template-columns:var(--desk-rail) minmax(0,1fr) var(--desk-drawer)}
.vos-home-grid.is-docked>.vos-home-drawer{position:relative;grid-column:3;grid-row:1;box-shadow:none}
.vos-home-layout.is-research .vos-home-grid{grid-template-columns:var(--desk-rail) minmax(0,1fr) var(--desk-drawer)}
.vos-home-layout.is-research .vos-home-drawer{position:relative;grid-column:3;grid-row:1;box-shadow:none}
.vos-home-layout.is-research .vos-home-drawer-header{display:none}
.vos-home-layout.is-research .vos-home-grid{grid-template-rows:minmax(230px,42%) minmax(0,1fr)}
.vos-home-layout.is-research .vos-home-rail,.vos-home-layout.is-research .vos-home-rail-stub{grid-row:1/3}
.vos-home-layout.is-research .vos-home-drawer{display:contents}
.vos-home-layout.is-research .vos-home-details{grid-column:2;grid-row:2;border-top:1px solid var(--vos-line)}
.vos-home-layout.is-research .vos-home-decision{grid-column:3;grid-row:1/3;border-left:1px solid var(--vos-line)}
.vos-home-layout.has-overlay .vos-home-workspace,.vos-home-layout.has-list-overlay .vos-home-workspace{opacity:.6}
.vos-home-layout.has-list-overlay .vos-home-rail{position:absolute;inset:0 auto 0 0;z-index:21;width:min(360px,100%);box-shadow:8px 0 24px #0002}
.vos-home-layout .vos-radar-resize-handle{display:none}
.vos-home-layout.is-research .vos-radar-resize-handle{display:block;position:static;width:100%;height:26px;flex:none}
.vos-workbench.is-radar-expanded .vos-home-grid{grid-template-columns:minmax(0,1fr)}
.vos-workbench.is-radar-expanded .vos-home-rail{grid-column:1}.vos-workbench.is-radar-expanded .vos-home-workspace,.vos-workbench.is-radar-expanded .vos-home-drawer{display:none}
.vos-home-layout .vos-variable-heading>strong{font-size:18px;line-height:1.55}.vos-home-layout .vos-variable-card{border-radius:4px}.vos-home-layout .vos-radar-chart{max-width:100%}
.vos-home-layout:not(.is-research) .vos-variable-heading>strong{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;font-size:16px}
.vos-home-layout:not(.is-research) .vos-radar-chart,.vos-home-layout:not(.is-research) .vos-card-not-loaded{display:none}
.vos-home-layout .vos-variable-main{padding:12px}.vos-home-layout .vos-variable-badges{gap:4px}.vos-home-layout .vos-badge{font-size:10px}
.vos-home-card-filters{display:grid;gap:6px;margin-bottom:12px}.vos-home-card-filters>div{display:flex;gap:4px}.vos-home-card-filters button,.vos-home-version-notice button{min-height:36px;border:1px solid var(--vos-line-dark);background:var(--vos-paper-soft);padding:4px 10px;border-radius:4px;color:var(--vos-ink)}
.vos-home-card-filters [aria-pressed=true]{background:var(--vos-green-soft);color:var(--vos-green);border-color:var(--vos-green)}
.vos-home-card-filters input{width:100%;min-width:0;box-sizing:border-box;min-height:40px;border:1px solid var(--vos-line);border-radius:4px;padding:6px;background:var(--vos-paper-soft)}
.vos-home-card-filters small,.vos-home-version-notice{font-size:11px;color:var(--vos-ink-soft)}
.vos-home-version-notice{padding:8px;background:var(--vos-yellow-soft,#fff5da);border:1px solid var(--vos-line);margin-bottom:8px}
.vos-home-assistant-column{min-width:0}.vos-home-assistant-column>.vos-research-host{margin:0 0 12px}
.vos-home-assistant-column .vos-research-host>p[role=status]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:12px}
.vos-home-transcript{overflow:auto;overflow-anchor:none;max-height:clamp(130px,32dvh,390px);min-height:90px}
.vos-home-transcript:empty:before{content:'小美在这里。可以直接交代全局任务，也可以打开卡片作为参考。';display:block;padding:20px 8px;color:var(--vos-ink-soft)}
.vos-research-host[data-personal] .vos-home-transcript:empty:before{content:'小美在这里。请选择参考卡片。'}
.vos-host-model-consent{display:flex;align-items:start;gap:6px;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.vos-host-model-consent input{flex:none;width:14px;height:14px;margin:3px 0 0}
.vos-home-answer-bottom{display:block;margin:4px 0 4px auto;border:0;background:transparent;color:var(--vos-green);font-size:11px;min-height:28px}
.vos-home-voice-details summary,.vos-home-session-details summary{cursor:pointer;padding:7px 0;font-size:12px;color:var(--vos-ink-soft)}
.vos-home-session-details{padding:0 14px}.vos-home-layout .vos-host-recovery{font-size:11px}.vos-home-layout .vos-host-recovery small{display:none}
.vos-home-watch-details>summary,.vos-home-radar-options>summary{padding:9px 0;min-height:32px;box-sizing:border-box;font-size:12px;cursor:pointer;color:var(--vos-ink-soft)}
.vos-home-layout .vos-host-composer{position:sticky;bottom:0;z-index:2;background:var(--vos-paper-soft);padding:6px 0}
.vos-home-layout .is-workspace>header{display:flex;flex-wrap:wrap}.vos-home-layout .is-workspace>header>div{flex:1;min-width:140px}.vos-home-layout .is-workspace>header>button{flex:none}
.vos-home-layout .is-workspace .vos-host-conversation{display:flex;flex-direction:column;gap:7px;min-width:0}
.vos-home-layout .vos-host-markdown,.vos-home-layout .vos-host-turn>p{font-size:14px!important;line-height:1.8!important;overflow-wrap:anywhere}
.vos-home-layout .vos-host-turn small{font-size:10px}.vos-home-layout .vos-host-turn{grid-template-columns:48px minmax(0,1fr)}
@container(max-width:600px){.vos-home-reference>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vos-home-reference{flex-wrap:nowrap}.vos-home-layout .is-workspace>p[role=status]{-webkit-line-clamp:1}.vos-home-layout .vos-home-transcript-wrap{min-width:0}}
@container(max-width:600px){.vos-home-layout .is-workspace>header>div{min-width:100px}.vos-home-layout .vos-host-turn{grid-template-columns:1fr}.vos-home-layout .vos-home-transcript{max-height:160px;min-height:64px}.vos-home-layout .vos-host-wake{display:block}.vos-home-layout .vos-host-wake span{display:block}.vos-home-layout .vos-host-composer{display:flex;flex-wrap:wrap}.vos-home-layout .vos-host-composer input{flex-basis:100%}}
.vos-home-layout .vos-research-host>header{gap:10px;padding:12px}.vos-home-layout .vos-research-host>header strong{font-size:16px}.vos-home-layout .vos-host-conversation{padding:10px}.vos-home-layout .vos-host-wake{padding:6px;margin-bottom:8px;gap:4px;font-size:11px}
.vos-home-layout .vos-host-tools{padding-top:8px}.vos-home-layout .vos-radar-narration{font-size:11px}
.vos-root:has(.vos-home-layout){container-type:inline-size}
@container(max-width:600px){.vos-home-grid{grid-template-columns:32px minmax(0,1fr)}.vos-home-layout .vos-host-tools{grid-template-columns:1fr 1fr}.vos-home-layout .vos-research-host>header{flex-wrap:wrap}.vos-home-layout .vos-host-avatar{display:none}.vos-home-layout .vos-research-host>header strong{font-size:13px}.vos-home-layout .vos-host-wake button{white-space:normal}.vos-home-layout .vos-host-conversation{padding:6px}.vos-home-layout .vos-watch-panel{padding:8px}.vos-home-layout .vos-host-turn p{min-width:0}.vos-home-layout .vos-host-composer{display:flex;flex-wrap:wrap}.vos-home-layout .vos-host-composer input{flex:1 0 100%;width:100%;min-width:0;box-sizing:border-box}.vos-home-layout .vos-stage{min-width:60px}.vos-home-layout .vos-stage-panel{overflow:auto}.vos-home-layout .vos-host-tools button{padding:4px}}
.vos-home-layout .vos-host-composer input,.vos-home-layout .vos-host-composer button{min-height:40px;font-size:13px}
.vos-home-layout .vos-host-turn{font-size:14px;line-height:1.8}.vos-home-layout .vos-host-markdown{font-size:14px;line-height:1.8}
.vos-home-layout .vos-host-tools{grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}
.vos-home-layout .vos-host-tools button{min-height:36px;font-size:11px}
.vos-root:has(.vos-home-layout) .vos-topbar{height:auto;min-height:68px;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;padding:10px 14px}
.vos-root:has(.vos-home-layout) .vos-brand-title h1,.vos-root:has(.vos-home-layout) .vos-brand-title h2{font-size:24px}
.vos-root:has(.vos-home-layout) .vos-cutoff{display:none}.vos-root:has(.vos-home-layout) .vos-sync-button{height:36px;font-size:12px;padding:4px 10px}
.vos-root:has(.vos-home-layout) .vos-top-status{font-size:11px;overflow:hidden}.vos-root:has(.vos-home-layout) .vos-top-status-block{gap:4px}
@container(max-width:959px){.vos-home-toolbar{gap:4px;padding:6px}.vos-home-toolbar button{font-size:12px;padding:4px 7px}.vos-home-workspace{padding:8px}.vos-home-reference{font-size:11px}.vos-home-rail-tools input{width:100px}}
@container(max-width:600px){.vos-home-toolbar>div[role=group]{margin-right:0}.vos-home-toolbar button{min-height:40px}.vos-home-layout .vos-host-composer{grid-template-columns:minmax(0,1fr) auto auto}.vos-home-layout .vos-host-composer input{grid-column:1/-1}.vos-home-layout .vos-host-composer button{min-height:40px}.vos-home-layout .vos-host-wake{flex-wrap:wrap}.vos-home-layout .vos-host-wake span{white-space:normal}.vos-home-layout .vos-host-turn{grid-template-columns:1fr}.vos-home-layout .vos-host-voice-latency{grid-template-columns:1fr}.vos-home-reference{flex-wrap:wrap}.vos-home-layout .vos-research-host{margin:0 0 12px}.vos-home-layout .vos-watch-panel{margin:0 0 12px}.vos-home-layout .vos-column-title{flex-wrap:wrap}}
@container(max-width:800px){.vos-root:has(.vos-home-layout) .vos-topbar{grid-template-columns:minmax(0,1fr) auto}.vos-root:has(.vos-home-layout) .vos-top-status-block{grid-column:1/-1;grid-row:2}.vos-root:has(.vos-home-layout) .vos-brand-title h1,.vos-root:has(.vos-home-layout) .vos-brand-title h2{font-size:20px}}
`;
