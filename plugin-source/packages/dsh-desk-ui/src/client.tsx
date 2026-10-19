// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";

import {
  CatalystDiscardPanel,
  CatalystFunnelNav,
  CatalystSourcePanel,
  CatalystWatchPanel,
  DecisionColumn,
  DeskLoading,
  RadarColumn,
  RecordEditor,
  PublishedCardDetails,
  TimelineColumn,
} from "./desk-components";
import { DeskIcon } from "./icons";
import { providerSlots, remoteRpc } from "./remote-client";
import { IndependentResearchPanel } from "./independent-research-panel";
import { subscribeIndependentResearch, invalidateIndependentResearch } from "./independent-research-events.mjs";
import { wikiSourceMonitor } from "./wiki-source-monitor.mjs";
import { personalConnection } from "./personal-connection.mjs";
import { observePersonalVoiceReadiness } from "./personal-voice-readiness.mjs";
import { createPersonalRetirements, assertPersonalRetirement } from "./personal-retirement.mjs";
import { SourceConnectionSettings } from "./source-connection-settings";
import { ModelServiceSettings } from "./model-service-settings";
import { modelReadinessLabel } from "./model-readiness.mjs";
import { VoiceServiceSettings, voiceSettingsLabel } from "./voice-service-settings";
import { WebResearchSettings } from "./web-research-settings";
import { webReadinessLabel } from "./web-readiness.mjs";
import { WikiSourceSettings } from "./wiki-source-settings";
import { PublicOnboarding, publicSetupMarker } from "./public-onboarding";
import { createDuplexClient } from "../lib/duplex-client.js";
import { ResearchHostWatchPanel } from "./research-host-watch-panel";
import { DeskLayout } from "./desk-layout";
import { deskPendingSummary, retainDeskReference, deskCardIdentity } from "./desk-layout-state.mjs";
import { createWatchStore, WATCH_STORAGE_KEY } from "./research-host-watch-store.mjs";
import { addWatchTask, setWatchTaskStatus, observeWatchTasks, watchTaskContext, markWatchAlertQueued } from "../../../src/runtime/harness-research-host-watch.mjs";
import {
  inspectResearchHostMicrophonePermission,
  requestResearchHostMicrophoneAccess,
} from "./research-host-microphone.mjs";
import {
  createPersistentRequestSlot,
  fetchWithCsrfRecovery,
  shouldRecoverXiaomeiSessionOwnership,
  shouldRefreshCsrfPayload,
} from "./research-host-connection.mjs";
import {
  abortResearchHostRecognition,
  accumulateResearchHostTranscript,
  createResearchHostVadMonitor,
  guardResearchHostRecognition,
  isResearchHostPlaybackEcho,
  isResearchHostWakeEcho,
  stopResearchHostRecognition,
} from "./research-host-voice-runtime.mjs";
import { DESK_CSS } from "./styles";
import { createDeskRefreshController, projectionVersion, publicationSnapshotReadable } from "./desk-refresh.mjs";
import {
  DESK_RPC_METHODS,
  MUTATING_RPC_METHODS,
  RESEARCH_HOST_TOOL_POLICIES,
  buildNarrationScript,
  buildRadarShortNarration,
  buildResearchHostAgentRadarContext,
  buildResearchHostContext,
  buildResearchHostRadarIndex,
  buildPresentationCommand,
  buildHumanLabelCommand,
  buildMappingReviewCommand,
  buildRevealCommand,
  buildCaseViewModel,
  buildDeepResearchTopic,
  cardId,
  cleanDisplayText,
  collectCards,
  catalystWatchUiReducer,
  createCatalystWatchUiState,
  hydrateCatalystWatchUiState,
  createRadarUiState,
  hydrateRadarUiState,
  radarUiReducer,
  createPrototypeState,
  createResearchHostNativeNavigationGuard,
  createResearchHostState,
  createResearchHostToolRequest,
  detectResearchHostWechatChannel,
  extractResearchHostWechatQuery,
  createResearchHostVoiceState,
  deskColumnEmptyLabel,
  enqueueNarrationItem,
  normalizeDeepResearchProposal,
  normalizeAutoJudgmentDraft,
  capturePersonalDraftTarget,
  prototypeReducer,
  radarCardSourceLabel,
  radarEventIdentity,
  radarLoadingLabel,
  radarTodayDateId,
  researchHostContextChangeAction,
  researchHostConversationKey,
  scopeResearchHostQuestionContext,
  researchHostReducer,
  resolveResearchHostDossierTarget,
  getResearchHostRadarOverview,
  searchResearchHostRadar,
  researchHostVoiceReducer,
  researchHostWakeCommand,
  resolveRadarSelection,
  analysisCircuitLabel,
  analysisTokenBudgetLabel,
  liveSyncLabel,
  publishedSyncLabel,
  mergeSourceRuntimeSnapshot,
  narrationCardMatchesScope,
  newestNarrationCard,
  normalizeNarrationPreference,
  normalizeResearchHostPresentation,
  researchHostSpeechText,
  researchHostChineseSpeechText,
  researchHostRecoveryState,
  splitResearchHostSpeechChunks,
  resolveNarrationBackend,
  normalizeResearchHostWakePreference,
  sourcePipelineHealth,
  sourceQueueLabel,
  sourceAnalysisLatencyLabel,
  sourceCycleTimingsLabel,
  sourceLatestRunLabel,
  sourceRuntimeLabel,
  splitResearchHostSentences,
  sourceSyncActivity,
  translateStatus,
  deskConnectionStatus,
  personalSourceStatus,
  sourceConnectionLabel,
} from "./view-model.mjs";

const RPC_PATH = "/variable-os-desk/rpc";
const RESEARCH_HOST_AGENT_PATH = "/variable-os-desk/research-host-agent";
const TOOL_NAMES = [
  "vos_ask",
  "vos_query_inbox",
  "vos_query_casefile",
  "vos_query_evidence",
  "vos_refresh_research",
  "vos_submit_command",
  "vos_curate",
  "vos_wechat_sync",
];

const TOOL_LABELS: Record<string, string> = {
  vos_ask: "多源证据检索",
  vos_query_inbox: "读取今日变量",
  vos_query_casefile: "读取冻结卷宗",
  vos_query_evidence: "核对冻结引用",
  vos_refresh_research: "刷新研究快照",
  vos_submit_command: "提交人工记录",
  vos_curate: "整理事前要点",
  vos_wechat_sync: "同步微信线索",
};

const EMPTY_LOCAL = {
  note: "",
  label: null,
  canReveal: false,
  evidenceIds: [],
  mappingReviews: {},
  corrections: {},
  recordEditorOpen: false,
  feedback: null,
  revealState: "idle",
  autoJudgmentState: "idle",
  autoJudgmentError: null,
  autoJudgmentModel: null,
};

type DeskState = {
  overlayOpen: boolean;
  phase: "idle" | "loading" | "ready" | "error";
  busy: string | null;
  bootstrap: any;
  inbox: any;
  snapshotReadOnly: boolean;
  casefiles: Record<string, any>;
  evidenceDetails: Record<string, any>;
  evidenceDetailErrors: Record<string, any>;
  deepResearch: Record<string, any>;
  selectedCardId: string | null;
  error: any;
  projectionStatus: string | null;
  prototype: any;
  watchUi: any;
  radarUi: any;
  homeFilter: { tab: string; query: string };
  watchList: any;
  watchDetail: any;
  watchError: any;
  watchBusy: boolean;
  sourceList: any;
  sourceError: any;
  sourceBusy: boolean;
};

const CATALYST_WATCH_UI_SESSION_KEY = "variable-os-desk:catalyst-watch-ui:v1";
const RADAR_UI_SESSION_KEY = "variable-os-desk:radar-ui:v1";

function readCatalystWatchUiSession() {
  if (typeof window === "undefined") return createCatalystWatchUiState();
  try {
    const stored = window.sessionStorage.getItem(CATALYST_WATCH_UI_SESSION_KEY);
    return stored
      ? hydrateCatalystWatchUiState(JSON.parse(stored))
      : createCatalystWatchUiState();
  } catch {
    return createCatalystWatchUiState();
  }
}

function persistCatalystWatchUiSession(value: any) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      CATALYST_WATCH_UI_SESSION_KEY,
      JSON.stringify(value),
    );
  } catch {
    // Session persistence is best-effort; the read-only desk remains usable.
  }
}

function readRadarUiSession() {
  if (typeof window === "undefined") return createRadarUiState();
  try {
    const stored = window.sessionStorage.getItem(RADAR_UI_SESSION_KEY);
    return stored
      ? hydrateRadarUiState(JSON.parse(stored))
      : createRadarUiState();
  } catch {
    return createRadarUiState();
  }
}

function persistRadarUiSession(value: any) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(RADAR_UI_SESSION_KEY, JSON.stringify(value));
  } catch {
    // Session persistence is best-effort; the read-only desk remains usable.
  }
}

let state: DeskState = {
  overlayOpen: false,
  phase: "idle",
  busy: null,
  bootstrap: null,
  inbox: null,
  snapshotReadOnly: false,
  casefiles: {},
  evidenceDetails: {},
  evidenceDetailErrors: {},
  deepResearch: {},
  selectedCardId: null,
  error: null,
  projectionStatus: null,
  prototype: createPrototypeState(),
  watchUi: readCatalystWatchUiSession(),
  radarUi: readRadarUiSession(),
  homeFilter: { tab: 'all', query: '' },
  watchList: null,
  watchDetail: null,
  watchError: null,
  watchBusy: false,
  sourceList: null,
  sourceError: null,
  sourceBusy: false,
};

let csrfToken: string | null = null;
let duplexVoiceOwned = false;
let deskReadGeneration = 0;
let deskSurfaceMounts = 0;
let deskRefresh: ReturnType<typeof createDeskRefreshController> | null = null;
let deskReadRequest: Promise<void> | null = null;
let sourceHealthRequest: Promise<any> | null = null;
const casefileVersions = new Map<string, string | null>();

function loadedDeskVersion() {
  // A first-load seed still needs the normal reader's label/dossier hydration.
  if (state.snapshotReadOnly) return null;
  return projectionVersion({ ok: true, projectionStatus: state.bootstrap?.health?.projectionStatus, result: state.bootstrap?.health });
}

function observeDeskHealth(response: any) {
  const version = projectionVersion(response);
  const readableOriginals = personalConnection.isPersonal() && personalConnection.cardSource() === "published"
    && publicationSnapshotReadable(response, loadedDeskVersion(), state.bootstrap?.source?.revision);
  // A valid but newer watermark means the full snapshot is catching up. Keep
  // mutation gates closed, but do not present this recoverable race as a
  // broken projection. Explicitly stale or malformed health remains fail-closed.
  patch({
    projectionStatus: !version
      ? "PROJECTION_STALE"
      : version === loadedDeskVersion() || readableOriginals
        ? "COMPLETE"
        : "PROJECTION_REFRESHING",
  });
}
const casefileRequests = new Map<string, Promise<any>>();
const evidenceRequests = new Map<string, Promise<any>>();
let deskCardCacheInput: any = undefined;
let deskCardCacheCards: any[] = [];
let deskCardCacheById = new Map<string, any>();

function collectDeskCards(inbox: any) {
  if (deskCardCacheInput === inbox) return deskCardCacheCards;
  deskCardCacheInput = inbox;
  deskCardCacheCards = collectCards(inbox);
  deskCardCacheById = new Map(
    deskCardCacheCards
      .map((card) => [cardId(card), card] as const)
      .filter(([id]) => Boolean(id)) as Array<readonly [string, any]>,
  );
  return deskCardCacheCards;
}

function findDeskCard(inbox: any, id: string) {
  collectDeskCards(inbox);
  return deskCardCacheById.get(id) || null;
}

const listeners = new Set<(value: DeskState) => void>();

function patch(next: Partial<DeskState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener(state);
}

function dispatch(action: Record<string, unknown>) {
  patch({ prototype: prototypeReducer(state.prototype, action) });
}

function dispatchWatch(action: Record<string, unknown>) {
  const watchUi = catalystWatchUiReducer(state.watchUi, action);
  patch({ watchUi });
  persistCatalystWatchUiSession(watchUi);
}

function dispatchRadarUi(action: Record<string, unknown>) {
  const radarUi = radarUiReducer(state.radarUi, action);
  patch({ radarUi });
  persistRadarUiSession(radarUi);
}

function useDeskState() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    listeners.add(setSnapshot);
    return () => listeners.delete(setSnapshot);
  }, []);
  const readFailure = personalConnection.readFailure();
  return readFailure && !snapshot.error ? { ...snapshot, error: readFailure } : snapshot;
}

let sharedResearchHostState = createResearchHostState();
const sharedResearchHostListeners = new Set<(value: any) => void>();
const researchHostNativeNavigationGuard = createResearchHostNativeNavigationGuard();
const researchHostNativeRequestSlot = createPersistentRequestSlot();
let researchHostResumeClaimed = false;

const xiaomeiWatchStore = createWatchStore({
  storage: () => window.sessionStorage,
  lock: typeof navigator !== "undefined" && (navigator as any).locks
    ? (fn: any) => (navigator as any).locks.request(WATCH_STORAGE_KEY, fn) : undefined,
});

function useWatchSnapshot() {
  const [snapshot, setSnapshot] = useState(xiaomeiWatchStore.snapshot());
  useEffect(() => {
    const unsubscribe = xiaomeiWatchStore.subscribe(setSnapshot);
    const refresh = (event: StorageEvent) => { if (event.key === WATCH_STORAGE_KEY || event.key === null) xiaomeiWatchStore.refresh(); };
    window.addEventListener("storage", refresh);
    xiaomeiWatchStore.refresh();
    return () => { unsubscribe(); window.removeEventListener("storage", refresh); };
  }, []);
  return snapshot;
}

function enqueueWatchSpeech(alert: any) {
  const item = { key: alert.id, title: alert.title, text: alert.summary, automatic: true };
  patchNarration({ unlocked: true, queue: [...narrationState.queue, item], message: `关注变化待播：${alert.title}` });
  pumpNarrationQueue();
}

async function stopInactiveWatchSpeech(watch: any) {
  const id = narrationState.active?.key;
  if (!id?.startsWith("watch-alert-")) return;
  const alert = watch.alerts.find((a: any) => a.id === id);
  if (!alert?.taskIds.some((taskId: string) => watch.tasks.some((t: any) => t.id === taskId && t.status === "active" && t.expiresAt > Date.now()))) {
    await stopNarration("关注已暂停、取消或到期，短播已停止");
  }
}

async function updateWatchTaskStatus(id: string, status: string) {
  const saved = await xiaomeiWatchStore.transact((watch: any) => setWatchTaskStatus(watch, id, status));
  if (saved) await stopInactiveWatchSpeech(xiaomeiWatchStore.snapshot().state);
  return saved;
}

async function observeWatchReminders(index: any[], projectionStatus: string, { busy = false } = {}) {
  if (!personalConnection.allows("researchAssistant")) return;
  if (!xiaomeiWatchStore.snapshot().state.tasks.length) return;
  let claimed: any = null;
  await xiaomeiWatchStore.transact((watch: any) => {
    let next = observeWatchTasks(watch, index, { projectionStatus }).state;
    const now = Date.now();
    next.alerts = next.alerts.map((a: any) => a.speechStatus === "pending" && (narrationState.autoEnabled || now - a.createdAt > 120_000)
      ? { ...a, speechStatus: "suppressed" } : a);
    const idle = !busy && !sharedResearchHostState.nativeActive && projectionStatus === "COMPLETE"
      && narrationState.supported && narrationState.unlocked && narrationState.status === "idle" && !narrationState.queue.length
      && (typeof document === "undefined" || document.visibilityState !== "hidden");
    if (idle) {
      claimed = next.alerts.find((a: any) => a.speechStatus === "pending");
      if (claimed) next = markWatchAlertQueued(next, claimed.id);
    }
    return next;
  }, () => { if (claimed) enqueueWatchSpeech(claimed); });
  await stopInactiveWatchSpeech(xiaomeiWatchStore.snapshot().state);
}

function setSharedResearchHostState(update: any) {
  const next = typeof update === "function" ? update(sharedResearchHostState) : update;
  if (!next || next === sharedResearchHostState) return;
  sharedResearchHostState = next;
  for (const listener of sharedResearchHostListeners) listener(sharedResearchHostState);
}

function useSharedResearchHostState() {
  const [snapshot, setSnapshot] = useState(sharedResearchHostState);
  useEffect(() => {
    sharedResearchHostListeners.add(setSnapshot);
    setSnapshot(sharedResearchHostState);
    return () => sharedResearchHostListeners.delete(setSnapshot);
  }, []);
  return [snapshot, setSharedResearchHostState] as const;
}

type NarrationItem = {
  card?: string;
  audition?: boolean;
  key: string;
  title: string;
  text: string;
  automatic?: boolean;
  researchHostTurnId?: string;
};

type NarrationState = {
  replyEnabled: boolean;
  supported: boolean;
  hostAvailable: boolean;
  backend: "browser" | "macos-say" | "kokoro-local" | null;
  selectedVoice?: string;
  voices?: { id: string; label: string; available?: boolean }[];
  unlocked: boolean;
  autoEnabled: boolean;
  autoScope: "all" | "must-review";
  rate: number;
  status: "idle" | "synthesizing" | "speaking" | "paused" | "stopping" | "error";
  message: string;
  active: NarrationItem | null;
  queue: NarrationItem[];
};

const NARRATION_PREFERENCE_KEY = "variable-os-desk:narration:v1";
const RESEARCH_HOST_WAKE_PREFERENCE_KEY = "variable-os-desk:research-host-wake:v1";
const RESEARCH_HOST_SESSION_KEY = "variable-os-desk:xiaomei-agent-session:v1";
const RESEARCH_HOST_CANCELLATION_KEY = "variable-os-desk:xiaomei-cancellations:v1";
let personalResearchHostSessionId = "";

function createResearchHostSessionId() {
  const runtime = typeof globalThis !== "undefined" ? globalThis.crypto : null;
  if (typeof runtime?.randomUUID === "function") {
    return `xiaomei-agent-${runtime.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  runtime?.getRandomValues?.(bytes);
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `xiaomei-agent-${suffix || `${Date.now()}0000000000000000`}`;
}

function readOrCreateResearchHostSessionId() {
  if (personalConnection.isPersonal()) return personalResearchHostSessionId ||= createResearchHostSessionId();
  if (typeof window === "undefined") return createResearchHostSessionId();
  try {
    const stored = window.sessionStorage.getItem(RESEARCH_HOST_SESSION_KEY) || "";
    if (/^xiaomei-agent-[a-z0-9-]{16,96}$/u.test(stored)) return stored;
    const created = createResearchHostSessionId();
    window.sessionStorage.setItem(RESEARCH_HOST_SESSION_KEY, created);
    return created;
  } catch {
    return createResearchHostSessionId();
  }
}

function replaceResearchHostSessionId() {
  const created = createResearchHostSessionId();
  if (personalConnection.isPersonal()) return personalResearchHostSessionId = created;
  if (typeof window === "undefined") return created;
  try {
    window.sessionStorage.setItem(RESEARCH_HOST_SESSION_KEY, created);
  } catch {
    // The in-memory replacement still restores the native Agent for this page.
  }
  return created;
}

function createResearchHostCancellationId() {
  const runtime = typeof globalThis !== "undefined" ? globalThis.crypto : null;
  if (typeof runtime?.randomUUID === "function") return `cancel-${runtime.randomUUID()}`;
  const bytes = new Uint8Array(16);
  runtime?.getRandomValues?.(bytes);
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `cancel-${suffix || `${Date.now()}0000000000000000`}`;
}

function normalizeResearchHostCancellationReceipt(value: any) {
  const receiptId = String(value?.receiptId || "").slice(0, 128);
  if (!/^cancel-[a-z0-9-]{16,112}$/u.test(receiptId)) return null;
  const component = (name: string) => cleanDisplayText(value?.components?.[name], "not-active").slice(0, 40);
  const optionalLatency = (candidate: any) => {
    if (candidate === null || candidate === undefined || candidate === "") return null;
    const latency = Number(candidate);
    return Number.isFinite(latency) ? Math.max(0, Math.round(latency)) : null;
  };
  return {
    receiptId,
    trigger: cleanDisplayText(value?.trigger, "user").slice(0, 40),
    status: cleanDisplayText(value?.status, "cancelled").slice(0, 40),
    requestedAt: Number.isFinite(Number(value?.requestedAt)) ? Math.max(0, Math.floor(Number(value.requestedAt))) : Date.now(),
    latencyMs: optionalLatency(value?.latencyMs),
    localStopLatencyMs: optionalLatency(value?.localStopLatencyMs),
    cancellationConvergenceMs: optionalLatency(value?.cancellationConvergenceMs),
    serverTurnEndSeq: Number.isSafeInteger(value?.serverTurnEndSeq) ? value.serverTurnEndSeq : null,
    components: {
      recognition: component("recognition"),
      model: component("model"),
      tool: component("tool"),
      tts: component("tts"),
    },
  };
}

function readResearchHostCancellationReceipts(sessionId: string) {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(`${RESEARCH_HOST_CANCELLATION_KEY}:${sessionId}`) || "[]");
    return (Array.isArray(parsed) ? parsed : [])
      .map(normalizeResearchHostCancellationReceipt)
      .filter(Boolean)
      .slice(-20);
  } catch {
    return [];
  }
}

function persistResearchHostCancellationReceipt(sessionId: string, rawReceipt: any) {
  if (typeof window === "undefined") return;
  const receipt = normalizeResearchHostCancellationReceipt(rawReceipt);
  if (!receipt) return;
  try {
    const current = readResearchHostCancellationReceipts(sessionId)
      .filter((entry: any) => entry.receiptId !== receipt.receiptId);
    window.sessionStorage.setItem(
      `${RESEARCH_HOST_CANCELLATION_KEY}:${sessionId}`,
      JSON.stringify([...current, receipt].slice(-20)),
    );
  } catch {
    // Cancellation remains visible in-memory when session storage is unavailable.
  }
}

async function consumeResearchHostAgentResponse(
  response: Response,
  onEvent: (event: any) => void | Promise<void>,
) {
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || "小美原生 Agent 连接失败");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      await onEvent(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) await onEvent(JSON.parse(buffer));
}

function readNarrationPreference() {
  if (typeof window === "undefined") return normalizeNarrationPreference();
  try {
    return normalizeNarrationPreference(JSON.parse(window.sessionStorage.getItem(NARRATION_PREFERENCE_KEY) || "null"));
  } catch {
    return normalizeNarrationPreference();
  }
}

function persistNarrationPreference(enabled: boolean, scope: "all" | "must-review") {
  if (personalConnection.isPersonal()) return;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      NARRATION_PREFERENCE_KEY,
      JSON.stringify(normalizeNarrationPreference({ enabled, scope })),
    );
  } catch {
    // Session persistence is a convenience; narration must remain usable without it.
  }
}

function readResearchHostWakePreference() {
  if (typeof window === "undefined") return normalizeResearchHostWakePreference();
  try {
    return normalizeResearchHostWakePreference(
      JSON.parse(window.sessionStorage.getItem(RESEARCH_HOST_WAKE_PREFERENCE_KEY) || "null"),
    );
  } catch {
    return normalizeResearchHostWakePreference();
  }
}

function persistResearchHostWakePreference(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      RESEARCH_HOST_WAKE_PREFERENCE_KEY,
      JSON.stringify(normalizeResearchHostWakePreference({ enabled })),
    );
  } catch {
    // Session persistence is optional; the visible wake switch remains authoritative.
  }
}

function speechRuntime() {
  if (personalConnection.isPersonal()) return null;
  if (!personalConnection.allows("narration")) return null;
  if (typeof window === "undefined") return null;
  const synthesis = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  return synthesis && typeof Utterance === "function"
    ? { synthesis, Utterance }
    : null;
}

const initialNarrationPreference = readNarrationPreference();

let narrationState: NarrationState = {
  replyEnabled: false,
  supported: Boolean(speechRuntime()),
  hostAvailable: false,
  backend: speechRuntime() ? "browser" : null,
  unlocked: initialNarrationPreference.enabled,
  autoEnabled: initialNarrationPreference.enabled,
  autoScope: initialNarrationPreference.scope,
  rate: 1,
  status: "idle",
  message: initialNarrationPreference.enabled ? "自动雷达播报已开启；小美回答会播报" : "小美回答会播报；自动雷达播报未开启",
  active: null,
  queue: [],
};
let activeUtterance: SpeechSynthesisUtterance | null = null;
let narrationPollTimer: ReturnType<typeof setTimeout> | null = null;
let narrationGeneration = 0;
let narrationStopsPending = 0;
let narrationCommandTail: Promise<any> = Promise.resolve();
const narrationListeners = new Set<(value: NarrationState) => void>();
const researchHostNarrationStartListeners = new Set<(value: { turnId: string; startedAt: number }) => void>();
const researchHostNarrationEndListeners = new Set<(value: { text: string; endedAt: number }) => void>();
const autoNarrationObservedIds = new Set<string>();
const autoNarrationSpokenKeys = new Set<string>();
let autoNarrationBaselineReady = false;
let personalNarrationScopeKey: string | null = null;

function patchNarration(next: Partial<NarrationState>) {
  narrationState = { ...narrationState, ...next };
  for (const listener of narrationListeners) listener(narrationState);
}

function reportResearchHostNarrationStarted(item: NarrationItem) {
  if (!item.researchHostTurnId) return;
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  for (const listener of researchHostNarrationStartListeners) {
    try { listener({ turnId: item.researchHostTurnId, startedAt }); } catch { /* telemetry never blocks speech */ }
  }
}

function reportResearchHostNarrationEnded(item: NarrationItem) {
  const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  for (const listener of researchHostNarrationEndListeners) {
    try { listener({ text: item.text, endedAt }); } catch { /* telemetry never blocks speech */ }
  }
}

function useNarrationState() {
  const [snapshot, setSnapshot] = useState(narrationState);
  useEffect(() => {
    narrationListeners.add(setSnapshot);
    return () => narrationListeners.delete(setSnapshot);
  }, []);
  return snapshot;
}

function chineseVoice(synthesis: SpeechSynthesis) {
  const voices = synthesis.getVoices?.() || [];
  return voices.find((voice) => /^zh-CN$/i.test(voice.lang))
    || voices.find((voice) => /^zh/i.test(voice.lang))
    || null;
}

function configureNarrationBackend(value: any) {
  const personal = personalConnection.isPersonal();
  if (personal && personalNarrationScopeKey !== personalConnection.scopeKey()) {
    if (personalNarrationScopeKey !== null) void stopNarration("信源已切换，播报已停止");
    personalNarrationScopeKey = personalConnection.scopeKey();
    autoNarrationObservedIds.clear(); autoNarrationSpokenKeys.clear(); autoNarrationBaselineReady = false;
    patchNarration({ autoEnabled: false, replyEnabled: false, unlocked: false, queue: [],
      message: "本机播报未开启" });
  }
  const hostAvailable = value?.available === true
    && (personal ? ["macos-say"] : ["macos-say", "kokoro-local"]).includes(value?.backend);
  const backend = resolveNarrationBackend({
    hostAvailable,
    hostBackend: value?.backend,
    browserAvailable: Boolean(speechRuntime()),
  });
  patchNarration({
    supported: Boolean(backend),
    hostAvailable,
    backend,
    selectedVoice: value?.selectedVoice,
    voices: value?.voices,
    ...(!backend && narrationState.status === "idle"
      ? { message: "当前环境没有可用的本机语音" }
      : {}),
  });
}

function clearNarrationPoll() {
  if (narrationPollTimer) clearTimeout(narrationPollTimer);
  narrationPollTimer = null;
}

function markAutomaticNarration(item: NarrationItem) {
  if (!item.automatic) return;
  autoNarrationSpokenKeys.add(item.key);
  while (autoNarrationSpokenKeys.size > 200) {
    const oldest = autoNarrationSpokenKeys.values().next().value;
    if (!oldest) break;
    autoNarrationSpokenKeys.delete(oldest);
  }
}

function completeNarration(item: NarrationItem, generation: number) {
  if (generation !== narrationGeneration) return;
  reportResearchHostNarrationEnded(item);
  activeUtterance = null;
  clearNarrationPoll();
  markAutomaticNarration(item);
  patchNarration({
    status: "idle",
    active: null,
    message: narrationState.queue.length ? "正在准备下一条播报" : "卷宗播报完成",
  });
  pumpNarrationQueue();
}

function failNarration(generation: number, message = "语音播报未完成，可以重新播放") {
  if (generation !== narrationGeneration) return;
  activeUtterance = null;
  clearNarrationPoll();
  patchNarration({ status: "error", active: null, queue: [], message });
}

function runHostNarrationCommand(params: any) {
  // The local speaker is one resource. An old start/stop acknowledgement must
  // settle before a replacement command can reach it, even when RPC is slow.
  const next = narrationCommandTail.then(() => rpc("narration", params));
  narrationCommandTail = next.catch(() => undefined);
  return next.catch(() => ({ ok: false, error: { code: "NARRATION_TRANSPORT_FAILED" } }));
}

function scheduleHostNarrationPoll(item: NarrationItem, generation: number) {
  clearNarrationPoll();
  narrationPollTimer = setTimeout(async () => {
    narrationPollTimer = null;
    const result = await rpc("narration", { action: "status" });
    if (generation !== narrationGeneration) return;
    if (!result.ok) {
      failNarration(generation);
      return;
    }
    const status = result.result?.state;
    if (status === "idle") {
      completeNarration(item, generation);
      return;
    }
    if (status === "error") {
      failNarration(generation, "本机语音未完成，可以重新播放");
      return;
    }
    if (status === "paused" && narrationState.status !== "paused") {
      patchNarration({ status: "paused", message: `播报已暂停：${item.title}` });
    }
    if (status === "speaking" && narrationState.status !== "speaking") {
      if (narrationState.status === "synthesizing") reportResearchHostNarrationStarted(item);
      patchNarration({ status: "speaking", message: `正在播报：${item.title}` });
    }
    scheduleHostNarrationPoll(item, generation);
  }, 500);
}

async function startHostNarration(item: NarrationItem, generation: number) {
  const result = await runHostNarrationCommand(personalConnection.isPersonal() ? {
    action: item.audition ? "preview" : "start", rate: narrationState.rate, audioUseAllowed: true,
    ...(!item.audition ? { text: item.text, card: item.card } : {}),
  } : {
    action: "start",
    text: item.text,
    rate: narrationState.rate,
  });
  if (generation !== narrationGeneration) {
    // The cancelling owner has already queued its stop behind this start.
    // Sending another unowned stop here would kill the replacement reply.
    return;
  }
  if (!result.ok || !["speaking", "synthesizing"].includes(result.result?.state)) {
    failNarration(generation, friendlyError(result.error));
    return;
  }
  if (result.result.state === "speaking") reportResearchHostNarrationStarted(item);
  else patchNarration({ status: "synthesizing", message: `正在本地合成：${item.title}` });
  scheduleHostNarrationPoll(item, generation);
}

function pumpNarrationQueue() {
  if (duplexVoiceOwned) return;
  if (narrationStopsPending || activeUtterance || narrationState.active
    || narrationState.status === "paused" || narrationState.status === "error") return;
  const item = narrationState.queue[0];
  if (!item) return;
  const runtime = speechRuntime();
  const backend = resolveNarrationBackend({
    hostAvailable: narrationState.hostAvailable,
    hostBackend: narrationState.backend,
    browserAvailable: Boolean(runtime),
  });
  if (!backend) {
    patchNarration({
      supported: false,
      status: "error",
      message: "当前环境没有可用的本机语音",
      active: null,
      queue: [],
    });
    return;
  }

  const generation = ++narrationGeneration;
  if (backend === "macos-say" || backend === "kokoro-local") {
    patchNarration({
      backend,
      status: backend === "kokoro-local" ? "synthesizing" : "speaking",
      active: item,
      queue: narrationState.queue.slice(1),
      message: `正在播报：${item.title}`,
    });
    void startHostNarration(item, generation);
    return;
  }
  if (!runtime) {
    failNarration(generation, "当前环境没有可用的浏览器语音");
    return;
  }
  const utterance = new runtime.Utterance(item.text);
  activeUtterance = utterance;
  utterance.lang = "zh-CN";
  utterance.rate = narrationState.rate;
  const voice = chineseVoice(runtime.synthesis);
  if (voice) utterance.voice = voice;
  utterance.onstart = () => {
    if (generation !== narrationGeneration) return;
    reportResearchHostNarrationStarted(item);
    patchNarration({
      status: "speaking",
      active: item,
      message: `正在播报：${item.title}`,
    });
  };
  utterance.onend = () => {
    if (generation !== narrationGeneration) return;
    completeNarration(item, generation);
  };
  utterance.onerror = () => {
    if (generation !== narrationGeneration) return;
    failNarration(generation);
  };
  patchNarration({
    status: "speaking",
    active: item,
    queue: narrationState.queue.slice(1),
    message: `正在播报：${item.title}`,
  });
  runtime.synthesis.speak(utterance);
}

async function stopNarration(message = "播报已停止") {
  const generation = ++narrationGeneration;
  narrationStopsPending += 1;
  clearNarrationPoll();
  activeUtterance = null;
  speechRuntime()?.synthesis.cancel();
  // Clear only audio owned at cancellation time, not new streamed sentences
  // that arrive while the Host is acknowledging the stop.
  patchNarration({ status: "stopping", active: null, queue: [], message: "正在停止播报" });
  try {
    if (["macos-say", "kokoro-local"].includes(narrationState.backend || "") && narrationState.hostAvailable) {
      const result = await runHostNarrationCommand({ action: "stop" });
      if (!result.ok || result.result?.state !== "idle") {
        if (generation === narrationGeneration) {
          patchNarration({ status: "error", active: null, queue: [], message: friendlyError(result.error) });
        }
        return false;
      }
    }
    if (generation !== narrationGeneration) return false;
    patchNarration({ status: "idle", message });
    return true;
  } finally {
    narrationStopsPending -= 1;
    if (!narrationStopsPending && narrationState.status !== "error") pumpNarrationQueue();
  }
}

async function enqueueDeskNarration(view: any, local: any, automatic = false) {
  const item = { ...buildNarrationScript(view, local), automatic, card: view.id } as NarrationItem;
  if (!item.key || !item.text) return;
  if (!narrationState.supported) {
    patchNarration({ status: "error", message: "当前环境没有可用的本机语音" });
    return;
  }
  if (
    automatic
    && (autoNarrationSpokenKeys.has(item.key)
      || narrationState.active?.key === item.key
      || narrationState.queue.some((queued) => queued.key === item.key))
  ) return;
  if (!automatic && !await stopNarration("正在准备卷宗播报")) return;
  const queue = enqueueNarrationItem(narrationState.queue, item, { force: !automatic });
  patchNarration({
    unlocked: true,
    queue,
    message: automatic ? `新变量已加入播报队列：${item.title}` : `正在准备播报：${item.title}`,
  });
  pumpNarrationQueue();
}

async function enqueueRadarShortNarration(view: any, automatic = true) {
  const item = { ...buildRadarShortNarration(view), automatic, card: view.id } as NarrationItem;
  if (!item.key || !item.text) return;
  if (!narrationState.supported) {
    patchNarration({ status: "error", message: "当前环境没有可用的本机语音" });
    return;
  }
  if (
    automatic
    && (autoNarrationSpokenKeys.has(item.key)
      || narrationState.active?.key === item.key
      || narrationState.queue.some((queued) => queued.key === item.key))
  ) return;
  if (!automatic && !await stopNarration("正在准备最新雷达短播报")) return;
  // New radar arrivals are already deduplicated above. Do not use the generic
  // three-item conversation queue: it silently evicts unspoken radar cards.
  const queue = automatic
    ? [...narrationState.queue, item]
    : enqueueNarrationItem(narrationState.queue, item, { force: true });
  patchNarration({
    unlocked: true,
    queue,
    message: automatic
      ? `新雷达短播报已加入队列：${item.title}`
      : `正在播报最新雷达：${item.title}`,
  });
  pumpNarrationQueue();
}

function enqueueResearchHostSentence(text: string, sequence: number, researchHostTurnId?: string, audition = false) {
  const chunks = splitResearchHostSpeechChunks(researchHostChineseSpeechText(researchHostSpeechText(text)));
  if (!chunks.length || !narrationState.supported || narrationState.status === "error") return;
  const items: NarrationItem[] = chunks.map((sentence, index) => ({
    key: `research-host:${Date.now()}:${sequence}:${index}`,
    title: "小美回答",
    text: sentence,
    card: state.selectedCardId || undefined,
    audition,
    ...(researchHostTurnId ? { researchHostTurnId } : {}),
  }));
  patchNarration({
    unlocked: true,
    // Answers are ordered segments, not replaceable notification previews.
    queue: [...narrationState.queue, ...items],
    message: narrationState.active ? "小美正在继续组织回答" : "小美开始回答",
  });
  pumpNarrationQueue();
}

async function pauseNarration() {
  if (narrationState.status !== "speaking") return;
  const generation = narrationGeneration;
  if (narrationState.backend === "macos-say" || narrationState.backend === "kokoro-local") {
    const result = await runHostNarrationCommand({ action: "pause" });
    if (generation !== narrationGeneration) return;
    if (!result.ok) {
      failNarration(narrationGeneration, friendlyError(result.error));
      return;
    }
    if (result.result?.state === "idle" && narrationState.active) {
      completeNarration(narrationState.active, narrationGeneration);
      return;
    }
    if (result.result?.state !== "paused") {
      failNarration(narrationGeneration, "本机语音暂停状态异常，请重新播放");
      return;
    }
  } else {
    speechRuntime()?.synthesis.pause();
  }
  patchNarration({ status: "paused", message: `播报已暂停：${narrationState.active?.title || "当前卷宗"}` });
}

async function resumeNarration() {
  if (narrationState.status !== "paused") return;
  const generation = narrationGeneration;
  if (narrationState.backend === "macos-say" || narrationState.backend === "kokoro-local") {
    const result = await runHostNarrationCommand({ action: "resume" });
    if (generation !== narrationGeneration) return;
    if (!result.ok) {
      failNarration(narrationGeneration, friendlyError(result.error));
      return;
    }
    if (result.result?.state === "idle" && narrationState.active) {
      completeNarration(narrationState.active, narrationGeneration);
      return;
    }
    if (result.result?.state !== "speaking") {
      failNarration(narrationGeneration, "本机语音继续状态异常，请重新播放");
      return;
    }
  } else {
    speechRuntime()?.synthesis.resume();
  }
  patchNarration({ status: "speaking", message: `继续播报：${narrationState.active?.title || "当前卷宗"}` });
}

function setNarrationRate(value: number) {
  const rate = [0.8, 1, 1.2].includes(value) ? value : 1;
  patchNarration({ rate, message: `播报语速已设为 ${rate} 倍，下次播报生效` });
}

function setAutoNarration(enabled: boolean, cards: any[]) {
  autoNarrationObservedIds.clear();
  for (const card of cards) {
    const key = radarEventIdentity(card);
    if (key) autoNarrationObservedIds.add(key);
  }
  autoNarrationBaselineReady = true;
  if (!enabled) {
    if (narrationState.active?.automatic) void stopNarration("自动播报已关闭");
    else patchNarration({ queue: narrationState.queue.filter((item) => !item.automatic) });
  }
  persistNarrationPreference(enabled, narrationState.autoScope);
  patchNarration({
    autoEnabled: enabled,
    unlocked: enabled || narrationState.unlocked,
    message: enabled
      ? `自动播报已开启，之后播报${narrationState.autoScope === "must-review" ? "新进入雷达的必须复核变量" : "全部新雷达"}`
      : "自动播报已关闭",
  });
}

function setAutoNarrationScope(scope: "all" | "must-review") {
  const preference = normalizeNarrationPreference({
    enabled: narrationState.autoEnabled,
    scope,
  });
  persistNarrationPreference(preference.enabled, preference.scope);
  patchNarration({
    autoScope: preference.scope,
    message: preference.scope === "must-review"
      ? "自动播报范围：仅必须复核"
      : "自动播报范围：全部新雷达",
  });
}

async function narrateLatestRadar(cards: any[]) {
  if (state.projectionStatus !== "COMPLETE") {
    patchNarration({ message: "投影恢复后再播报新卡重点" });
    return;
  }
  const card = newestNarrationCard(cards);
  const id = cardId(card);
  if (!card || !id) {
    patchNarration({ message: "当前没有可播报的雷达" });
    return;
  }
  await enqueueRadarShortNarration(radarNarrationView(card), false);
}

function radarNarrationView(card: any) {
  // All short-script fields are part of the verified inbox snapshot. Full
  // dossier loading stays lazy and is not a prerequisite for automatic speech.
  return { ...buildCaseViewModel(card, null), sourceLabel: radarCardSourceLabel(card),
    eventIdentity: radarEventIdentity(card) };
}

function observeAutoNarration(cards: any[]) {
  if (state.projectionStatus !== "COMPLETE") return;
  if (!autoNarrationBaselineReady) {
    if (!cards.length) return;
    for (const card of cards) {
      const eventKey = radarEventIdentity(card);
      if (eventKey) autoNarrationObservedIds.add(eventKey);
    }
    autoNarrationBaselineReady = true;
    return;
  }
  if (!narrationState.autoEnabled || !narrationState.unlocked) return;
  for (const card of cards) {
    const id = cardId(card);
    if (!id) continue;
    const eventKey = radarEventIdentity(card);
    if (eventKey && !autoNarrationObservedIds.has(eventKey)) {
      autoNarrationObservedIds.add(eventKey);
      if (narrationCardMatchesScope(card, narrationState.autoScope)) {
        void enqueueRadarShortNarration(radarNarrationView(card), true);
      }
    }
  }
}

function friendlyError(error: any) {
  const terminalReasons: Record<string, string> = {
    max_tokens: "模型返回长度上限终止，本次没有生成新卡片。",
    tool_calls: "模型以工具调用结束，本次没有生成新卡片。",
    provider_aborted: "模型返回中止状态，本次没有生成新卡片。",
    provider_error: "模型返回错误状态，本次没有生成新卡片。",
    missing_finish: "模型响应缺少结束事件，本次没有生成新卡片。",
    invalid_finish: "模型结束状态无法识别，本次没有生成新卡片。",
    after_finish: "模型结束后仍有响应，本次没有生成新卡片。",
    assembly_mismatch: "模型结束状态不一致，本次没有生成新卡片。",
  };
  if (error?.code === "LLM_OUTPUT_INVALID" && error.outputStage === "incomplete" &&
    typeof error.terminalReason === "string" && Object.hasOwn(terminalReasons, error.terminalReason)) {
    return terminalReasons[error.terminalReason];
  }
  const outputStages: Record<string, string> = {
    incomplete: "模型输出未完整结束，本次没有生成新卡片。",
    tool_call: "模型返回了不允许的工具调用，本次没有生成新卡片。",
    empty: "模型未返回可用正文，本次没有生成新卡片。",
    json: "模型输出不是有效 JSON，本次没有生成新卡片。",
    text_limit: "模型正文超过长度上限，本次没有生成新卡片。",
    stream_limit: "模型响应超过接收上限，本次没有生成新卡片。",
    schema: "模型结果未通过结构或引用校验，本次没有生成新卡片。",
  };
  if (["LLM_OUTPUT_INVALID", "LLM_OUTPUT_UNSAFE", "LLM_OUTPUT_TOO_LARGE",
    "LLM_EVIDENCE_COVERAGE_INVALID"].includes(error?.code) &&
    typeof error?.outputStage === "string" && Object.hasOwn(outputStages, error.outputStage)) {
    return outputStages[error.outputStage];
  }
  const messages: Record<string, string> = {
    RPC_UNREACHABLE: "变量台暂时无法连接，请在设置中检查本机服务。",
    INVALID_RPC_RESPONSE: "变量台收到无法识别的响应。",
    PROJECTION_STALE: "研究投影已滞后，当前只保留最后一次可用快照。",
    PROJECTION_REPAIR_FAILED: "研究投影重建失败，账本仍安全保留，请查看诊断。",
    PROJECTION_STALE_AFTER_COMMIT: "记录已写入账本，但投影尚未更新。",
    HEAD_CONFLICT: "其他页面刚刚更新了这条记录，请重新读取后再提交。",
    EXPOSURE_CONFLICT: "事前信息边界已经变化，请重新读取卷宗后再判断。",
    INPUT_REF_MISMATCH: "卷宗与账本引用不一致，请重新读取后再提交。",
    INVALID_COMMAND: "提交内容未通过校验，请检查研判说明和判断依据。",
    INVALID_PRESENTATION: "卷宗尚未满足已呈现条件，请停留片刻后再提交。",
    PRESENTATION_NOT_RECORDED: "尚未完成卷宗呈现登记，请重新打开后再提交。",
    CSRF_INVALID: "本机会话凭证已失效，请重新打开变量台。",
    SYNC_IN_PROGRESS: "微信同步正在进行，请等待当前请求结束。",
    LIVE_SYNC_PARTIAL: "部分信源未完成同步，请查看上方管线状态。",
    LIVE_SYNC_DISPOSED: "实时同步控制器尚未运行，请重启变量台服务。",
    SOURCE_SYNC_FAILED: "信源扫描或后台 Grok 分析未完成，请查看管线诊断。",
    WECHAT_SYNC_FAILED: "微信实时同步未完成，本地已有信源仍会继续处理。",
    DEEP_RESEARCH_IN_PROGRESS: "另一条联网补证正在进行，请稍后再试。",
    DEEP_RESEARCH_INVALID_INPUT: "当前卷宗还不能生成有效的联网检索主题。",
    DEEP_RESEARCH_UNAVAILABLE: "Trading Wiki Deep Research 当前不可用，请检查本机研究库配置。",
    DEEP_RESEARCH_TIMEOUT: "联网补证超时，当前证据链没有变化。",
    DEEP_RESEARCH_CONTRACT_INVALID: "联网补证响应未通过只读契约校验。",
    DEEP_RESEARCH_OUTPUT_INVALID: "研究结果未通过输出边界校验，本次结果未交付。",
    RESEARCH_DISCLOSURE_UNAVAILABLE: "研究输出验证记录不可用，本次结果未交付。",
    MODEL_CONSENT_REQUIRED: "本次操作尚未获得模型使用授权。",
    MODEL_SELECTION_REQUIRED: "请先在 Host 中选择自己的模型。",
    LLM_OUTPUT_INVALID: "模型结果未通过结构或引用校验，本次没有生成新卡片。",
    GENERATION_LEASE_EXPIRED: "本次分析已超时，未激活新卡片。",
    GENERATION_ACTIVATION_UNKNOWN: "卡片激活状态待核对，尚未确认本次写入结果。",
    INTAKE_REQUIRED: "请先同步授权资料，再分析下一条。",
    HORIZON_OUT_OF_RANGE: "已公布的交易日历不足以生成观察窗口，本次未调用模型。",
    DEEP_RESEARCH_FAILED: "联网补证未完成，当前证据链没有变化；可稍后重新检索。",
    AUTO_JUDGMENT_IN_PROGRESS: "另一份自动研判正在生成，请稍后再试。",
    AUTO_JUDGMENT_INVALID_INPUT: "当前冻结卷宗不足以生成自动研判草稿。",
    AUTO_JUDGMENT_TIMEOUT: "自动研判超时，当前人工草稿没有变化。",
    AUTO_JUDGMENT_OUTPUT_INVALID: "模型草稿未通过冻结证据校验，当前人工草稿没有变化。",
    AUTO_JUDGMENT_FAILED: "自动研判未完成，当前人工草稿没有变化。",
    AUTO_JUDGMENT_CAPACITY: "研究输出验证记录已达上限，本次结果未交付。",
    NARRATION_UNAVAILABLE: "当前环境没有可用的本机语音。",
    NARRATION_INVALID_INPUT: "卷宗播报内容未通过长度或语速校验。",
    NARRATION_START_FAILED: "本机语音启动失败，可以重新播放。",
    NARRATION_CONTROL_FAILED: "本机语音控制失败，请停止后重试。",
    NARRATION_BUSY: "本机语音仍在合成或播放，请先停止再重试。",
    NARRATION_SELECTION_REFUSED: "音色暂时不能切换，请停止播报并选择已安装的本机音色。",
    ANALYSIS_CIRCUIT_OPEN: "后台 Grok 连续失败，分析已暂停并将在冷却后自动试探恢复。",
    ANALYSIS_TOKEN_BUDGET_EXHAUSTED: "今日后台 Grok 分析预算已用完，待上海时间次日自动恢复。",
    PERSONAL_WORKSPACE_REQUIRED: "个人账本未配置：Host 需要显式设置 VARIABLE_OS_PERSONAL_DESK_ROOT。",
    PERSONAL_WORKSPACE_INVALID: "个人账本目录校验失败，未读取其他目录。",
    SOURCE_CHANGED: "信源或授权已变化，旧结果已清空。",
    WIKI_SOURCE_CHANGED: "Wiki 信源已变化，请重新确认后再试。",
    SOURCE_UNAVAILABLE: "当前信源授权无法复核，旧结果已清空。",
    FORBIDDEN_SCOPE: "当前资料无读取权限，请重新选择资料或检查授权。",
    PUBLISHED_CARD_REQUIRED: "当前发布项仅有摘录；收到完整业主原卡后才能开展个人研究。本次未调用模型。",
    SOURCE_DISCONNECTED: "信源状态连接已断开，旧结果已清空；请刷新页面后重连。",
    INTAKE_LIMIT: "授权资料超过单次接收上限，本轮未保存。",
    INTAKE_INCOMPLETE: "分页资料不完整，本轮未保存。",
    INTAKE_LEASE_EXPIRED: "本轮接收已超时，结果未保存。",
    NOT_FOUND: "当前没有可展示的后续结果。",
  };
  return messages[error?.code] || "操作未完成，请在设置中查看诊断。";
}

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  options: { signal?: AbortSignal; csrfRecovery?: boolean; wikiSourceRevision?: string } = {},
) {
  if (["deepResearch", "deepResearchStatus"].includes(method) ||
    method === "autoJudgment" && personalConnection.isPersonal() && personalConnection.cardSource() === "ima") {
    try { options = { ...options, wikiSourceRevision: wikiSourceMonitor.researchRevision(options.wikiSourceRevision) }; }
    catch { return { ok: false, error: { code: "WIKI_SOURCE_CHANGED", message: "Wiki 信源已变化，请重新确认后再试。" } }; }
  }
  if (personalConnection.isPersonal()) return personalConnection.call(method, params, options);
  if (!DESK_RPC_METHODS.has(method)) {
    return {
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "变量台未开放这个操作" },
    };
  }
  // Retained drafts stay editable, but stale/unknown projections must never
  // send formal commands (including presentation and mapping) or model drafts.
  if ((method === "command" || method === "autoJudgment") && state.projectionStatus !== "COMPLETE") {
    return { ok: false, error: { code: "PROJECTION_STALE", message: "投影不可用，正式操作已暂停" } };
  }
  if (MUTATING_RPC_METHODS.has(method) && !csrfToken) {
    if (options.csrfRecovery !== false && !options.signal?.aborted) {
      const refreshed = await rpc(
        "bootstrap",
        { asOfWatermark: "latest" },
        { signal: options.signal, csrfRecovery: false },
      );
      if (refreshed.ok && csrfToken) {
        return rpc(method, params, { ...options, csrfRecovery: false });
      }
    }
    return {
      ok: false,
      error: { code: "CSRF_INVALID", message: "bootstrap token missing" },
    };
  }
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (MUTATING_RPC_METHODS.has(method) && csrfToken) {
      headers["x-variable-os-csrf"] = csrfToken;
    }
    if (options.wikiSourceRevision) headers["x-variable-os-wiki-revision"] = options.wikiSourceRevision;
    const response = await fetch(RPC_PATH, {
      method: "POST",
      headers,
      body: JSON.stringify({ method, params }),
      signal: options.signal,
    });
    const payload = await response.json().catch(() => ({
      ok: false,
      error: { code: "INVALID_RPC_RESPONSE" },
    }));
    if (options.wikiSourceRevision) wikiSourceMonitor.researchRevision(options.wikiSourceRevision);
    if (method === "bootstrap" && payload?.result?.csrfToken) {
      csrfToken = payload.result.csrfToken;
      delete payload.result.csrfToken;
    }
    if (
      MUTATING_RPC_METHODS.has(method)
      && options.csrfRecovery !== false
      && !options.signal?.aborted
      && shouldRefreshCsrfPayload(payload)
    ) {
      const refreshed = await rpc(
        "bootstrap",
        { asOfWatermark: "latest" },
        { signal: options.signal, csrfRecovery: false },
      );
      if (refreshed.ok && csrfToken) {
        return rpc(method, params, { ...options, csrfRecovery: false });
      }
    }
    return payload;
  } catch (error: any) {
    if (error?.code === "WIKI_SOURCE_CHANGED") return { ok: false, error: { code: error.code, message: error.code } };
    if (options.signal?.aborted || error?.name === "AbortError") {
      return {
        ok: false,
        error: { code: "REQUEST_ABORTED", message: "本次只读请求已取消" },
      };
    }
    return {
      ok: false,
      error: { code: "RPC_UNREACHABLE", message: error?.message },
    };
  }
}

async function refreshResearchHostCsrf(signal?: AbortSignal) {
  const refreshed = await rpc(
    "bootstrap",
    { asOfWatermark: "latest" },
    { signal, csrfRecovery: false },
  );
  if (!refreshed.ok || !csrfToken || signal?.aborted) return false;
  configureNarrationBackend(refreshed.result?.diagnostics?.localNarration);
  return true;
}

async function fetchResearchHostEndpoint(path: string, init: RequestInit = {}) {
  if (personalConnection.isPersonal()) {
    if (path !== RESEARCH_HOST_AGENT_PATH) throw Object.assign(Error("RESEARCH_UNAVAILABLE"), { code: "RESEARCH_UNAVAILABLE" });
    const params = JSON.parse(String(init.body || "{}"));
    return personalConnection.agentFetch(params, {
      signal: init.signal, wikiSourceRevision: personalConnection.cardSource() === "ima" && !["cancel", "approve"].includes(params.action)
        ? wikiSourceMonitor.researchRevision() : undefined,
    });
  }
  if (!personalConnection.allows("researchAssistant")) {
    throw Object.assign(Error("RESEARCH_UNAVAILABLE"), { code: "RESEARCH_UNAVAILABLE" });
  }
  return fetchWithCsrfRecovery({
    signal: init.signal,
    request: () => {
      const headers = new Headers(init.headers || {});
      headers.set("x-variable-os-csrf", csrfToken || "");
      return fetch(path, { ...init, headers });
    },
    refresh: () => refreshResearchHostCsrf(init.signal),
  });
}

async function loadCasefileForCard(id: string, generation = deskReadGeneration) {
  if (!id || state.projectionStatus !== "COMPLETE") return null;
  const version = loadedDeskVersion();
  if (state.casefiles[id] && casefileVersions.get(id) === version) return state.casefiles[id];
  const key = `${generation}:${id}`;
  let request = casefileRequests.get(key);
  if (!request) {
    request = rpc("casefile", { card: id, asOfWatermark: "latest" });
    casefileRequests.set(key, request);
  }
  try {
    const result = await request;
    if (generation !== deskReadGeneration || !result.ok) return null;
    if (state.projectionStatus !== "COMPLETE" || version !== loadedDeskVersion()) return null;
    casefileVersions.set(id, version);
    patch({ casefiles: { ...state.casefiles, [id]: result.result } });
    return result.result;
  } finally {
    casefileRequests.delete(key);
  }
}

async function loadEvidenceDetail(evidence: any, signal?: AbortSignal) {
  const id = typeof evidence?.id === "string" ? evidence.id : "";
  if (!id || state.evidenceDetails[id]) return state.evidenceDetails[id] || null;
  let request = signal ? null : evidenceRequests.get(id);
  if (!request) {
    request = rpc("evidence", { id }, { signal });
    if (!signal) evidenceRequests.set(id, request);
  }
  patch({
    evidenceDetailErrors: Object.fromEntries(
      Object.entries(state.evidenceDetailErrors).filter(([key]) => key !== id),
    ),
  });
  dispatch({ type: "set-activity", message: "正在核对完整受控引用", tone: "active" });
  try {
    const result = await request;
    if (signal?.aborted || result.error?.code === "REQUEST_ABORTED") return null;
    if (!result.ok) {
      patch({
        evidenceDetailErrors: {
          ...state.evidenceDetailErrors,
          [id]: result.error || { code: "EVIDENCE_DETAIL_FAILED" },
        },
      });
      dispatch({ type: "set-activity", message: "完整引用暂不可读，已保留冻结摘录", tone: "error" });
      return null;
    }
    patch({
      evidenceDetails: { ...state.evidenceDetails, [id]: result.result },
    });
    dispatch({ type: "set-activity", message: "已核对完整来源引用", tone: "done" });
    return result.result;
  } finally {
    if (!signal) evidenceRequests.delete(id);
  }
}

let catalystWatchReadGeneration = 0;

function catalystWatchUiEnabled() {
  return state.bootstrap?.featureFlags?.watchCatalystUiEnabled === true;
}

async function readCatalystWatchDetail(
  watchId: string,
  generation = catalystWatchReadGeneration,
) {
  if (
    !watchId ||
    !catalystWatchUiEnabled() ||
    state.projectionStatus !== "COMPLETE"
  ) return null;
  const result = await rpc("catalystWatchDetail", {
    watchId,
    asOfWatermark: "latest",
  });
  if (generation !== catalystWatchReadGeneration) return null;
  if (!result.ok) {
    patch({ watchBusy: false, watchError: result.error });
    if (result.error?.code === "PROJECTION_STALE") {
      patch({ projectionStatus: "PROJECTION_STALE" });
    }
    return null;
  }
  patch({ watchDetail: result.result, watchError: null });
  return result.result;
}

async function readCatalystWatchList() {
  if (
    !catalystWatchUiEnabled() ||
    state.projectionStatus !== "COMPLETE"
  ) return;
  const generation = ++catalystWatchReadGeneration;
  const filters = state.watchUi.filters;
  patch({ watchBusy: true, watchError: null });
  const result = await rpc("catalystWatchList", {
    ...filters,
    limit: 10,
    asOfWatermark: "latest",
  });
  if (generation !== catalystWatchReadGeneration) return;
  if (!result.ok) {
    patch({ watchBusy: false, watchError: result.error });
    if (result.error?.code === "PROJECTION_STALE") {
      patch({ projectionStatus: "PROJECTION_STALE" });
    }
    return;
  }
  const nextWatchUi = catalystWatchUiReducer(state.watchUi, {
    type: "hydrate-list",
    items: result.result?.items,
  });
  patch({
    watchList: result.result,
    watchUi: nextWatchUi,
    watchDetail: nextWatchUi.selectedWatchId === state.watchDetail?.watchId
      ? state.watchDetail
      : null,
    watchBusy: false,
    watchError: null,
  });
  persistCatalystWatchUiSession(nextWatchUi);
  if (nextWatchUi.selectedWatchId) {
    await readCatalystWatchDetail(nextWatchUi.selectedWatchId, generation);
  }
}

async function readCatalystSourceList() {
  if (
    !catalystWatchUiEnabled() ||
    state.projectionStatus !== "COMPLETE"
  ) return;
  const generation = ++catalystWatchReadGeneration;
  const filters = state.watchUi.filters;
  patch({ sourceBusy: true, sourceError: null });
  const result = await rpc("catalystSourceList", {
    ...filters,
    // The raw layer is still bounded by the RPC's MAX_LIMIT=50, but one page
    // must not hide a normal fifteen-item intake from the operator.
    limit: 50,
    asOfWatermark: "latest",
  });
  if (generation !== catalystWatchReadGeneration) return;
  if (!result.ok) {
    patch({ sourceBusy: false, sourceError: result.error });
    if (result.error?.code === "PROJECTION_STALE") {
      patch({ projectionStatus: "PROJECTION_STALE" });
    }
    return;
  }
  const nextWatchUi = catalystWatchUiReducer(state.watchUi, {
    type: "hydrate-source-list",
    items: result.result?.items,
  });
  patch({
    sourceList: result.result,
    watchUi: nextWatchUi,
    sourceBusy: false,
    sourceError: null,
  });
  persistCatalystWatchUiSession(nextWatchUi);
}

async function selectCatalystFunnel(mode: string) {
  dispatchWatch({ type: "select-funnel", mode });
  if (mode === "WATCH") await readCatalystWatchList();
  if (mode === "ALL") await readCatalystSourceList();
}

async function filterCatalystWatches(name: string, value: string) {
  dispatchWatch({ type: "set-filter", name, value });
  if (state.watchUi.mode === "ALL") await readCatalystSourceList();
  else await readCatalystWatchList();
}

function selectCatalystSource(sourceItemId: string) {
  dispatchWatch({ type: "select-source", sourceItemId });
}

async function selectCatalystWatch(watchId: string) {
  dispatchWatch({ type: "select-watch", watchId });
  patch({ watchDetail: null, watchError: null });
  await readCatalystWatchDetail(watchId);
}

let wikiSourceGeneration = 0;
const personalResearchControllers = new Map<string, AbortController>();
const personalResearchRuns = new Map<string, number>();

function changeDeepResearchScope(id: string, scope: "selected" | "library") {
  personalResearchRuns.set(id, (personalResearchRuns.get(id) ?? 0) + 1);
  personalResearchControllers.get(id)?.abort();
  personalResearchControllers.delete(id);
  patchDeepResearch(id, { scope, phase: "idle", result: null, error: null });
}

function patchDeepResearch(cardIdValue: string, next: Record<string, unknown>) {
  patch({
    deepResearch: {
      ...state.deepResearch,
      [cardIdValue]: {
        phase: "idle",
        result: null,
        error: null,
        ...(state.deepResearch[cardIdValue] || {}),
        ...next,
      },
    },
  });
}

async function loadDeepResearchStatus(cardIdValue: string) {
  if (personalConnection.isPersonal()) return;
  const generation = wikiSourceGeneration;
  if (!cardIdValue || state.deepResearch[cardIdValue]?.phase === "loading") return;
  const response = await rpc("deepResearchStatus", { card: cardIdValue });
  if (generation !== wikiSourceGeneration) return;
  if (!response.ok || !response.result) return;
  if (state.deepResearch[cardIdValue]?.phase === "loading") return;
  const proposal = normalizeDeepResearchProposal(response.result);
  if (!proposal) return;
  patchDeepResearch(cardIdValue, {
    phase: "ready",
    result: proposal,
    error: null,
  });
}

async function runDeepResearch(view: any, force = false, signal?: AbortSignal,
  consent?: { modelUseAllowed: boolean; webSearchAllowed: boolean; researchScope?: "selected" | "library"; apiSupplementAllowed?: boolean }) {
  const generation = wikiSourceGeneration;
  const id = String(view?.id || "");
  if (!id || state.deepResearch[id]?.phase === "loading") return;
  const personal = personalConnection.isPersonal();
  if (personal && consent?.modelUseAllowed !== true) {
    patchDeepResearch(id, { phase: "error", error: friendlyError({ code: "MODEL_CONSENT_REQUIRED" }) });
    return;
  }
  const controller = new AbortController();
  const run = (personalResearchRuns.get(id) ?? 0) + 1;
  personalResearchRuns.set(id, run);
  const topic = buildDeepResearchTopic(view);
  if (controller) {
    personalResearchControllers.set(id, controller);
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  }
  patchDeepResearch(id, { phase: "loading", error: null, ...(personal ? { result: null } : {}) });
  dispatch({
    type: "set-activity",
    message: personal ? "正在读取授权资料并由所选 Host 模型补证" : "Trading Wiki 正在联网检索并由 DeepSeek 综合补证",
    tone: "active",
  });
  const response = await rpc("deepResearch", {
    card: id,
    topic,
    force,
    ...(personal ? consent : {}),
  }, { signal }).finally(() => {
    if (personalResearchControllers.get(id) === controller) personalResearchControllers.delete(id);
  });
  if (generation !== wikiSourceGeneration || personalResearchRuns.get(id) !== run) return;
  if (signal?.aborted || response.error?.code === "REQUEST_ABORTED") {
    patchDeepResearch(id, { phase: "idle", error: null });
    dispatch({ type: "set-activity", message: "联网补证已取消，当前证据链没有变化", tone: "done" });
    return;
  }
  if (!response.ok) {
    const message = friendlyError(response.error);
    patchDeepResearch(id, { phase: "error", error: message });
    dispatch({ type: "set-activity", message, tone: "error" });
    return;
  }
  const proposal = normalizeDeepResearchProposal(response.result);
  if (!proposal || personal && personalConnection.cardSource() === "ima" &&
    (proposal.readScope?.coverage !== (consent?.researchScope === "library" ? "IMA_LIBRARY_SEARCH" : "SELECTED_IMA_DOCUMENT") ||
      consent?.researchScope === "library" && (proposal.readScope.query !== topic ||
        proposal.readScope.apiSupplementAllowed !== (consent.apiSupplementAllowed === true) ||
        proposal.readScope.webSearchAllowed !== consent.webSearchAllowed))) {
    const message = friendlyError({ code: "DEEP_RESEARCH_CONTRACT_INVALID" });
    patchDeepResearch(id, { phase: "error", error: message });
    dispatch({ type: "set-activity", message, tone: "error" });
    return;
  }
  patchDeepResearch(id, { phase: "ready", result: proposal, error: null });
  dispatch({
    type: "set-activity",
    message: `${proposal.status === "partial" ? "补证返回 partial" : "联网补证完成"}，新增 ${proposal.evidence.length} 条待人工复核引用`,
    tone: "success",
  });
}

async function selectDeskCard(id: string | null) {
  if (personalConnection.isPersonal() && id !== state.selectedCardId) cancelPersonalJudgment();
  if (!id) {
    patch({ selectedCardId: null });
    dispatch({ type: "select-card", cardId: null });
    dispatch({ type: "set-activity", message: "当前筛选没有可展开的变量", tone: "idle" });
    return;
  }
  patch({ selectedCardId: id });
  dispatch({ type: "select-card", cardId: id });
  const card = findDeskCard(state.inbox, id);
  const fallbackTitle = card?.eventSummary || "变量卷宗";
  if (!state.casefiles[id]) {
    dispatch({ type: "set-activity", message: `正在展开${fallbackTitle}`, tone: "active" });
  }
  await loadCasefileForCard(id);
  if (state.selectedCardId === id) {
    const title = cleanDisplayText(
      state.casefiles[id]?.variable?.title || fallbackTitle,
      "变量卷宗",
    );
    dispatch({ type: "set-activity", message: `已切换到${title}`, tone: "active" });
  }
  void loadDeepResearchStatus(id);
}

function readDesk(reason: "initial" | "reread" | "diagnose" | "auto" = "initial") {
  if (deskReadRequest) return deskReadRequest;
  if (state.busy) return Promise.resolve();
  deskReadRequest = readDeskSnapshot(reason).finally(() => { deskReadRequest = null; });
  return deskReadRequest;
}

async function readDeskSnapshot(reason: "initial" | "reread" | "diagnose" | "auto") {
  const generation = ++deskReadGeneration;
  const firstLoad = state.phase === "idle";
  patch({
    phase: firstLoad ? "loading" : state.phase,
    busy: reason === "reread" || reason === "auto" ? "正在检查新线索" : "正在读取卷宗",
    error: null,
  });
  if (reason !== "auto") {
    dispatch({
      type: "set-activity",
      message: reason === "reread" ? "正在重读当前投影，不触发数据源写入" : "正在读取冻结卷宗，不替你下结论",
      tone: "active",
    });
  }
  const bootstrapResult = await rpc("bootstrap", { asOfWatermark: "latest" });
  if (generation !== deskReadGeneration) return;
  if (!bootstrapResult.ok) {
    patch({
      phase: "error",
      busy: null,
      error: bootstrapResult.error,
      projectionStatus: "PROJECTION_STALE",
    });
    dispatch({ type: "set-activity", message: "卷宗读取失败，请检查本机服务", tone: "error" });
    return;
  }
  // Recheck the lightweight watermark after download. An older bootstrap cannot
  // override a newer health observation or reopen a stale projection gate.
  const ima = personalConnection.isPersonal() && personalConnection.cardSource() === "ima";
  const currentHealth = deskRefresh && !ima ? await deskRefresh.readHealth({ fresh: true }) : await rpc("health", {});
  if (generation !== deskReadGeneration) return;
  // Output-device availability is independent of the projection. Keep voice
  // selection usable without admitting stale dossiers or any business writes.
  configureNarrationBackend(bootstrapResult.result?.diagnostics?.localNarration);
  const nextVersion = projectionVersion({ ok: true, projectionStatus: bootstrapResult.projectionStatus, result: bootstrapResult.result?.health });
  const currentVersion = projectionVersion(currentHealth);
  const bootstrapError = bootstrapResult.result?.bootstrapError;
  const published = personalConnection.isPersonal() && personalConnection.cardSource() === "published";
  const readableOriginals = published && publicationSnapshotReadable(currentHealth, nextVersion, bootstrapResult.sourceRevision);
  if (!nextVersion || !currentVersion || nextVersion !== currentVersion && !readableOriginals || bootstrapError) {
    // A complete snapshot can remain readable even if the ledger advanced
    // during download. Seed only an empty desk; never replace a retained
    // dossier/draft with a raced snapshot or reopen the mutation gate.
    const downloadedInbox = bootstrapResult.result?.inbox;
    const canSeed = !state.inbox && nextVersion && !bootstrapError
      && ["urgent", "mustReview", "candidatePool"].every((key) => Array.isArray(downloadedInbox?.[key]));
    patch({
      ...(canSeed ? {
        bootstrap: { ...bootstrapResult.result, sourceRuntime: mergeSourceRuntimeSnapshot(
          state.bootstrap?.sourceRuntime, bootstrapResult.result?.sourceRuntime,
        ) },
        inbox: downloadedInbox,
        snapshotReadOnly: true,
      } : {}),
      phase: "ready", busy: null,
      error: bootstrapError || null,
      projectionStatus: nextVersion && currentVersion && !bootstrapError ? "PROJECTION_REFRESHING" : "PROJECTION_STALE",
    });
    return;
  }
  const previousVersion = loadedDeskVersion();

  const bootstrap = {
    ...bootstrapResult.result,
    sourceRuntime: mergeSourceRuntimeSnapshot(
      state.bootstrap?.sourceRuntime,
      bootstrapResult.result?.sourceRuntime,
    ),
  };
  const inbox = bootstrap.inbox;
  const previousCards = published ? [] : collectDeskCards(state.inbox);
  const cards = collectDeskCards(inbox);
  const previousCardIds = previousCards.map((card) => cardId(card)).filter(Boolean).join("|");
  const nextCardIds = cards.map((card) => cardId(card)).filter(Boolean).join("|");
  const nextId = published && state.selectedCardId
    ? cards.some(card => cardId(card) === state.selectedCardId) ? state.selectedCardId : null
    : retainDeskReference(state.snapshotReadOnly ? [] : previousCards, state.selectedCardId, resolveRadarSelection(
    cards,
    previousCards,
    state.selectedCardId,
  ));
  if (
    reason === "auto"
    && previousCardIds === nextCardIds
    && state.projectionStatus === bootstrapResult.projectionStatus
    && previousVersion === nextVersion
  ) {
    patch({
      phase: "ready",
      busy: null,
      bootstrap,
      inbox,
      error: bootstrap.bootstrapError || null,
    });
    if (
      bootstrap.featureFlags?.watchCatalystUiEnabled === true &&
      state.watchUi.mode === "WATCH"
    ) {
      void readCatalystWatchList();
    }
    if (
      bootstrap.featureFlags?.watchCatalystUiEnabled === true &&
      state.watchUi.mode === "ALL"
    ) {
      void readCatalystSourceList();
    }
    return;
  }
  patch({
    bootstrap,
    inbox,
    snapshotReadOnly: false,
    selectedCardId: nextId,
    projectionStatus: bootstrapResult.projectionStatus,
    error: bootstrap.bootstrapError || null,
    casefiles: !published && (reason === "auto" || !cards.some(card => cardId(card) === nextId)) ? state.casefiles : {},
    evidenceDetails: !published && reason === "auto" ? state.evidenceDetails : {},
    evidenceDetailErrors: !published && reason === "auto" ? state.evidenceDetailErrors : {},
    ...(published ? { deepResearch: {} } : {}),
  });
  const projectionReady = bootstrapResult.projectionStatus === "COMPLETE";
  // The card collection is the usable desk snapshot. Do not keep the whole
  // desk in a connection-loading state while one selected dossier hydrates.
  // The dossier request remains read-only and may finish asynchronously.
  if (projectionReady) patch({ phase: "ready", busy: null });
  if (nextId) dispatch({ type: "select-card", cardId: nextId });
  dispatch({
    type: "hydrate-cases",
    items: cards.map((card) => ({
      cardId: cardId(card),
      label: card.currentLabel?.state || "UNLABELED",
      labelId: card.currentLabel?.id || null,
      note: card.currentLabel?.reviewNote || "",
      evidenceIds: card.currentLabel?.selectedEvidenceIds || [],
    })),
  });
  if (projectionReady && nextId && (cards.some(card => cardId(card) === nextId) || !state.casefiles[nextId])) {
    await loadCasefileForCard(nextId, generation);
  }
  if (generation !== deskReadGeneration) return;
  patch({ phase: "ready", busy: null });
  if (
    projectionReady &&
    bootstrap.featureFlags?.watchCatalystUiEnabled === true &&
    state.watchUi.mode === "WATCH"
  ) {
    void readCatalystWatchList();
  }
  if (
    projectionReady &&
    bootstrap.featureFlags?.watchCatalystUiEnabled === true &&
    state.watchUi.mode === "ALL"
  ) {
    void readCatalystSourceList();
  }
  if (nextId) void loadDeepResearchStatus(nextId);
  if (reason !== "auto") {
    dispatch({
      type: "set-activity",
      message: !projectionReady
        ? "投影与账本暂未对齐，研判入口已暂停"
        : reason === "reread"
          ? "已重读当前投影，未触发微信同步或账本写入"
          : `已整理 ${cards.length} 个变量的事前证据`,
      tone: projectionReady ? "done" : "error",
    });
  }
}

async function readSourceHealth({ reportFailure = false } = {}) {
  if (!sourceHealthRequest) sourceHealthRequest = rpc("sourceHealth", {}).finally(() => { sourceHealthRequest = null; });
  const response = await sourceHealthRequest;
  if (!response.ok) {
    if (reportFailure) {
      patch({ error: response.error });
      dispatch({ type: "set-activity", message: friendlyError(response.error), tone: "error" });
    }
    return false;
  }
  patch({
    bootstrap: {
      ...(state.bootstrap || {}),
      sourceRuntime: response.result,
    },
  });
  return true;
}

function startDeskAutoRefresh() {
  deskSurfaceMounts += 1;
  if (deskSurfaceMounts > 1) return;
  const sourceScope = personalConnection.scopeKey();
  const ima = personalConnection.isPersonal() && personalConnection.cardSource() === "ima";
  deskRefresh = createDeskRefreshController({
    intervalMs: 30_000,
    readHealth: () => ima
      ? personalConnection.allows("personalReads")
        // The Host's IMA session is bounded at 90s; leave time for its terminal reply.
        ? rpc("imaAccess", {}, { signal: AbortSignal.timeout(95_000) }) : Promise.resolve(null)
      : rpc("health", {}),
    getVersion: loadedDeskVersion,
    refresh: () => readDesk("auto"),
    onHealth: (response: any) => {
      // Metadata observation can only clear a denied IMA selection. It must
      // never drive projection refresh, hydrate content or extend read proof.
      if (ima) return;
      observeDeskHealth(response);
      if (personalConnection.isPersonal() && response?.ok && response.result?.sourceRuntime) {
        patch({ bootstrap: { ...(state.bootstrap || {}), sourceRuntime: response.result.sourceRuntime } });
      } else {
        void readSourceHealth();
      }
    },
    // Source invalidation precedes React unmounting the old surface.
    isVisible: () => document.visibilityState !== "hidden" &&
      (!personalConnection.isPersonal() ||
        personalConnection.scopeKey() === sourceScope && (!ima || Boolean(personalConnection.imaEvidenceId()))),
    subscribeReadPolicy: (listener: () => void) => personalConnection.subscribe(listener),
    subscribeVisibility: (listener: () => void) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  });
  // An SSE revision remounts the published view and already starts readDesk.
  // That download performs a fresh health check before exposing its cards.
  // An additional mount check only spends the same shared source quota twice.
  // Periodic and visibility checks remain independent of a slow download.
  const publishedDownload = personalConnection.isPersonal()
    && personalConnection.cardSource() === "published" && deskReadRequest;
  if (!publishedDownload) void deskRefresh.check();
}

function stopDeskAutoRefresh() {
  deskSurfaceMounts = Math.max(0, deskSurfaceMounts - 1);
  if (deskSurfaceMounts > 0) return;
  deskRefresh?.dispose();
  deskRefresh = null;
}

async function repairDeskProjection() {
  if (personalConnection.isPersonal() || state.busy) return;
  patch({ busy: "正在重建研究投影", error: null });
  dispatch({ type: "set-activity", message: "正在从权威账本重建可丢弃投影", tone: "active" });
  const result = await rpc("repairProjection", {});
  if (!result.ok) {
    patch({ busy: null, error: result.error });
    dispatch({ type: "set-activity", message: friendlyError(result.error), tone: "error" });
    return;
  }
  patch({ busy: null });
  await readDesk("reread");
  dispatch({ type: "set-activity", message: "投影已从权威账本恢复", tone: "success" });
}

async function refreshDeskSources() {
  if (state.busy) return;
  patch({ busy: "正在读取信源并调用后台 Grok", error: null });
  dispatch({ type: "set-activity", message: "正在读取新增信源，由后台 Grok 提取证据与催化", tone: "active" });
  const result = await rpc("sourceSync", {});
  if (!result.ok) {
    patch({ busy: null });
    await readDesk("diagnose");
    patch({ error: result.error });
    dispatch({ type: "set-activity", message: friendlyError(result.error), tone: "error" });
    return;
  }
  patch({ busy: null });
  await readDesk("reread");
  dispatch({ type: "set-activity", message: sourceSyncActivity(result.result), tone: "success" });
}

async function syncLatestSources() {
  if (state.busy) return;
  if (personalConnection.isPersonal()) {
    if (!personalConnection.allows("sourceIntake")) return;
    const selected = personalConnection.scopeKey();
    patch({ busy: "正在同步全部信源", error: null });
    dispatch({ type: "set-activity", message: "正在接收授权资料", tone: "active" });
    const response = await rpc("sourceSync", {});
    if (personalConnection.scopeKey() !== selected) return;
    patch({ busy: null });
    await readDesk("reread");
    if (personalConnection.scopeKey() !== selected) return;
    if (!response.ok) {
      patch({ error: response.error });
      dispatch({ type: "set-activity", message: friendlyError(response.error), tone: "error" });
      return;
    }
    dispatch({ type: "set-activity", message: publicationIntakeLabel(response.result), tone: "success" });
    return;
  }
  patch({ busy: "正在同步全部信源", error: null });
  dispatch({ type: "set-activity", message: "正在执行一次实时同步：外部信源一次、本地检索一次，不自动重试", tone: "active" });
  const sync = await rpc("liveSync", {});
  patch({ busy: null });
  await readDesk("reread");
  await readSourceHealth({ reportFailure: false });
  if (!sync.ok) {
    patch({ error: sync.error });
    dispatch({ type: "set-activity", message: friendlyError(sync.error), tone: "error" });
    return;
  }
  const sourceResult = sync.result?.sources?.result || {};
  dispatch({ type: "set-activity", message: sourceSyncActivity(sourceResult), tone: "success" });
}

function publicationIntakeLabel(intake: any) {
  if (intake?.status === "NOT_CONFIGURED" && intake.coverage === "UNCONFIGURED") {
    return "请先在服务配置中连接信源";
  }
  if (intake?.status === "SYNCED" && Number.isSafeInteger(intake.recordCount)) {
    return `已同步 ${intake.recordCount} 张发布卡`;
  }
  if (intake?.status === "RECEIVED" && intake.coverage === "SELECTED_IMA_METADATA" &&
    Number.isSafeInteger(intake.recordCount)) return `已接收 ${intake.recordCount} 条所选 IMA 候选 · 仅元数据`;
  if (intake?.status === "RECEIVED" && intake.coverage === "CURRENT_IMA_METADATA" &&
    Number.isSafeInteger(intake.recordCount)) return `已接收 ${intake.recordCount} 条 IMA 候选 · 仅元数据`;
  if (intake?.status === "RECEIVED" && Number.isSafeInteger(intake.recordCount)) return `已接收 ${intake.recordCount} 条授权摘录`;
  if (intake?.status === "FAILED") return "接收失败 · 本轮未更新";
  if (intake?.status === "SYNCING") return "接收尚未完成";
  return "尚未接收";
}

let personalCardRequest: AbortController | null = null;
async function generatePersonalCard() {
  if (state.busy || !personalConnection.allows("cardGeneration")) return;
  const selected = state.bootstrap?.source?.revision;
  const request = new AbortController();
  personalCardRequest = request;
  const inputLabel = personalConnection.cardSource() === "ima" ? "所选 IMA 正文" : "授权摘录";
  patch({ busy: `正在分析${inputLabel}`, error: null });
  dispatch({ type: "set-activity", message: `正在使用当前 Host 模型分析${inputLabel}`, tone: "active" });
  const response = await rpc("generateCards", { modelUseAllowed: true }, { signal: request.signal });
  if (personalCardRequest !== request) return;
  personalCardRequest = null;
  if (state.bootstrap?.source?.revision !== selected) return;
  patch({ busy: null });
  await readDesk("reread");
  if (state.bootstrap?.source?.revision !== selected) return;
  if (request.signal.aborted) {
    dispatch({ type: "set-activity", message: "本次分析已取消，个人账本已重新读取", tone: "neutral" });
  } else if (!response.ok) {
    patch({ error: response.error });
    dispatch({ type: "set-activity", message: friendlyError(response.error), tone: "error" });
  } else {
    const message = response.result?.status === "CREATED" ? "已生成 1 张个人卡片"
      : response.result?.status === "REJECTED" ? "已记录不成卡判断"
      : "已接收的资料均已分析，没有新增卡片";
    dispatch({ type: "set-activity", message, tone: "success" });
  }
}

function PersonalCardActions() {
  const snapshot = useDeskState();
  const [consent, setConsent] = useState(false);
  const candidateId = personalConnection.imaEvidenceId();
  useEffect(() => setConsent(false), [snapshot.bootstrap?.source?.revision, candidateId, snapshot.busy]);
  const available = personalConnection.allows("cardGeneration");
  const source = personalConnection.cardSource();
  const received = source === "ima" ? snapshot.bootstrap?.wikiIntake : snapshot.bootstrap?.publicationIntake;
  const candidates = received?.candidates ?? [];
  const candidate = candidates.find((row: any) => row.evidenceId === candidateId);
  return <div className="vos-personal-card-actions" role="group" aria-label={source === "published" ? "发布卡同步" : "个人成卡"}>
    <label>卡片来源<select aria-label="成卡信源" value={source} onChange={event =>
      personalConnection.selectCardSource(event.target.value)}>
      <option value="published">业主发布卡</option>
      <option value="api">API 授权摘录</option><option value="ima">IMA 知识库</option>
    </select></label>
    {source === "published" ? <span role="status">业主发布 · {publicationIntakeLabel(received)}</span> : <>
    <span role="status">个人账本 · {publicationIntakeLabel(received)}</span>
    <span role="status">{modelReadinessLabel(snapshot.bootstrap?.diagnostics?.modelService)}</span>
    <label><input type="checkbox" checked={consent} disabled={!available || Boolean(snapshot.busy)}
      onChange={event => setConsent(event.target.checked)} />{source === "ima"
        ? "允许本次将所选 IMA 正文发送给当前 Host 模型" : "允许本次将授权摘录发送给当前 Host 模型"}</label>
    {personalCardRequest ? <button type="button" onClick={() => personalCardRequest?.abort()}>
      <DeskIcon name="stop" />取消本次分析
    </button> : <button type="button" disabled={!available || !consent || Boolean(snapshot.busy) ||
      received?.status !== "RECEIVED" || !(received?.recordCount > 0)} onClick={() => {
        setConsent(false); void generatePersonalCard();
      }}><DeskIcon name="sparkle" />{source === "ima" ? "分析所选资料" : "分析下一条"}</button>}
    </>}
    {source === "ima" && candidates.length > 0 ? <div className="vos-ima-candidates">
      <label>候选资料<select aria-label="IMA 候选资料" value={candidateId ?? ""}
        onChange={event => personalConnection.selectImaEvidence(event.target.value || null)}>
        <option value="">选择资料</option>
        {candidates.map((row: any) => <option key={row.evidenceId} value={row.evidenceId}>{row.title}</option>)}
      </select></label>
      {candidate ? <output aria-label="候选资料 ID">{candidate.evidenceId}</output> : null}
      <small>{candidate ? "当前资料的个人账本 · 历史版本未知" : "尚未选择资料 · 正文未读取"}</small>
    </div> : null}
  </div>;
}

async function ensureProjectionAfterCommand(result: any) {
  if (result.ok) return true;
  if (result.error?.code !== "PROJECTION_STALE_AFTER_COMMIT" || !result.receipt) {
    return false;
  }
  dispatch({ type: "set-activity", message: "记录已入账，正在修复滞后投影", tone: "active" });
  const repaired = await rpc("repairProjection", {});
  return Boolean(repaired.ok);
}

async function ensureCardPresented(card: any) {
  if (card?.presentationInteractionId) {
    return { ok: true, card };
  }
  let presentationCommand;
  try {
    presentationCommand = buildPresentationCommand(card);
  } catch (error: any) {
    return {
      ok: false,
      error: { code: "INVALID_PRESENTATION", message: error?.message },
    };
  }
  dispatch({ type: "set-activity", message: "正在登记当前卷宗的事前呈现边界", tone: "active" });
  const presented = await rpc("command", presentationCommand);
  if (!(await ensureProjectionAfterCommand(presented))) {
    return { ok: false, error: presented.error };
  }

  const refreshed = await rpc("bootstrap", { asOfWatermark: "latest" });
  if (!refreshed.ok) {
    return { ok: false, error: refreshed.error };
  }
  const inbox = refreshed.result?.inbox;
  const id = cardId(card);
  const current = findDeskCard(inbox, id);
  if (!current?.presentationInteractionId) {
    return {
      ok: false,
      error: {
        code: "PRESENTATION_NOT_RECORDED",
        message: "presentation interaction missing after projection rebuild",
      },
    };
  }
  patch({
    bootstrap: refreshed.result,
    inbox,
    projectionStatus: refreshed.projectionStatus,
    error: refreshed.result?.bootstrapError || null,
  });
  return { ok: true, card: current };
}

async function submitJudgment(card: any) {
  const id = cardId(card);
  const local = state.prototype.cases[id] || EMPTY_LOCAL;
  if (!id || state.projectionStatus !== "COMPLETE" || !local.label || state.busy) return;
  let command;
  try {
    command = buildHumanLabelCommand(card, local);
  } catch (error: any) {
    dispatch({ type: "mark-submit-error", cardId: id, message: error?.message || "研判内容不完整" });
    return;
  }
  dispatch({ type: "mark-submitting", cardId: id });
  patch({ busy: "正在提交正式研判", error: null });
  const prepared = await ensureCardPresented(card);
  if (!prepared.ok) {
    patch({ busy: null, error: prepared.error });
    dispatch({ type: "mark-submit-error", cardId: id, message: friendlyError(prepared.error) });
    return;
  }
  command = buildHumanLabelCommand(prepared.card, local);
  const result = await rpc("command", command);
  if (!(await ensureProjectionAfterCommand(result))) {
    patch({ busy: null, error: result.error });
    dispatch({ type: "mark-submit-error", cardId: id, message: friendlyError(result.error) });
    return;
  }
  dispatch({ type: "mark-submitted", cardId: id, label: local.label });
  patch({ busy: null });
  await readDesk("reread");
  dispatch({ type: "set-activity", message: "正式研判已入账，可以揭晓后续结果", tone: "success" });
}

let personalJudgmentRequest: { controller: AbortController; scope: string; card: string } | null = null;
function cancelPersonalJudgment() {
  const request = personalJudgmentRequest;
  if (!request) return;
  personalJudgmentRequest = null;
  request.controller.abort();
  if (request.scope !== personalConnection.scopeKey()) return;
  patch({ busy: null });
  dispatch({ type: "mark-auto-judgment-error", cardId: request.card,
    message: "研判草稿生成已取消；人工草稿没有变化。" });
}

async function runAutoJudgment(view: any, signal?: AbortSignal, consent?: { modelUseAllowed: boolean }) {
  const id = String(view?.id || "");
  const personal = personalConnection.isPersonal();
  if (
    !id ||
    state.busy ||
    state.projectionStatus !== "COMPLETE" ||
    state.prototype.cases[id]?.autoJudgmentState === "loading"
  ) return;
  if (personal && (consent?.modelUseAllowed !== true || !personalConnection.allows("autoJudgment") ||
    id !== state.selectedCardId)) return;
  const request = personal ? { controller: new AbortController(), scope: personalConnection.scopeKey(), card: id } : null;
  if (request) {
    personalJudgmentRequest = request;
    signal = signal ? AbortSignal.any([signal, request.controller.signal]) : request.controller.signal;
  }
  dispatch({ type: "mark-auto-judging", cardId: id, ...(personal ? { personal: true } : {}) });
  patch({ busy: "正在生成自动研判草稿", error: null });
  const response = await rpc("autoJudgment", { card: id, ...(personal ? { modelUseAllowed: true } : {}) }, { signal });
  if (request) {
    if (personalJudgmentRequest !== request) return;
    personalJudgmentRequest = null;
    if (request.scope !== personalConnection.scopeKey() || state.selectedCardId !== id) return;
  }
  if (signal?.aborted || response.error?.code === "REQUEST_ABORTED") {
    patch({ busy: null });
    dispatch({ type: "mark-auto-judgment-error", cardId: id, message: "研判草稿生成已取消；人工草稿没有变化。" });
    return;
  }
  if (!response.ok) {
    const message = friendlyError(response.error);
    patch({
      busy: null,
      ...(response.error?.code === "PROJECTION_STALE"
        ? { error: response.error, projectionStatus: "PROJECTION_STALE" }
        : {}),
    });
    dispatch({ type: "mark-auto-judgment-error", cardId: id, message });
    return;
  }
  const proposal = normalizeAutoJudgmentDraft(
    response.result,
    view.evidence.map((item: any) => item.id),
  );
  if (!proposal || personal && response.result?.card !== id) {
    const message = friendlyError({ code: "AUTO_JUDGMENT_OUTPUT_INVALID" });
    patch({ busy: null });
    dispatch({ type: "mark-auto-judgment-error", cardId: id, message });
    return;
  }
  dispatch({
    type: "apply-auto-judgment",
    cardId: id,
    ...(personal ? { personal: true } : {}),
    draft: proposal.draft,
    modelLabel: proposal.modelLabel,
  });
  patch({ busy: null });
}

async function submitMappingReview(card: any, mapping: any, review: string, correction = "") {
  const id = cardId(card);
  if (!id || state.projectionStatus !== "COMPLETE" || state.busy) return;
  let command;
  try {
    command = buildMappingReviewCommand(card, mapping, review, correction);
  } catch (error: any) {
    dispatch({ type: "set-activity", message: error?.message || "映射复核内容不完整", tone: "error" });
    return;
  }
  patch({ busy: `正在复核${mapping.name || "映射"}`, error: null });
  const prepared = await ensureCardPresented(card);
  if (!prepared.ok) {
    patch({ busy: null, error: prepared.error });
    dispatch({ type: "set-activity", message: friendlyError(prepared.error), tone: "error" });
    return;
  }
  command = buildMappingReviewCommand(prepared.card, mapping, review, correction);
  const result = await rpc("command", command);
  if (!(await ensureProjectionAfterCommand(result))) {
    patch({ busy: null, error: result.error });
    dispatch({ type: "set-activity", message: friendlyError(result.error), tone: "error" });
    return;
  }
  dispatch({ type: "review-mapping", cardId: id, mappingId: mapping.id, review });
  patch({ busy: null });
  await readDesk("reread");
  dispatch({ type: "set-activity", message: `${mapping.name || "映射"}已${translateStatus(review)}`, tone: "success" });
}

async function revealFeedback(card: any) {
  const id = cardId(card);
  const local = state.prototype.cases[id] || EMPTY_LOCAL;
  if (!id || !local.canReveal || local.dirty || local.revealState === "loading" || state.busy) return;
  dispatch({ type: "set-feedback", cardId: id, feedback: null, revealState: "loading" });
  patch({ busy: "正在揭晓后续结果", error: null });
  dispatch({ type: "set-activity", message: "正在记录揭晓并核对后续结果", tone: "active" });
  let command;
  try {
    command = buildRevealCommand(card);
  } catch (error: any) {
    patch({ busy: null });
    dispatch({ type: "set-feedback", cardId: id, feedback: { message: error?.message }, revealState: "locked" });
    return;
  }
  const revealed = await rpc("command", command);
  if (!(await ensureProjectionAfterCommand(revealed))) {
    patch({ busy: null, error: revealed.error });
    dispatch({ type: "set-feedback", cardId: id, feedback: { message: friendlyError(revealed.error) }, revealState: "locked" });
    dispatch({ type: "set-activity", message: friendlyError(revealed.error), tone: "error" });
    return;
  }
  const result = await rpc("feedback", {
    card: id,
    decision: card.presentationDecisionId,
    asOfWatermark: "latest",
  });
  if (!result.ok) {
    patch({ busy: null });
    dispatch({ type: "set-feedback", cardId: id, feedback: { message: friendlyError(result.error) }, revealState: "locked" });
    dispatch({ type: "set-activity", message: "后续结果仍受揭晓状态约束", tone: "idle" });
    return;
  }
  const visibility = result.result?.outcomeVisibility || result.result?.visibility;
  dispatch({
    type: "set-feedback",
    cardId: id,
    feedback: result.result,
    revealState: visibility === "HIDDEN" ? "locked" : "ready",
  });
  patch({ busy: null });
  if (visibility !== "HIDDEN") await readDesk("reread");
  dispatch({ type: "set-activity", message: "揭晓记录已入账，后续结果核对完成", tone: "success" });
}

function useDeskStyles() {
  useEffect(() => {
    if (document.getElementById("variable-os-desk-styles")) return;
    const style = document.createElement("style");
    style.id = "variable-os-desk-styles";
    style.textContent = DESK_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
}

function useFocusTrap(open: boolean, ref: React.RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLElement>("button:not([disabled]),textarea,input")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const nestedDialog = (event.target as HTMLElement)?.closest?.('[role="dialog"],[role="alertdialog"]');
      if (nestedDialog && nestedDialog !== ref.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, ref, onClose]);
}

function cutoffLabel(value: string | null) {
  const match = String(value || "").match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : "待确认";
}

function DeskHeader({
  snapshot,
  headingLevel = 1,
  cardCount,
}: {
  snapshot: DeskState;
  headingLevel?: 1 | 2;
  cardCount: number;
}) {
  const Heading = `h${headingLevel}` as any;
  const countLabel = snapshot.projectionStatus === "COMPLETE" ? String(cardCount)
    : snapshot.inbox ? `${cardCount}（只读快照）` : "—";
  const cutoff = snapshot.bootstrap?.health?.marketCutoff;
  const sourceRuntime = snapshot.bootstrap?.sourceRuntime;
  const pipelines = personalConnection.isPersonal() ? [] : sourcePipelineHealth(sourceRuntime);
  const personalSource = personalSourceStatus({
    cardSource: personalConnection.cardSource(), source: snapshot.bootstrap?.source,
  });
  const liveSyncRunning = Boolean(sourceRuntime?.liveSync?.running);
  const connection = deskConnectionStatus({
    phase: snapshot.phase,
    projectionStatus: snapshot.projectionStatus,
    error: snapshot.error,
  });
  return <header className="vos-topbar">
    <div className="vos-brand-title"><Heading>变量发现台</Heading><span className="vos-red-seal" aria-label="审阅印章">阅</span></div>
    <div className="vos-top-status-block">
      <div className={`vos-top-status is-${connection.state}`} role="status" aria-label={`变量台${connection.label}`}><i aria-hidden="true" /><span>变量台 {connection.label}</span><b>·</b>{snapshot.bootstrap?.readScope?.coverage === "SELECTED_IMA_DOCUMENT" ? <span>当前资料变量 {countLabel}</span> : <span>变量总数 {countLabel}</span>}<b>·</b><span>{translateStatus(snapshot.projectionStatus)}</span><b>·</b><span>{sourceRuntimeLabel(sourceRuntime)}</span></div>
      <div className="vos-source-health" role="list" aria-label="信源管线健康">
        {personalConnection.isPersonal() ? <span className="vos-source-chip" role="listitem"><strong>{personalSource.label}</strong><small>{personalSource.connection}</small></span> : null}
        {pipelines.map((pipeline) => <span
          className={`vos-source-chip is-${pipeline.state}`}
          key={pipeline.id}
          role="listitem"
          title={`${pipeline.checkLabel}；${pipeline.scanLabel}；${pipeline.state === "disabled" ? "历史" : "最新"}资料 ${pipeline.sourceAgeLabel}${pipeline.errorCode ? "；请到设置查看诊断" : ""}`}
        ><i aria-hidden="true" /><strong>{pipeline.name}</strong><small>{pipeline.state === "disabled" ? "历史资料" : "资料"} {pipeline.sourceAgeLabel}</small><em>· {pipeline.scanLabel}{pipeline.analysisLabel ? ` · ${pipeline.analysisLabel}` : ""}</em></span>)}
        <span className={`vos-live-sync ${sourceRuntime?.liveSync?.lastStatus === "DEGRADED" ? "is-degraded" : ""}`}>{personalConnection.isPersonal() && personalConnection.cardSource() === "published"
          ? publishedSyncLabel(personalConnection.publicationSyncStatus()) : liveSyncLabel(sourceRuntime?.liveSync)}</span>
      </div>
    </div>
    <div className="vos-cutoff"><span>◷</span>资料截止 {cutoffLabel(cutoff)}</div>
    <button className="vos-sync-button" type="button" disabled={!personalConnection.allows("sourceIntake") || Boolean(snapshot.busy) || liveSyncRunning} onClick={() => void syncLatestSources()}><DeskIcon name="refresh" />{liveSyncRunning || snapshot.busy === "正在同步全部信源" ? "同步中" : "立即同步"}</button>
  </header>;
}

function DeskSurface({ headingLevel = 1 }: { headingLevel?: 1 | 2 }) {
  useDeskStyles();
  const snapshot = useDeskState();
  const narration = useNarrationState();
  const watchSnapshot = useWatchSnapshot();
  const editorRef = useRef<HTMLElement>(null);
  const researchHostToolSequence = useRef(0);
  const radarResizeRef = useRef<{ startX: number; expanded: boolean; moved: boolean } | null>(null);
  const radarMouseCleanupRef = useRef<(() => void) | null>(null);
  const suppressRadarResizeClickRef = useRef(false);
  const [radarExpanded, setRadarExpanded] = useState(false);
  useEffect(() => {
    // The refresh controller reads runtime health, with local/legacy fallback.
    if (state.phase === "idle") void readDesk("initial");
  }, []);
  useEffect(() => {
    startDeskAutoRefresh();
    return stopDeskAutoRefresh;
  }, []);
  const cards = useMemo(
    () => collectDeskCards(snapshot.inbox),
    [snapshot.inbox],
  );
  const researchHostRadarIndex = useMemo(
    () => buildResearchHostRadarIndex(cards, {
      watermark: snapshot.inbox?.asOfWatermark
        || snapshot.bootstrap?.snapshots?.ledgerWatermark
        || null,
      scannedAt: snapshot.bootstrap?.sourceRuntime?.connectors
        ?.map((connector: any) => connector?.lastCheckedAt)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    }),
    [
      snapshot.inbox,
      snapshot.bootstrap?.snapshots?.ledgerWatermark,
      snapshot.bootstrap?.sourceRuntime,
    ],
  );
  const views = useMemo(() => {
    const result: Record<string, any> = {};
    for (const card of cards) {
      const id = cardId(card);
      if (id && snapshot.casefiles[id]) result[id] = buildCaseViewModel(card, snapshot.casefiles[id]);
    }
    return result;
  }, [cards, snapshot.casefiles]);
  useEffect(() => {
    observeAutoNarration(cards);
  }, [cards, snapshot.projectionStatus, narration.autoEnabled, narration.autoScope]);
  const retainedCard = useRef<any>(null);
  const currentCard = cards.find((card) => cardId(card) === snapshot.selectedCardId);
  if (currentCard) retainedCard.current = currentCard;
  const selectedCard = currentCard || (cardId(retainedCard.current) === snapshot.selectedCardId ? retainedCard.current : null);
  const selectedView = snapshot.selectedCardId ? views[snapshot.selectedCardId]
    || (selectedCard && snapshot.casefiles[snapshot.selectedCardId] ? buildCaseViewModel(selectedCard, snapshot.casefiles[snapshot.selectedCardId]) : null) : null;
  const [referenceCleared, setReferenceCleared] = useState(false);
  const [layoutRequest, setLayoutRequest] = useState<any>(null);
  const newerReference = selectedCard ? cards.find(card => deskCardIdentity(card) === deskCardIdentity(selectedCard) && cardId(card) !== cardId(selectedCard)) : null;
  const local = snapshot.selectedCardId ? snapshot.prototype.cases[snapshot.selectedCardId] || EMPTY_LOCAL : EMPTY_LOCAL;
  const activeStageId = selectedView
    ? snapshot.prototype.activeStages[selectedView.id] || selectedView.activeStageId
    : "source";
  const activeTimelineNodeId = selectedView
    ? snapshot.prototype.activeTimelineNodes?.[selectedView.id] || selectedView.activeTimelineNodeId
    : null;
  const personalDesk = personalConnection.isPersonal();
  const researchHostContext = useMemo(() => buildResearchHostContext({
    view: referenceCleared ? null : selectedView,
    local,
    radarIndex: researchHostRadarIndex,
    activeStageId,
    activeTimelineNodeId,
    projectionStatus: snapshot.projectionStatus,
    readScope: snapshot.bootstrap?.readScope,
    personal: personalDesk,
    allowGlobal: true,
  }), [
    personalDesk,
    referenceCleared,
    selectedView,
    local,
    researchHostRadarIndex,
    activeStageId,
    activeTimelineNodeId,
    snapshot.projectionStatus,
    snapshot.bootstrap?.readScope,
  ]);
  const [researchHost, setResearchHost] = useSharedResearchHostState();
  const [duplexMode, setDuplexMode] = useState('duplex');
  const [duplexState, setDuplexState] = useState<any>({status:'idle',active:false,muted:false});
  const [duplexTranscript, setDuplexTranscript] = useState({question:'',answer:'',researchState:''});
  const duplexClientRef = useRef<any>(null);
  const [personalVoiceReady, setPersonalVoiceReady] = useState<any>(null);
  const [personalVoiceCheck, setPersonalVoiceCheck] = useState(0);
  useEffect(() => {
    const close = () => { void duplexClientRef.current?.hangup(); };
    const hidden = () => { if(document.visibilityState !== 'visible') close(); };
    window.addEventListener('pagehide',close);
    document.addEventListener('visibilitychange',hidden);
    return () => { window.removeEventListener('pagehide',close);document.removeEventListener('visibilitychange',hidden);close(); };
  },[]);
  const [researchHostVoice, dispatchResearchHostVoice] = useReducer(
    researchHostVoiceReducer,
    undefined,
    () => createResearchHostVoiceState({ wakePreferred: readResearchHostWakePreference().enabled, speechMode: "contextual-v1" }),
  );
  const watchBusy = Boolean(duplexState.active || researchHost.nativeActive || ["thinking", "running", "awaiting-confirmation"].includes(researchHost.phase)
    || ["listening", "thinking", "answering"].includes(researchHostVoice.phase));
  useEffect(() => {
    void observeWatchReminders(researchHostRadarIndex, snapshot.projectionStatus, { busy: watchBusy });
  }, [researchHostRadarIndex, snapshot.projectionStatus, watchBusy, watchSnapshot.state,
    narration.status, narration.autoEnabled, narration.unlocked]);
  const researchHostRecognitionRef = useRef<any>(null);
  const researchHostRecognitionModeRef = useRef<"ptt" | "wake" | null>(null);
  const researchHostPttRequestRef = useRef<object | null>(null);
  const researchHostDiscardTranscriptRef = useRef(false);
  const researchHostRecognitionFailedRef = useRef(false);
  const researchHostStreamAbortRef = useRef<AbortController | null>(null);
  const researchHostRequestGenerationRef = useRef(0);
  const researchHostToolAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const researchHostTranscriptRef = useRef("");
  const researchHostWakeTranscriptRef = useRef("");
  const researchHostSpeechPauseAtRef = useRef<number | null>(null);
  const researchHostVoiceTurnRef = useRef<{
    turnId: string;
    pauseAt: number;
    firstAudioRecorded: boolean;
  } | null>(null);
  const researchHostSentenceSequenceRef = useRef(0);
  const researchHostSessionIdRef = useRef<string>("");
  const researchHostCancellationHydratedRef = useRef(false);
  const researchHostStateRef = useRef(researchHost);
  const personalApprovalRef = useRef<any>(null);
  // The displayed selection may change while bootstrap/filter reconciliation
  // runs. Only an explicit navigation intent may cancel the conversation.
  const [hostConversationKey, setHostNavigationKey] = useState(() => ({ key: researchHostConversationKey({}) }));
  const researchHostContextScopeRef = useRef(hostConversationKey);
  const researchHostWakeArmedRef = useRef(false);
  const researchHostWakePreferredRef = useRef(readResearchHostWakePreference().enabled);
  const researchHostWakeAwaitingRef = useRef(false);
  const researchHostWakeEchoRef = useRef({ text: "", spokenAt: 0 });
  const researchHostPlaybackEchoRef = useRef<{ text: string; endedAt: number }[]>([]);
  const researchHostVoicePhaseRef = useRef("idle");
  const researchHostWakeTimerRef = useRef<number | null>(null);
  const researchHostMicrophoneGrantedRef = useRef(false);
  const researchHostMicrophoneAccessRef = useRef<Promise<any> | null>(null);
  const researchHostVadMonitorRef = useRef<any>(null);
  const researchHostCancelInFlightRef = useRef(false);
  const researchHostCancelCompletionRef = useRef<Promise<void> | null>(null);
  const interruptResearchHostWorkRef = useRef<((trigger: "context") => boolean) | null>(null);
  const [researchHostPageVisible, setResearchHostPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  const startResearchHostWakeRef = useRef<(() => void | Promise<void>) | null>(null);
  if (!researchHostSessionIdRef.current) {
    researchHostSessionIdRef.current = readOrCreateResearchHostSessionId();
  }
  const finishResearchHostVoiceAnswer = useCallback(() => {
    researchHostVoicePhaseRef.current = "idle";
    dispatchResearchHostVoice({ type: "answer-finished" });
  }, []);
  useEffect(() => {
    researchHostStateRef.current = researchHost;
  }, [researchHost]);
  const personalConversationScope = personalConnection.isPersonal()
    ? `${personalConnection.scopeKey()}:${referenceCleared ? "" : selectedView?.id || ""}` : "";
  const personalContextScope = personalConnection.isPersonal() ? researchHostContext?.scopeKey || "" : "";
  useEffect(() => {
    if (!personalConnection.isPersonal()) return;
    const abort = new AbortController();
    setPersonalVoiceReady(null);
    if (personalConnection.allows("realtimeVoice")) void observePersonalVoiceReadiness({
      signal: abort.signal, read: options => remoteRpc("personalVoiceStatus", {}, options),
      onState: setPersonalVoiceReady,
    }).catch(() => { if (!abort.signal.aborted) setPersonalVoiceReady(null); });
    return () => abort.abort();
  }, [personalConversationScope, snapshot.bootstrap?.capabilities?.realtimeVoice, personalVoiceCheck]);
  useEffect(() => {
    if (!personalConnection.isPersonal()) return;
    void duplexClientRef.current?.hangup();
    setDuplexTranscript({question:'',answer:'',researchState:''});
  }, [personalConversationScope]);
  const [personalRetirementState, setPersonalRetirementState] = useState({ pending: 0, unconfirmed: 0 });
  const [personalHistoryRestoring, setPersonalHistoryRestoring] = useState(false);
  const personalRetirements = useRef<any>(null);
  if (!personalRetirements.current) personalRetirements.current = createPersonalRetirements({
    onChange: setPersonalRetirementState,
    cancel: async (sessionId: string) => {
      const response = await personalConnection.agentFetch({ action: "cancel", sessionId },
        { signal: AbortSignal.timeout(15000) });
      const events: any[] = [];
      await consumeResearchHostAgentResponse(response, event => {
        events.push(event);
        assertPersonalRetirement(events, sessionId);
      });
      assertPersonalRetirement(events, sessionId);
      return events[0].receipt;
    },
  });
  const personalConversationRetiring = personalRetirementState.pending > 0 || personalRetirementState.unconfirmed > 0;
  const retryPersonalRetirements = useCallback(() => { void personalRetirements.current.retry(); }, []);
  const resetPersonalConversation = useCallback(() => {
    if (!personalConnection.isPersonal()) return;
    const retiredSession = researchHostSessionIdRef.current;
    researchHostNativeRequestSlot.abort();
    researchHostStreamAbortRef.current?.abort();
    researchHostStreamAbortRef.current = null;
    personalApprovalRef.current = null;
    setPersonalHistoryRestoring(false);
    researchHostRequestGenerationRef.current++;
    researchHostSessionIdRef.current = replaceResearchHostSessionId();
    setResearchHost(createResearchHostState());
    dispatchResearchHostVoice({ type: "conversation-reset" });
    if (personalConnection.hasAgentSession(retiredSession)) void personalRetirements.current.retire(retiredSession);
  }, []);
  const loadPersonalHistory = useCallback(async (researchPlan: any, cursor: string | null, options: any) => {
    if (!personalConnection.isPersonal() || referenceCleared || !selectedView?.id
      || !personalConnection.allows("researchConversation") || snapshot.projectionStatus !== "COMPLETE") {
      throw Error("RESEARCH_UNAVAILABLE");
    }
    const generation = researchHostRequestGenerationRef.current;
    const response = await fetchResearchHostEndpoint(RESEARCH_HOST_AGENT_PATH, {
      method: "POST", body: JSON.stringify({ action: "list", card: selectedView.id, researchPlan, cursor }),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(15000)]),
    });
    const events: any[] = [];
    await consumeResearchHostAgentResponse(response, event => {
      if (events.length || event.type !== "history" || JSON.stringify(event).length > 16384) {
        throw Error("HISTORY_INVALID");
      }
      events.push(event);
    });
    const page = events[0];
    if (options.signal.aborted || generation !== researchHostRequestGenerationRef.current
      || !page || Object.keys(page).some(key => !["type", "entries", "nextCursor"].includes(key))
      || !Array.isArray(page.entries) || page.entries.length > 32
      || page.nextCursor !== null && !/^[a-f0-9]{64}$/.test(page.nextCursor)
      || page.entries.some((row: any) => !row || Object.keys(row).sort().join(",") !== "sessionId,updatedAt"
        || typeof row.sessionId !== "string" || !/^xiaomei-agent-[a-z0-9-]{16,96}$/.test(row.sessionId)
        || row.updatedAt !== null && (!Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0 || row.updatedAt > 8640000000000000))
      || new Set(page.entries.map((row: any) => row.sessionId)).size !== page.entries.length) {
      throw Error("HISTORY_INVALID");
    }
    return page;
  }, [personalConversationScope, selectedView?.id, referenceCleared, snapshot.projectionStatus]);
  const restorePersonalHistory = useCallback(async (sessionId: string, consent: any, options: any) => {
    const retirements = personalRetirements.current.state();
    if (!personalConnection.isPersonal() || referenceCleared || !selectedView?.id
      || !personalConnection.allows("researchConversation") || snapshot.projectionStatus !== "COMPLETE"
      || consent?.modelUseAllowed !== true || !/^xiaomei-agent-[a-z0-9-]{16,96}$/.test(sessionId)
      || duplexVoiceOwned || state.busy || retirements.pending || retirements.unconfirmed
      || researchHostNativeRequestSlot.current() || researchHostStreamAbortRef.current
      || researchHostStateRef.current.pendingTool || researchHostCancelCompletionRef.current
      || narrationState.active || narrationState.queue.length
      || ["thinking", "answering", "listening"].includes(researchHostVoicePhaseRef.current)) return false;
    const previous = researchHostSessionIdRef.current;
    const controller = new AbortController();
    const generation = ++researchHostRequestGenerationRef.current;
    const signal = AbortSignal.any([controller.signal, options.signal, AbortSignal.timeout(60000)]);
    const current = () => !signal.aborted && generation === researchHostRequestGenerationRef.current
      && researchHostNativeRequestSlot.isCurrent(controller);
    researchHostNativeRequestSlot.attach(controller);
    researchHostStreamAbortRef.current = controller;
    setPersonalHistoryRestoring(true);
    setResearchHost(value => researchHostReducer(createResearchHostState(), { type: "sync-context", context: value.context }));
    dispatchResearchHostVoice({ type: "conversation-reset" });
    try {
      if (previous !== sessionId && personalConnection.hasAgentSession(previous)) {
        await personalRetirements.current.retire(previous);
        const status = personalRetirements.current.state();
        if (status.pending || status.unconfirmed) throw Error("RETIREMENT_UNCONFIRMED");
      }
      if (!current()) return false;
      personalResearchHostSessionId = sessionId;
      researchHostSessionIdRef.current = sessionId;
      const response = await fetchResearchHostEndpoint(RESEARCH_HOST_AGENT_PATH, {
        method: "POST", body: JSON.stringify({ action: "resume", sessionId, card: selectedView.id,
          modelUseAllowed: true, researchPlan: consent.researchPlan }), signal,
      });
      const events: any[] = [];
      let bytes = 0;
      await consumeResearchHostAgentResponse(response, event => {
        bytes += JSON.stringify(event).length;
        if (!current() || bytes > 524288 || events.length >= 2050 || event.type === "error"
          || event.type === "approval" || event.sessionId && event.sessionId !== sessionId) {
          throw Error("HISTORY_RESTORE_FAILED");
        }
        events.push(event);
      });
      if (!current()) return false;
      const final = events.at(-1);
      if (events[0]?.type !== "session" || events[0].sessionId !== sessionId || final?.type !== "done") {
        throw Error("HISTORY_RESTORE_FAILED");
      }
      const presentation = normalizeResearchHostPresentation(final.presentation, final.finalText || "", true);
      if (!presentation.text.trim()) throw Error("HISTORY_RESTORE_FAILED");
      // Old UI actions and approval grants are never replayed. Only render the
      // already-proven conversation; microphone/model/narration stay idle.
      setResearchHost(value => events.reduce((host, event) => researchHostReducer(host, {
        type: "native-event", event: event.type === "session" ? { ...event, speechMode: "contextual-v1" } : event,
      }), value));
      dispatchResearchHostVoice({ type: "answer-presentation", presentation, final: true });
      dispatchResearchHostVoice({ type: "answer-finished" });
      return true;
    } catch {
      if (current()) {
        researchHostSessionIdRef.current = replaceResearchHostSessionId();
        dispatchResearchHostVoice({ type: "failed", message: "历史未能恢复，请重新核对当前信源与授权。" });
      }
      return false;
    } finally {
      if (researchHostNativeRequestSlot.isCurrent(controller)) {
        researchHostNativeRequestSlot.clear(controller); setPersonalHistoryRestoring(false);
      }
      if (researchHostStreamAbortRef.current === controller) researchHostStreamAbortRef.current = null;
    }
  }, [personalConversationScope, selectedView?.id, referenceCleared, snapshot.projectionStatus]);
  useEffect(() => {
    if (personalConversationScope) resetPersonalConversation();
  }, [personalConversationScope, personalContextScope, resetPersonalConversation]);
  useEffect(() => {
    if (researchHostCancellationHydratedRef.current) return;
    researchHostCancellationHydratedRef.current = true;
    for (const receipt of readResearchHostCancellationReceipts(researchHostSessionIdRef.current)) {
      setResearchHost((current: any) => researchHostReducer(current, {
        type: "native-event",
        event: { type: "cancellation", receipt },
      }));
    }
  }, []);
  useEffect(() => {
    const listener = ({ text, endedAt }: { text: string; endedAt: number }) => {
      // Only existing TTS text, bounded in page memory; never audio/transcripts.
      researchHostPlaybackEchoRef.current = [
        ...researchHostPlaybackEchoRef.current.filter((item) => endedAt - item.endedAt <= 3_000),
        { text, endedAt },
      ].slice(-3);
      if (!researchHostWakeAwaitingRef.current || text !== researchHostWakeEchoRef.current.text) return;
      researchHostWakeEchoRef.current = { ...researchHostWakeEchoRef.current, spokenAt: endedAt };
    };
    researchHostNarrationEndListeners.add(listener);
    return () => researchHostNarrationEndListeners.delete(listener);
  }, []);
  useEffect(() => {
    const listener = ({ turnId, startedAt }: { turnId: string; startedAt: number }) => {
      const turn = researchHostVoiceTurnRef.current;
      if (!turn || turn.turnId !== turnId || turn.firstAudioRecorded) return;
      turn.firstAudioRecorded = true;
      dispatchResearchHostVoice({
        type: "latency-sample",
        metric: "firstVoice",
        latencyMs: Math.max(0, startedAt - turn.pauseAt),
      });
    };
    researchHostNarrationStartListeners.add(listener);
    return () => researchHostNarrationStartListeners.delete(listener);
  }, []);
  useEffect(() => {
    const supported = !personalConnection.isPersonal() && personalConnection.allows("realtimeVoice") && typeof window !== "undefined" && Boolean(
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition,
    );
    dispatchResearchHostVoice({ type: "support-changed", supported });
  }, []);
  useEffect(() => {
    researchHostVoicePhaseRef.current = researchHostVoice.phase;
  }, [researchHostVoice.phase]);
  const ensureResearchHostMicrophoneAccess = useCallback(async () => {
    if (personalConnection.isPersonal() || !personalConnection.allows("realtimeVoice")) return false;
    if (researchHostMicrophoneGrantedRef.current) return true;
    if (!researchHostMicrophoneAccessRef.current) {
      const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
      researchHostMicrophoneAccessRef.current = requestResearchHostMicrophoneAccess({ mediaDevices });
    }
    let result;
    try {
      result = await researchHostMicrophoneAccessRef.current;
    } finally {
      researchHostMicrophoneAccessRef.current = null;
    }
    if (result?.status === "granted") {
      researchHostMicrophoneGrantedRef.current = true;
      return true;
    }
    const message = result?.status === "denied"
      ? "麦克风权限未获允许；请在浏览器站点权限中允许后重试。"
      : result?.status === "unavailable"
        ? "未检测到可用麦克风；也可以直接输入问题。"
        : result?.status === "unsupported"
          ? "当前浏览器无法请求麦克风；也可以直接输入问题。"
          : "麦克风暂时无法启动；也可以直接输入问题。";
    dispatchResearchHostVoice({ type: "failed", message });
    return false;
  }, []);
  useEffect(() => {
    setResearchHost((current: any) => researchHostReducer(current, {
      type: "sync-context",
      context: researchHostContext,
    }));
  }, [researchHostContext, personalConversationScope]);
  useEffect(() => {
    if (
      researchHostResumeClaimed
      || !personalConnection.allows("researchAssistant")
      || snapshot.phase !== "ready"
      || !csrfToken
    ) return undefined;
    researchHostResumeClaimed = true;
    const controller = new AbortController();
    const resumeSessionId = researchHostSessionIdRef.current;
    const resumeGeneration = researchHostRequestGenerationRef.current;
    let settled = false;
    void (async () => {
      try {
        const response = await fetchResearchHostEndpoint(RESEARCH_HOST_AGENT_PATH, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-variable-os-csrf": csrfToken || "",
          },
          body: JSON.stringify({
            action: "resume",
            sessionId: resumeSessionId,
          }),
          signal: controller.signal,
        });
        await consumeResearchHostAgentResponse(response, (event) => {
          if (controller.signal.aborted || researchHostSessionIdRef.current !== resumeSessionId
            || readOrCreateResearchHostSessionId() !== resumeSessionId
            || researchHostRequestGenerationRef.current !== resumeGeneration) return;
          if (event.type === "error" && event.error?.code === "XIAOMEI_SESSION_NOT_FOUND") return;
          setResearchHost((current: any) => researchHostReducer(current, {
            type: "native-event",
            event: event.type === "session" ? { ...event, speechMode: "contextual-v1" } : event,
          }));
        });
      } catch (error: any) {
        if (controller.signal.aborted || error?.name === "AbortError") return;
        // Session restore is best-effort; a new native session starts on the next user request.
      } finally {
        settled = true;
      }
    })();
    return () => {
      controller.abort();
      if (!settled) researchHostResumeClaimed = false;
    };
  }, [snapshot.phase]);
  useEffect(() => {
    const nextScopeKey = hostConversationKey;
    if (researchHostContextScopeRef.current === nextScopeKey) return;
    researchHostContextScopeRef.current = nextScopeKey;
    const navigationSuppressed = researchHostNativeNavigationGuard.shouldSuppress(
      researchHostContext?.cardId || null,
    );
    const host = sharedResearchHostState;
    const contextAction = researchHostContextChangeAction({
      recognitionActive: Boolean(researchHostRecognitionRef.current),
      modelActive: Boolean(
        researchHostStreamAbortRef.current
        || researchHostNativeRequestSlot.current()
        || host.nativeActive,
      ),
      runningToolCount: (host.receipts || []).filter((receipt: any) => (
        ["RUNNING", "AWAITING_CONFIRMATION"].includes(receipt.status)
      )).length,
      voicePhase: researchHostVoicePhaseRef.current,
      ttsActive: Boolean(
        narrationState.active
        || narrationState.queue.length
        || ["speaking", "paused"].includes(narrationState.status)
      ),
      navigationSuppressed,
    });
    if (contextAction === "suppress") return;
    researchHostPttRequestRef.current = null;
    researchHostWakeAwaitingRef.current = false;
    researchHostWakeEchoRef.current = { text: "", spokenAt: 0 };
    dispatchResearchHostVoice({ type: "wake-heard", awaiting: false });
    if (contextAction === "cancel") {
      researchHostNativeNavigationGuard.clear();
      interruptResearchHostWorkRef.current?.("context");
      return;
    }
    if (contextAction === "stop-tts") {
      void stopNarration("已切换卷宗");
    }
    researchHostNativeRequestSlot.abort();
    researchHostStreamAbortRef.current?.abort();
    researchHostStreamAbortRef.current = null;
    if (researchHostRecognitionModeRef.current === "ptt") {
      researchHostDiscardTranscriptRef.current = true;
      researchHostRecognitionModeRef.current = null;
      abortResearchHostRecognition(researchHostRecognitionRef);
      dispatchResearchHostVoice({ type: "interrupted" });
    }
  }, [hostConversationKey]);
  useEffect(() => () => {
    researchHostPttRequestRef.current = null;
    researchHostWakeArmedRef.current = false;
    if (researchHostWakeTimerRef.current !== null) {
      window.clearTimeout(researchHostWakeTimerRef.current);
      researchHostWakeTimerRef.current = null;
    }
    const surfaceController = researchHostStreamAbortRef.current;
    if (!researchHostNativeRequestSlot.isCurrent(surfaceController)) {
      surfaceController?.abort();
    }
    researchHostStreamAbortRef.current = null;
    for (const controller of researchHostToolAbortControllersRef.current.values()) controller.abort();
    researchHostToolAbortControllersRef.current.clear();
    researchHostVadMonitorRef.current?.stop?.();
    researchHostVadMonitorRef.current = null;
    researchHostRecognitionModeRef.current = null;
    abortResearchHostRecognition(researchHostRecognitionRef);
  }, []);
  const projectionBlocked = Boolean(snapshot.projectionStatus && snapshot.projectionStatus !== "COMPLETE");
  const personalReadOnly = !personalConnection.allows("personalWrites");
  const liveSyncRunning = Boolean(snapshot.bootstrap?.sourceRuntime?.liveSync?.running);
  const projectionUpdating = snapshot.projectionStatus === "PROJECTION_REFRESHING" || (projectionBlocked && liveSyncRunning);
  const watchCatalystUiEnabled =
    snapshot.bootstrap?.featureFlags?.watchCatalystUiEnabled === true;
  const catalystFunnelMode = watchCatalystUiEnabled
    ? snapshot.watchUi.mode
    : "FORMAL";
  const selectedViewId = selectedView?.id;
  const closeEditor = useCallback(() => {
    if (selectedViewId) dispatch({ type: "toggle-record-editor", cardId: selectedViewId });
  }, [selectedViewId]);
  const beginRadarResize = useCallback((clientX: number) => {
    radarResizeRef.current = {
      startX: clientX,
      expanded: radarExpanded,
      moved: false,
    };
  }, [radarExpanded]);
  const moveRadarResizeAt = useCallback((clientX: number) => {
    const drag = radarResizeRef.current;
    if (!drag) return;
    const delta = clientX - drag.startX;
    if (Math.abs(delta) < 48) return;
    drag.moved = true;
    if (delta > 0 && !drag.expanded) setRadarExpanded(true);
    if (delta < 0 && drag.expanded) setRadarExpanded(false);
  }, []);
  const finishRadarResize = useCallback(() => {
    const drag = radarResizeRef.current;
    if (!drag) return;
    radarResizeRef.current = null;
    if (drag.moved) suppressRadarResizeClickRef.current = true;
  }, []);
  const startRadarResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    beginRadarResize(event.clientX);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [beginRadarResize]);
  const moveRadarResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    moveRadarResizeAt(event.clientX);
  }, [moveRadarResizeAt]);
  const endRadarResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    finishRadarResize();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  }, [finishRadarResize]);
  const startRadarResizeMouse = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    beginRadarResize(event.clientX);
    radarMouseCleanupRef.current?.();
    const onMove = (moveEvent: MouseEvent) => moveRadarResizeAt(moveEvent.clientX);
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      radarMouseCleanupRef.current = null;
    };
    const onUp = () => {
      finishRadarResize();
      cleanup();
    };
    radarMouseCleanupRef.current = cleanup;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [beginRadarResize, finishRadarResize, moveRadarResizeAt]);
  useEffect(() => () => radarMouseCleanupRef.current?.(), []);
  const toggleRadarExpanded = useCallback(() => {
    if (suppressRadarResizeClickRef.current) {
      suppressRadarResizeClickRef.current = false;
      return;
    }
    setRadarExpanded((value) => !value);
  }, []);
  useFocusTrap(Boolean(local.recordEditorOpen), editorRef, closeEditor);

  const executeResearchHostTool = useCallback(async (request: any) => {
    const fail = (message: string) => setResearchHost((current: any) => researchHostReducer(current, {
      type: "tool-failed",
      requestId: request.id,
      resultLabel: message,
    }));
    const succeed = (message: string) => setResearchHost((current: any) => researchHostReducer(current, {
      type: "tool-succeeded",
      requestId: request.id,
      resultLabel: message,
    }));
    const speakResult = (message: string) => {
      dispatchResearchHostVoice({ type: "answer-delta", text: message, speechMode: "legacy" });
      finishResearchHostVoiceAnswer();
      enqueueResearchHostSentence(
        message,
        ++researchHostSentenceSequenceRef.current,
        researchHostVoiceTurnRef.current?.turnId,
      );
    };
    if (!researchHostContext || researchHostContext.scopeKey !== request.scopeKey) {
      fail("当前卷宗已变化，本次调用没有执行。");
      return;
    }
    const currentView = selectedView?.id === request.cardId ? selectedView : null;
    const toolController = new AbortController();
    researchHostToolAbortControllersRef.current.set(request.id, toolController);
    try {
      if (request.toolId === "radarOverview") {
        const overview = getResearchHostRadarOverview(researchHostRadarIndex, {
          limit: request.args?.limit,
        });
        const latest = overview.latest.length
          ? overview.latest.map((entry: any, index: number) => (
              `${index + 1}，${entry.title}，${entry.timeLabel}，${entry.suggestionLabel}`
            )).join("；")
          : "暂无可读变量";
        const counts = overview.suggestionCounts;
        const message = `全局雷达共 ${overview.total} 个变量；可炒 ${counts.TRADABLE} 个，继续观察 ${counts.WATCH} 个，不可炒 ${counts.NOT_TRADABLE} 个，待确认 ${counts.UNCLASSIFIED} 个。最新：${latest}。`;
        succeed(message);
        speakResult(message);
        return;
      }
      if (request.toolId === "searchRadar") {
        const matches = searchResearchHostRadar(researchHostRadarIndex, {
          query: request.args?.query,
          limit: request.args?.limit,
        });
        const message = matches.length
          ? `找到 ${matches.length} 份相关卷宗：${matches.map((entry: any, index: number) => (
              `${index + 1}，${entry.title}，${entry.timeLabel}，${entry.suggestionLabel}`
            )).join("；")}。`
          : `全局雷达中没有找到与“${cleanDisplayText(request.args?.query, "该查询")}”匹配的卷宗。`;
        succeed(message);
        speakResult(message);
        return;
      }
      if (request.toolId === "wechatRawSearch") {
        const response = await rpc("wechatRawSearch", {
          query: request.args?.query,
          channel: request.args?.channel,
          limit: request.args?.limit,
          dateFrom: request.args?.dateFrom,
          dateTo: request.args?.dateTo,
        }, { signal: toolController.signal });
        if (!response.ok) throw new Error(response.error?.code || "WECHAT_RAW_SEARCH_UNAVAILABLE");
        const result = response.result || {};
        const matches = Array.isArray(result.matches) ? result.matches : [];
        const count = Number(result.totalMatches) || matches.length;
        const label = result.channel === "radar"
          ? "微信 Radar 舆情"
          : result.channel === "both" || result.source === "wechat-both"
            ? "微信原始与 Radar 舆情"
            : "微信原始舆情";
        const message = count
          ? `微信原始舆情找到 ${count} 条；${matches.slice(0, 3).map((item: any, index: number) => (
              `${index + 1}，${cleanDisplayText(item.heading, "未命名片段")}，${cleanDisplayText(item.sourceDate, "日期未知")}，${cleanDisplayText(item.snippet, "摘录暂不可读")}`
            )).join("；")}。这些是未成卡线索，不代表正式研判。`
          : `原始微信舆情里没有找到与“${cleanDisplayText(request.args?.query, "该查询")}”匹配的片段；这不代表正式雷达中不存在相关内容。`;
        const labeledMessage = message
          .replace(/^微信原始舆情/u, label)
          .replace(/^原始微信舆情里/u, label + "里");
        succeed(labeledMessage);
        speakResult(labeledMessage);
        return;
      }
      if (request.toolId === "openDossier") {
        const resolution = resolveResearchHostDossierTarget(researchHostRadarIndex, {
          query: request.args?.query,
          preferLatest: request.args?.preferLatest,
        });
        if (resolution.status === "NOT_FOUND") {
          const message = `全局雷达中没有找到与“${cleanDisplayText(request.args?.query, "该查询")}”匹配的卷宗，当前卷宗没有变化。`;
          succeed(message);
          speakResult(message);
          return;
        }
        if (resolution.status === "AMBIGUOUS") {
          const message = `找到多个候选，我没有擅自切换：${resolution.candidates.map((entry: any, index: number) => (
            `${index + 1}，${entry.title}，${entry.timeLabel}`
          )).join("；")}。请说“打开最新”或给出更完整的名称。`;
          succeed(message);
          speakResult(message);
          return;
        }
        const target = resolution.target;
        if (!target?.cardId) throw new Error("DOSSIER_TARGET_INVALID");
        const message = `已打开${target.title}，进入时间${target.timeLabel}，系统预判为${target.suggestionLabel}。`;
        succeed(message);
        speakResult(message);
        setReferenceCleared(false);
        setLayoutRequest({ purpose: "details" });
        await selectDeskCard(target.cardId);
        return;
      }
      if (request.toolId === "expandEvidence") {
        const evidenceId = researchHostContext.visibleEvidenceIds[0];
        const evidence = currentView?.evidence.find((item: any) => item.id === evidenceId);
        if (!evidence) throw new Error("NO_VISIBLE_EVIDENCE");
        const detail = await loadEvidenceDetail(evidence, toolController.signal);
        if (!detail) throw new Error("EVIDENCE_DETAIL_UNAVAILABLE");
        succeed("完整受控引用已展开");
        return;
      }
      if (request.toolId === "marketPulse") {
        const response = await rpc("marketPulse", { query: request.args?.query }, { signal: toolController.signal });
        if (!response.ok || !response.result?.speech) throw new Error(response.error?.code || "MARKET_REALTIME_UNAVAILABLE");
        const speech = cleanDisplayText(response.result.speech, "实时行情暂不可用");
        succeed(speech);
        dispatchResearchHostVoice({ type: "answer-delta", text: speech, speechMode: "legacy" });
        finishResearchHostVoiceAnswer();
        enqueueResearchHostSentence(
          speech,
          ++researchHostSentenceSequenceRef.current,
          researchHostVoiceTurnRef.current?.turnId,
        );
        return;
      }
      if (request.toolId === "switchCard") {
        if (cards.length < 2) throw new Error("NO_NEXT_CARD");
        const currentIndex = Math.max(0, cards.findIndex((item) => cardId(item) === request.cardId));
        const offset = request.args?.direction === "previous" ? -1 : 1;
        const nextCard = cards[(currentIndex + offset + cards.length) % cards.length];
        const nextId = cardId(nextCard);
        if (!nextId || nextId === request.cardId) throw new Error("NO_NEXT_CARD");
        setReferenceCleared(false);
        setLayoutRequest({ purpose: "details" });
        const switching = selectDeskCard(nextId);
        succeed(`已切换到${cleanDisplayText(nextCard?.eventSummary, "下一份变量卷宗")}`);
        await switching;
        return;
      }
      if (request.toolId === "deepResearch") {
        if (!currentView) throw new Error("CARD_CONTEXT_MISSING");
        await runDeepResearch(currentView, false, toolController.signal);
        const result = state.deepResearch[request.cardId];
        if (result?.phase !== "ready" || !result.result) throw new Error("DEEP_RESEARCH_FAILED");
        succeed(`联网补证完成，新增 ${result.result.evidence?.length || 0} 条待复核引用`);
        return;
      }
      if (request.toolId === "draftJudgment") {
        if (!currentView) throw new Error("CARD_CONTEXT_MISSING");
        await runAutoJudgment(currentView, toolController.signal);
        const draft = state.prototype.cases[request.cardId];
        if (draft?.autoJudgmentState !== "ready" || !draft.label) throw new Error("AUTO_JUDGMENT_FAILED");
        succeed(`研判草稿已生成：${translateStatus(draft.label)}；仍需你确认后正式提交`);
        return;
      }
      throw new Error("TOOL_NOT_ALLOWED");
    } catch {
      if (toolController.signal.aborted) return;
      const message = request.toolId === "expandEvidence"
        ? "完整引用暂不可读，已保留冻结摘录。"
        : request.toolId === "marketPulse"
          ? "实时行情暂不可读；没有用冻结行情冒充实时价格。"
        : request.toolId === "switchCard"
          ? "没有可切换的下一份卷宗。"
          : request.toolId === "openDossier"
            ? "指定卷宗暂时无法打开，当前卷宗没有变化。"
            : request.toolId === "wechatRawSearch"
              ? "原始微信舆情暂不可读；没有改变正式卷宗。"
              : request.toolId === "deepResearch"
                ? "联网补证未完成，当前证据链没有变化。"
                : "研判草稿未生成，当前人工草稿没有变化。";
      fail(message);
    } finally {
      if (researchHostToolAbortControllersRef.current.get(request.id) === toolController) {
        researchHostToolAbortControllersRef.current.delete(request.id);
      }
    }
  }, [cards, finishResearchHostVoiceAnswer, researchHostContext, researchHostRadarIndex, selectedView]);

  const applyResearchHostNativeUiAction = useCallback(async (event: any, target: any = null) => {
    const action = event?.uiAction;
    if (!action || event?.status !== "success") return;
    if (personalConnection.isPersonal()) {
      if (action.type !== "APPLY_JUDGMENT_DRAFT" || !target || action.cardId !== target.cardId
        || state.selectedCardId !== target.cardId || personalConnection.scopeKey() !== target.scopeKey
        || researchHostSessionIdRef.current !== target.sessionId
        || researchHostRequestGenerationRef.current !== target.requestGeneration) return;
      const view = views[action.cardId];
      if (!view) return;
      let response;
      try { response = JSON.parse(String(event.dataJson || "")); } catch { return; }
      dispatch({ type: "apply-personal-native-draft", cardId: action.cardId, target: target.draft,
        result: response?.result, allowedEvidenceIds: view.evidence.map((item: any) => item.id) });
      return;
    }
    if (action.type === "DRAFT_WATCH") {
      xiaomeiWatchStore.draft(action.draft);
      return;
    }
    if (action.type === "OPEN_DOSSIER" && typeof action.cardId === "string") {
      researchHostNativeNavigationGuard.begin(action.cardId);
      setReferenceCleared(false);
      try {
        await selectDeskCard(action.cardId);
        setHostNavigationKey({ key: researchHostConversationKey({ selectedCardId: action.cardId }) });
      } catch (error) {
        researchHostNativeNavigationGuard.clear();
        throw error;
      }
      return;
    }
    if (action.type === "OPEN_EVIDENCE" && typeof action.evidenceId === "string") {
      const evidence = Object.values(views)
        .flatMap((view: any) => view?.evidence || [])
        .find((item: any) => item?.id === action.evidenceId);
      if (evidence) await loadEvidenceDetail(evidence);
      return;
    }
    if (action.type === "REFRESH_DEEP_RESEARCH" && typeof action.cardId === "string") {
      await loadDeepResearchStatus(action.cardId);
      return;
    }
    if (action.type === "APPLY_JUDGMENT_DRAFT" && typeof action.cardId === "string") {
      const view = views[action.cardId];
      if (!view) return;
      let response;
      try { response = JSON.parse(String(event.dataJson || "")); } catch { return; }
      const proposal = normalizeAutoJudgmentDraft(
        response?.result,
        view.evidence.map((item: any) => item.id),
      );
      if (!proposal) return;
      dispatch({
        type: "apply-auto-judgment",
        cardId: action.cardId,
        draft: proposal.draft,
        modelLabel: proposal.modelLabel,
      });
    }
  }, [views]);

  const requestResearchHostTool = useCallback((toolId: string, args: any = {}) => {
    if (duplexVoiceOwned) return;
    if (!researchHostContext || snapshot.projectionStatus !== "COMPLETE") return;
    let request;
    try {
      researchHostToolSequence.current += 1;
      request = createResearchHostToolRequest({
        toolId,
        context: researchHostContext,
        requestId: `research-host-${Date.now()}-${researchHostToolSequence.current}`,
        args,
      });
    } catch {
      return;
    }
    setResearchHost((current: any) => researchHostReducer(current, { type: "request-tool", request }));
    if (request.authority === "READ_ONLY") void executeResearchHostTool(request);
  }, [executeResearchHostTool, researchHostContext, snapshot.projectionStatus]);

  const decideResearchHostNativeApproval = useCallback(async (request: any, outcome: "allowed-once" | "rejected") => {
    const personal = personalConnection.isPersonal();
    const binding = personal ? personalApprovalRef.current : null;
    const localController = researchHostStreamAbortRef.current;
    const localGeneration = researchHostRequestGenerationRef.current;
    const localScope = personalConnection.scopeKey();
    const ownsApproval = () => binding && personalApprovalRef.current === binding
      && !binding.controller.signal.aborted && researchHostStreamAbortRef.current === binding.controller
      && researchHostSessionIdRef.current === binding.sessionId
      && researchHostRequestGenerationRef.current === binding.requestGeneration
      && personalConnection.scopeKey() === binding.scopeKey && state.selectedCardId === binding.cardId;
    if (personal && (!ownsApproval() || binding.deciding || request.approvalId !== binding.approvalId
      || request.sessionId !== binding.sessionId || request.requestGeneration !== binding.requestGeneration
      || request.scopeKey !== binding.contextKey)) return;
    const sessionId = binding?.sessionId || request.sessionId || researchHostSessionIdRef.current;
    if (binding) binding.deciding = true;
    try {
      if (!personal && !csrfToken) throw new Error("小美会话凭证不可用");
      const response = await fetchResearchHostEndpoint(RESEARCH_HOST_AGENT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-variable-os-csrf": csrfToken },
        body: JSON.stringify({ action: "approve", sessionId, approvalId: request.approvalId, outcome }),
        ...(binding ? { signal: binding.controller.signal } : {}),
      });
      let failed: any = null, acknowledged = false;
      await consumeResearchHostAgentResponse(response, (event) => {
        if (event.type === "error") failed = event.error;
        if (event.type === "done" && event.sessionId === sessionId && event.outcome === outcome) acknowledged = true;
      });
      if (failed || personal && !acknowledged) throw new Error(failed?.message || "确认回执未完整送达，已停止本次研究。");
    } catch (error: any) {
      if (!personal) {
        setResearchHost((current: any) => {
          if (personalConnection.isPersonal() || personalConnection.scopeKey() !== localScope
            || researchHostStreamAbortRef.current !== localController || localController?.signal.aborted
            || researchHostRequestGenerationRef.current !== localGeneration
            || researchHostSessionIdRef.current !== sessionId || current.sessionId !== sessionId
            || !current.nativeActive || current.nativeApprovalControl !== request) return current;
          return researchHostReducer(current, {
            type: "native-event", event: { type: "error", error: { message: error?.message } },
          });
        });
        return;
      }
      // A matching terminal control on the original stream is also an ACK.
      // Lost HTTP replies must never be retried or cancel a newer approval.
      if (binding.terminal || !ownsApproval()) return;
      personalApprovalRef.current = null;
      binding.controller.abort();
      researchHostNativeRequestSlot.clear(binding.controller);
      researchHostStreamAbortRef.current = null;
      researchHostSessionIdRef.current = replaceResearchHostSessionId();
      setResearchHost((current: any) => researchHostReducer(current, {
        type: "native-approval-failed", sessionId, approvalId: binding.approvalId,
        requestGeneration: binding.requestGeneration, message: "确认回执未完整送达，已停止本次研究。",
      }));
      dispatchResearchHostVoice({ type: "failed", message: "确认回执未完整送达，已停止本次研究；未自动重试。" });
      void personalRetirements.current.retire(sessionId);
    }
  }, []);

  const confirmResearchHostTool = useCallback((requestId: string) => {
    const request = researchHost.pendingTool;
    if (!request || request.id !== requestId || researchHost.phase !== "awaiting-confirmation") return;
    setResearchHost((current: any) => researchHostReducer(current, personalConnection.isPersonal() && request.native
      ? { type: "native-approval-deciding", sessionId: request.sessionId, approvalId: request.approvalId,
        requestGeneration: request.requestGeneration, outcome: "allowed-once" }
      : { type: "confirm-tool", requestId }));
    if (request.native) {
      void decideResearchHostNativeApproval(request, "allowed-once");
      return;
    }
    void executeResearchHostTool(request);
  }, [decideResearchHostNativeApproval, executeResearchHostTool, researchHost]);

  const cancelResearchHostTool = useCallback((requestId: string) => {
    const request = researchHost.pendingTool;
    if (request?.id === requestId && request.native) {
      setResearchHost((current: any) => researchHostReducer(current, personalConnection.isPersonal()
        ? { type: "native-approval-deciding", sessionId: request.sessionId, approvalId: request.approvalId,
          requestGeneration: request.requestGeneration, outcome: "rejected" }
        : { type: "cancel-tool", requestId }));
      void decideResearchHostNativeApproval(request, "rejected");
      return;
    }
    setResearchHost((current: any) => researchHostReducer(current, { type: "cancel-tool", requestId }));
  }, [decideResearchHostNativeApproval, researchHost.pendingTool]);

  const publishResearchHostCancellation = useCallback((rawReceipt: any) => {
    const receipt = normalizeResearchHostCancellationReceipt(rawReceipt);
    if (!receipt) return;
    if (!personalConnection.isPersonal()) persistResearchHostCancellationReceipt(researchHostSessionIdRef.current, receipt);
    setResearchHost((current: any) => researchHostReducer(current, {
      type: "native-event",
      event: { type: "cancellation", receipt },
    }));
  }, []);

  const interruptResearchHostWork = useCallback((
    trigger: "vad" | "speechstart" | "ptt" | "button" | "context" = "button",
    detectedAt?: number,
  ) => {
    if (trigger === "button" || trigger === "context") researchHostPttRequestRef.current = null;
    if (["button", "context", "ptt"].includes(trigger)) {
      researchHostWakeAwaitingRef.current = false;
      researchHostWakeEchoRef.current = { text: "", spokenAt: 0 };
      dispatchResearchHostVoice({ type: "wake-heard", awaiting: false });
    }
    if (researchHostCancelInFlightRef.current) return false;
    const host = researchHostStateRef.current;
    const recognitionActive = Boolean(researchHostRecognitionRef.current);
    const modelActive = Boolean(
      researchHostStreamAbortRef.current
      || researchHostNativeRequestSlot.current()
      || host.nativeActive,
    );
    const runningTools = (host.receipts || []).filter((receipt: any) => (
      ["RUNNING", "AWAITING_CONFIRMATION"].includes(receipt.status)
    ));
    const ttsActive = Boolean(
      narrationState.active
      || narrationState.queue.length
      || ["speaking", "paused"].includes(narrationState.status),
    );
    const voiceActive = ["thinking", "answering"].includes(researchHostVoicePhaseRef.current);
    const substantiveWork = modelActive || runningTools.length > 0 || ttsActive || voiceActive;
    // RMS detects sound, not replacement intent. While silently reasoning,
    // require a confirmed wake command or an explicit control, not utterance tails.
    if (trigger === "vad" && !["speaking", "paused"].includes(narrationState.status)) return false;
    if (["vad", "speechstart", "ptt"].includes(trigger) && !substantiveWork) return false;
    if (!recognitionActive && !modelActive && !runningTools.length && !ttsActive && !voiceActive) return false;

    researchHostCancelInFlightRef.current = true;
    const personalStop = personalConnection.isPersonal();
    const clock = typeof performance !== "undefined" ? performance : { now: Date.now };
    const startedAt = Number.isFinite(Number(detectedAt)) ? Number(detectedAt) : clock.now();
    const receiptId = createResearchHostCancellationId();
    const cancelledSessionId = researchHostSessionIdRef.current;
    const personalSessionOwned = personalStop && personalConnection.hasAgentSession(cancelledSessionId);
    const requestedAt = Date.now();
    if (researchHostRecognitionModeRef.current === "ptt") {
      researchHostDiscardTranscriptRef.current = true;
    }
    researchHostRecognitionModeRef.current = null;
    abortResearchHostRecognition(researchHostRecognitionRef);
    personalApprovalRef.current = null;
    researchHostNativeRequestSlot.abort();
    researchHostStreamAbortRef.current?.abort();
    researchHostStreamAbortRef.current = null;
    for (const controller of researchHostToolAbortControllersRef.current.values()) controller.abort();
    researchHostToolAbortControllersRef.current.clear();
    const narrationStop = stopNarration("小美已停止回答");
    dispatchResearchHostVoice({ type: "interrupted" });

    const initialReceipt = {
      receiptId,
      trigger,
      requestedAt,
      status: "cancel-requested",
      latencyMs: Math.max(0, Math.round(clock.now() - startedAt)),
      localStopLatencyMs: null,
      cancellationConvergenceMs: null,
      components: {
        recognition: recognitionActive ? "cancelled" : "not-active",
        model: modelActive ? "cancel-requested" : "not-active",
        tool: runningTools.length ? "cancel-requested" : "not-active",
        tts: ttsActive ? "cancel-requested" : "not-active",
      },
    };
    publishResearchHostCancellation(initialReceipt);

    const localStop = narrationStop.then((narrationStopped) => {
      const localStopLatencyMs = Math.max(0, Math.round(clock.now() - startedAt));
      if (ttsActive && narrationStopped) {
        dispatchResearchHostVoice({
          type: "latency-sample",
          metric: "localInterruption",
          latencyMs: localStopLatencyMs,
        });
      }
      return { narrationStopped, localStopLatencyMs: ttsActive ? localStopLatencyMs : null };
    });

    const serverCancel = (async () => {
      if (personalStop) return personalSessionOwned ? personalRetirements.current.retire(cancelledSessionId) : null;
      if (!csrfToken) return null;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetchResearchHostEndpoint(RESEARCH_HOST_AGENT_PATH, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-variable-os-csrf": csrfToken,
          },
          body: JSON.stringify({
            action: "cancel",
            sessionId: cancelledSessionId,
            receiptId,
            trigger,
            requestedAt,
          }),
          signal: controller.signal,
        });
        let receipt = null;
        await consumeResearchHostAgentResponse(response, (event) => {
          if (event.type === "cancellation") receipt = event.receipt || null;
        });
        return receipt;
      } catch {
        return null;
      } finally {
        window.clearTimeout(timeout);
      }
    })();

    const completion = Promise.all([localStop, serverCancel]).then(([localStopResult, serverReceipt]: any[]) => {
      if (personalStop && researchHostSessionIdRef.current !== cancelledSessionId) return;
      const cancellationConvergenceMs = Math.max(0, Math.round(clock.now() - startedAt));
      const receipt = {
        ...initialReceipt,
        status: (personalStop ? (!personalSessionOwned || Boolean(serverReceipt)) && localStopResult.narrationStopped
          : serverReceipt?.status === "cancelled" || !modelActive)
          ? "cancelled"
          : "cancelled-client-unconfirmed",
        latencyMs: cancellationConvergenceMs,
        localStopLatencyMs: localStopResult.localStopLatencyMs,
        cancellationConvergenceMs,
        serverTurnEndSeq: Number.isSafeInteger(serverReceipt?.turnEndSeq) ? serverReceipt.turnEndSeq : null,
        components: {
          recognition: recognitionActive ? "cancelled" : "not-active",
          model: modelActive
            ? serverReceipt?.components?.model || "cancelled-client-signal"
            : "not-active",
          tool: runningTools.length
            ? serverReceipt?.components?.tool || "cancelled-client-signal"
            : "not-active",
          tts: ttsActive ? localStopResult.narrationStopped ? "cancelled" : "cancel-failed" : "not-active",
        },
      };
      publishResearchHostCancellation(receipt);
      dispatchResearchHostVoice({
        type: "latency-sample",
        metric: "cancellationConvergence",
        latencyMs: cancellationConvergenceMs,
      });
    }).finally(() => {
      researchHostCancelInFlightRef.current = false;
      if (researchHostCancelCompletionRef.current === completion) {
        researchHostCancelCompletionRef.current = null;
      }
      if (personalSessionOwned && researchHostSessionIdRef.current === cancelledSessionId) {
        researchHostSessionIdRef.current = replaceResearchHostSessionId();
        setResearchHost(createResearchHostState());
        dispatchResearchHostVoice({ type: "conversation-reset" });
      }
      if (researchHostWakeArmedRef.current && document.visibilityState === "visible") {
        window.setTimeout(() => { void startResearchHostWakeRef.current?.(); }, 120);
      }
    });
    researchHostCancelCompletionRef.current = completion;
    void completion;
    return true;
  }, [publishResearchHostCancellation]);

  const interruptResearchHostVoice = useCallback(() => {
    interruptResearchHostWork("button");
  }, [interruptResearchHostWork]);
  useEffect(() => {
    interruptResearchHostWorkRef.current = (trigger) => interruptResearchHostWork(trigger);
    return () => { interruptResearchHostWorkRef.current = null; };
  }, [interruptResearchHostWork]);

  useEffect(() => {
    if (!researchHostVoice.wakeArmed || !researchHostPageVisible || !researchHostMicrophoneGrantedRef.current) {
      researchHostVadMonitorRef.current?.stop?.();
      researchHostVadMonitorRef.current = null;
      return undefined;
    }
    let disposed = false;
    void createResearchHostVadMonitor({
      onSpeechStart: () => {
        // Sound may be our own TTS or background audio. Ask the guarded wake
        // recognizer for intent; an RMS edge alone must never discard a task.
        if (!disposed) void startResearchHostWakeRef.current?.();
      },
    }).then((monitor) => {
      if (disposed) {
        monitor.stop?.();
        return;
      }
      researchHostVadMonitorRef.current?.stop?.();
      researchHostVadMonitorRef.current = monitor.status === "running" ? monitor : null;
    }).catch((error: any) => {
      if (disposed) return;
      const denied = ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(String(error?.name || ""));
      if (denied) {
        researchHostMicrophoneGrantedRef.current = false;
        researchHostWakeArmedRef.current = false;
        dispatchResearchHostVoice({ type: "wake-armed", enabled: false });
        dispatchResearchHostVoice({ type: "failed", message: "麦克风权限未获允许；本页唤醒和 VAD 已关闭，文字输入仍可使用。" });
      }
    });
    return () => {
      disposed = true;
      researchHostVadMonitorRef.current?.stop?.();
      researchHostVadMonitorRef.current = null;
    };
  }, [interruptResearchHostWork, researchHostPageVisible, researchHostVoice.wakeArmed]);

  const submitResearchHostQuestion = useCallback(async (
    rawQuestion: string,
    options: { voicePauseAt?: number; modelUseAllowed?: boolean; researchPlan?: any } = {},
  ) => {
    if (duplexVoiceOwned) return;
    const question = cleanDisplayText(rawQuestion, "").slice(0, 500);
    if (!question || !researchHostContext) return;
    const personal = personalConnection.isPersonal();
    const consentScope = personalConversationScope;
    const consentGeneration = personal ? researchHostRequestGenerationRef.current : null;
    if (personal) {
      const retirements = personalRetirements.current.state();
      if (retirements.pending || retirements.unconfirmed) return;
    }
    if (personal && (referenceCleared || !personalConnection.allows("researchConversation") || !selectedView?.id
      || snapshot.projectionStatus !== "COMPLETE" || options.modelUseAllowed !== true)) return;
    researchHostWakeAwaitingRef.current = false;
    researchHostWakeEchoRef.current = { text: "", spokenAt: 0 };
    dispatchResearchHostVoice({ type: "wake-heard", awaiting: false });
    researchHostSessionIdRef.current = readOrCreateResearchHostSessionId();
    const voicePauseAt = Number(options.voicePauseAt);
    const voiceTurnId = Number.isFinite(voicePauseAt)
      ? `voice-turn-${Date.now()}-${researchHostSentenceSequenceRef.current + 1}`
      : undefined;
    researchHostVoiceTurnRef.current = voiceTurnId
      ? { turnId: voiceTurnId, pauseAt: voicePauseAt, firstAudioRecorded: false }
      : null;
    const currentHost = researchHostStateRef.current;
    const priorWorkActive = Boolean(
      researchHostStreamAbortRef.current
      || researchHostNativeRequestSlot.current()
      || currentHost.nativeActive
      || (currentHost.receipts || []).some((receipt: any) => ["RUNNING", "AWAITING_CONFIRMATION"].includes(receipt.status))
      || narrationState.active
      || narrationState.queue.length
      || ["speaking", "paused"].includes(narrationState.status)
      || ["thinking", "answering"].includes(researchHostVoicePhaseRef.current),
    );
    if (priorWorkActive) interruptResearchHostWork("context");
    else {
      researchHostStreamAbortRef.current?.abort();
      researchHostStreamAbortRef.current = null;
    }
    const pendingCancellation = researchHostCancelCompletionRef.current;
    if (pendingCancellation) await pendingCancellation;
    if (personal) {
      const retirements = personalRetirements.current.state();
      if (retirements.pending || retirements.unconfirmed) return;
    }
    if (personal && (consentGeneration !== researchHostRequestGenerationRef.current
      || consentScope !== `${personalConnection.scopeKey()}:${state.selectedCardId || ""}`)) return;
    void stopNarration();
    dispatchResearchHostVoice({ type: "question-submitted", text: question, speechMode: "contextual-v1" });

    const directWechatChannel = detectResearchHostWechatChannel(question);
    const requestGeneration = ++researchHostRequestGenerationRef.current;
    const personalDraftTarget = personal ? {
      cardId: selectedView.id, scopeKey: personalConnection.scopeKey(),
      contextKey: researchHostContext.scopeKey || researchHostContext.contextKey,
      draft: capturePersonalDraftTarget(state.prototype, selectedView.id), requestGeneration,
    } : null;

    const visibleIds = new Set(researchHostContext.visibleEvidenceIds);
    const contextEvidence = selectedView
      ? selectedView.evidence
        .filter((item: any) => visibleIds.has(item.id))
        .slice(0, 6)
        .map((item: any) => ({
          id: item.id,
          summary: item.summary,
          sourceLabel: item.sourceLabel,
          timeLabel: item.timeLabel,
          contentHash: item.contentHash || item.sha256 || null,
          materialAt: item.materialAt || null,
        }))
      : [];
    const requestContext = scopeResearchHostQuestionContext({
      cardId: researchHostContext.cardId,
      title: researchHostContext.variableTitle,
      variableId: researchHostContext.variableId,
      variableIdentityKey: researchHostContext.variableIdentityKey,
      catalystIdentityKey: researchHostContext.catalystIdentityKey,
      revision: researchHostContext.revision,
      evidenceHashes: researchHostContext.evidenceHashes,
      watermark: researchHostContext.watermark,
      materialAt: researchHostContext.materialAt,
      scannedAt: researchHostContext.scannedAt,
      summary: selectedCard?.eventSummary || selectedView?.expectationGap || "全局只读研究上下文",
      stageId: researchHostContext.stage.id,
      stageLabel: researchHostContext.stage.label,
      timelineNodeTitle: researchHostContext.timelineNode?.label || "",
      projectionStatus: researchHostContext.projectionStatus,
      evidence: contextEvidence,
      watchMemory: watchTaskContext(xiaomeiWatchStore.snapshot().state),
      radar: buildResearchHostAgentRadarContext(researchHostRadarIndex, {
        currentCardId: researchHostContext.cardId,
      }),
    });

    if (csrfToken || personal) {
      let nativeAttempt = 0;
      while (nativeAttempt < 2) {
        const nativeController = new AbortController();
        const nativeSessionId = researchHostSessionIdRef.current;
        researchHostStreamAbortRef.current = nativeController;
        researchHostNativeRequestSlot.attach(nativeController);
        const ownsNativeRequest = () => !nativeController.signal.aborted
          && researchHostNativeRequestSlot.isCurrent(nativeController)
          && researchHostRequestGenerationRef.current === requestGeneration
          && researchHostSessionIdRef.current === nativeSessionId
          && readOrCreateResearchHostSessionId() === nativeSessionId;
        let nativeStarted = false;
        let nativeDone = false;
        let nativeAnswer = "";
        let nativeMessageText = "";
        let spokenDraft = "";
        let speechInvalidated = false;
        const protectNativePresentation = (presentation: any) => {
          if (spokenDraft && (presentation.speechStatus !== "ready" || presentation.spokenText !== spokenDraft)) {
            speechInvalidated = true;
          }
          return speechInvalidated ? { ...presentation, spokenText: "", speechStatus: "unavailable" } : presentation;
        };
        const presentNativeAnswer = (presentation: any, final = false) => {
          nativeAnswer = presentation.text;
          dispatchResearchHostVoice({ type: "answer-presentation", presentation, final });
          if (presentation.speechStatus !== "ready" || spokenDraft) return;
          spokenDraft = presentation.spokenText;
          if (personal && !narrationState.replyEnabled) return;
          for (const sentence of splitResearchHostSentences(presentation.spokenText, true).sentences) {
            if (!ownsNativeRequest()) return;
            enqueueResearchHostSentence(sentence, ++researchHostSentenceSequenceRef.current, voiceTurnId);
          }
        };
        let retryNative = false;
        const deferredNativeUiActions: any[] = [];
        try {
          const response = await fetchResearchHostEndpoint(RESEARCH_HOST_AGENT_PATH, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-variable-os-csrf": csrfToken,
            },
            body: JSON.stringify({
              action: "run",
              sessionId: nativeSessionId,
              question,
              ...(personal ? { card: selectedView.id, modelUseAllowed: true,
                researchPlan: options.researchPlan } : { context: requestContext }),
            }),
            signal: nativeController.signal,
          });
          await consumeResearchHostAgentResponse(response, (rawEvent) => {
            let event = rawEvent;
            if (!ownsNativeRequest() || event.sessionId && event.sessionId !== nativeSessionId) return;
            if (personal && event.type === "approval") {
              if (!personalConnection.observeAgentApproval(nativeSessionId, event)) return;
              if (event.status === "awaiting-confirmation") {
                personalApprovalRef.current = { sessionId: nativeSessionId, approvalId: event.approvalId,
                  controller: nativeController, requestGeneration, scopeKey: personalDraftTarget.scopeKey,
                  contextKey: personalDraftTarget.contextKey,
                  cardId: personalDraftTarget.cardId, deciding: false, terminal: null };
              } else if (personalApprovalRef.current?.approvalId === event.approvalId
                && personalApprovalRef.current?.controller === nativeController) {
                personalApprovalRef.current.terminal = event.status;
                personalApprovalRef.current = null;
              }
              event = { ...event, sessionId: nativeSessionId, cardId: personalDraftTarget.cardId,
                scopeKey: personalDraftTarget.contextKey, requestGeneration };
            }
            if (event.type === "assistant-delta") {
              nativeMessageText += typeof event.text === "string" ? event.text : "";
              event = { ...event, presentation: protectNativePresentation(normalizeResearchHostPresentation(
                event.presentation || { version: 1, text: nativeMessageText, spokenText: "", speechStatus: "pending" },
              )) };
            } else if (event.type === "assistant" || event.type === "done") {
              event = { ...event, presentation: protectNativePresentation(normalizeResearchHostPresentation(
                event.presentation, event.type === "assistant" ? event.text || ""
                  : typeof event.finalText === "string" ? event.finalText : nativeAnswer, true,
              )) };
              nativeMessageText = "";
            } else if (event.type === "tool-call" || event.type === "tool-result") nativeMessageText = "";
            if (event.type === "session") nativeStarted = true;
            if (event.type === "error") {
              if (nativeStarted) {
                setResearchHost((current: any) => researchHostReducer(current, {
                  type: "native-event",
                  event,
                }));
              }
              const error: any = new Error(event.error?.message || "小美原生 Agent 暂时无法继续");
              error.code = event.error?.code;
              throw error;
            }
            setResearchHost((current: any) => researchHostReducer(current, {
              type: "native-event",
              event: event.type === "session" ? { ...event, speechMode: "contextual-v1" } : event,
            }));
            if (event.type === "session" && event.model) {
              dispatchResearchHostVoice({ type: "model-selected", model: event.model });
              return;
            }
            if (event.type === "assistant-delta") {
              presentNativeAnswer(event.presentation);
              return;
            }
            if (event.type === "assistant") {
              presentNativeAnswer(event.presentation, true);
              return;
            }
            if (event.type === "tool-result") {
              if (event.uiAction) deferredNativeUiActions.push(event);
              return;
            }
            if (event.type === "done") {
              nativeDone = true;
              presentNativeAnswer(event.presentation, true);
            }
          });
          if (!ownsNativeRequest()) return;
          if (!nativeDone || !nativeAnswer.trim()) {
            throw new Error("小美原生 Agent 的最终回答没有完整结束");
          }
          finishResearchHostVoiceAnswer();
          if (researchHostStreamAbortRef.current === nativeController) {
            researchHostStreamAbortRef.current = null;
          }
          researchHostNativeRequestSlot.clear(nativeController);
          for (const event of deferredNativeUiActions) {
            try {
              await applyResearchHostNativeUiAction(event, personalDraftTarget
                ? { ...personalDraftTarget, sessionId: nativeSessionId } : null);
            } catch {
              // A completed answer remains valid if its optional UI navigation cannot be applied.
            }
          }
          return;
        } catch (error: any) {
          if (nativeController.signal.aborted || error?.name === "AbortError") {
            return;
          }
          if (!ownsNativeRequest()) return;
          if (personal) {
            researchHostSessionIdRef.current = replaceResearchHostSessionId();
            setResearchHost(createResearchHostState());
            dispatchResearchHostVoice({ type: "conversation-reset" });
            dispatchResearchHostVoice({ type: "failed", message: error?.message || "当前卡片研究失败，未恢复旧会话。" });
            return;
          }
          if (!nativeStarted && shouldRecoverXiaomeiSessionOwnership(error?.code, nativeAttempt)) {
            researchHostSessionIdRef.current = replaceResearchHostSessionId();
            retryNative = true;
          } else if (nativeStarted) {
            dispatchResearchHostVoice({
              type: "failed",
              message: error?.message || "小美原生 Agent 暂时无法继续，当前卷宗没有变化。",
            });
            return;
          }
          // Fail closed after the bounded ownership recovery when no native Session was established.
        } finally {
          if (personalApprovalRef.current?.controller === nativeController) personalApprovalRef.current = null;
          if (researchHostStreamAbortRef.current === nativeController) {
            researchHostStreamAbortRef.current = null;
          }
          researchHostNativeRequestSlot.clear(nativeController);
        }
        if (!retryNative) break;
        nativeAttempt += 1;
      }
    }

    // Native Agent is the authoritative path. The direct broker is retained only
    // for legacy hosts that do not expose the CSRF-protected native endpoint;
    // current hosts therefore always emit a DSH Session Log for WeChat queries.
    if (directWechatChannel && !csrfToken) {
      try {
        const request = createResearchHostToolRequest({
          toolId: "wechatRawSearch",
          context: researchHostContext,
          requestId: `research-host-${Date.now()}-${++researchHostToolSequence.current}`,
          args: {
            query: extractResearchHostWechatQuery(question),
            channel: directWechatChannel,
            limit: 5,
          },
        });
        setResearchHost((current: any) => researchHostReducer(current, {
          type: "request-tool",
          request,
        }));
        await executeResearchHostTool(request);
      } catch {
        dispatchResearchHostVoice({
          type: "failed",
          message: "微信舆情检索请求未建立；当前卷宗没有变化。",
        });
      }
      return;
    }

    dispatchResearchHostVoice({
      type: "failed",
      message: "DSH 原生 Agent 未建立；未生成兼容回答。请重新读取变量台后重试。",
    });
  }, [
    applyResearchHostNativeUiAction,
    finishResearchHostVoiceAnswer,
    interruptResearchHostWork,
    researchHostContext,
    researchHostRadarIndex,
    selectedCard,
    selectedView,
    personalConversationScope,
    snapshot.projectionStatus,
  ]);

  const recoverResearchHostAnswer = useCallback(async (action: "continue" | "replay", consent = {}) => {
    const host = researchHostStateRef.current;
    const ownsRecovery = () => !duplexVoiceOwned && document.visibilityState === "visible"
      && !researchHostCancelCompletionRef.current && !narrationStopsPending
      && !researchHostNativeRequestSlot.current() && !researchHostStreamAbortRef.current
      && host.sessionId === researchHostSessionIdRef.current
      && researchHostStateRef.current.sessionId === host.sessionId
      && readOrCreateResearchHostSessionId() === host.sessionId;
    if (!ownsRecovery()) return;
    const recovery = researchHostRecoveryState(host, researchHostVoice, narrationState);
    if (action === "continue" && recovery.canContinue) {
      void submitResearchHostQuestion(`请继续上一问题：${recovery.question.slice(0, 300)}。先核对本会话已有工具结果，不重复已完成步骤；已完成就说明完成情况。取消或未确认的操作不视为成功，涉及人工确认仍须等待确认。`, consent);
    } else if (action === "replay" && recovery.canReplay) {
      if (narrationState.status === "error") {
        if (!await stopNarration("正在重试本机播报") || !ownsRecovery()
          || !researchHostRecoveryState(researchHostStateRef.current, researchHostVoice, narrationState).canReplay) return;
      }
      // No request, replay of tools or new first-voice sample: speech text only.
      enqueueResearchHostSentence(recovery.spokenAnswer, ++researchHostSentenceSequenceRef.current);
    }
  }, [researchHostVoice, submitResearchHostQuestion]);

  const scheduleResearchHostWake = useCallback((delay = 500) => {
    if (researchHostWakeTimerRef.current !== null) {
      window.clearTimeout(researchHostWakeTimerRef.current);
    }
    if (!researchHostWakeArmedRef.current) {
      researchHostWakeTimerRef.current = null;
      return;
    }
    researchHostWakeTimerRef.current = window.setTimeout(() => {
      researchHostWakeTimerRef.current = null;
      void startResearchHostWakeRef.current?.();
    }, delay);
  }, []);

  const startResearchHostWakeListening = useCallback(async () => {
    if (duplexVoiceOwned) return;
    if (
      !researchHostWakeArmedRef.current
      || document.visibilityState !== "visible"
      || researchHostRecognitionRef.current
    ) return;
    if (!["idle", "error", "thinking", "answering"].includes(researchHostVoicePhaseRef.current)) {
      scheduleResearchHostWake(700);
      return;
    }
    const startingPhase = researchHostVoicePhaseRef.current;
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) return;
    if (!(await ensureResearchHostMicrophoneAccess())) {
      researchHostWakeArmedRef.current = false;
      researchHostWakeAwaitingRef.current = false;
      dispatchResearchHostVoice({ type: "wake-armed", enabled: false });
      return;
    }
    if (
      !researchHostWakeArmedRef.current
      || document.visibilityState !== "visible"
      || researchHostRecognitionRef.current
    ) return;
    if (researchHostVoicePhaseRef.current !== startingPhase) {
      scheduleResearchHostWake(700);
      return;
    }
    const recognition = new Recognition();
    researchHostRecognitionRef.current = recognition;
    researchHostRecognitionModeRef.current = "wake";
    researchHostWakeTranscriptRef.current = "";
    researchHostSpeechPauseAtRef.current = null;
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    let speechStartedAt: number | null = null;
    recognition.onspeechstart = () => {
      speechStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      researchHostSpeechPauseAtRef.current = null;
    };
    recognition.onspeechend = () => {
      researchHostSpeechPauseAtRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
    };
    recognition.onresult = (event: any) => {
      const transcriptState = accumulateResearchHostTranscript({
        finalText: researchHostWakeTranscriptRef.current,
        event,
      });
      researchHostWakeTranscriptRef.current = transcriptState.finalText;
      dispatchResearchHostVoice({
        type: "transcript",
        text: transcriptState.displayText,
        final: !transcriptState.interimText && Boolean(transcriptState.finalText),
      });
      if (transcriptState.interimText || !transcriptState.finalText) return;
      const transcript = transcriptState.finalText;
      const voicePauseAt = researchHostSpeechPauseAtRef.current
        ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
      const observedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (isResearchHostPlaybackEcho({
        transcript,
        activeText: narrationState.active?.text || "",
        recent: researchHostPlaybackEchoRef.current,
        now: observedAt,
      })) {
        researchHostWakeTranscriptRef.current = "";
        researchHostSpeechPauseAtRef.current = null;
        speechStartedAt = null;
        return;
      }
      if (isResearchHostWakeEcho({
        transcript,
        awaiting: researchHostWakeAwaitingRef.current,
        assistantSpeech: researchHostWakeEchoRef.current.text,
        assistantSpeechAt: researchHostWakeEchoRef.current.spokenAt,
        now: observedAt,
      })) {
        researchHostWakeTranscriptRef.current = "";
        researchHostSpeechPauseAtRef.current = null;
        speechStartedAt = null;
        return;
      }
      const awaitingCommand = researchHostWakeAwaitingRef.current;
      const wake = awaitingCommand
        ? { matched: true, command: transcript }
        : researchHostWakeCommand(transcript);
      if (!wake.matched) return;
      // A final, explicitly addressed utterance owns the next turn. Revoke it
      // before cancellation/submission so late final/end cannot submit twice.
      researchHostRecognitionModeRef.current = null;
      abortResearchHostRecognition(researchHostRecognitionRef, "ended");
      dispatchResearchHostVoice({ type: "wake-listening", listening: false });
      interruptResearchHostWork("speechstart", speechStartedAt ?? observedAt);
      if (!wake.command) {
        researchHostWakeAwaitingRef.current = true;
        const wakePrompt = "我在，请说。";
        const echo = { text: wakePrompt, spokenAt: Number.NaN };
        researchHostWakeEchoRef.current = echo;
        dispatchResearchHostVoice({ type: "wake-heard", awaiting: true });
        // A pending native TTS stop must finish before the new acknowledgement.
        void Promise.resolve(researchHostCancelCompletionRef.current).then(() => {
          if (!researchHostWakeArmedRef.current || document.visibilityState !== "visible"
            || !researchHostWakeAwaitingRef.current || researchHostWakeEchoRef.current !== echo) return;
          enqueueResearchHostSentence(wakePrompt, ++researchHostSentenceSequenceRef.current);
          scheduleResearchHostWake(1_400);
        });
        return;
      }
      researchHostWakeAwaitingRef.current = false;
      researchHostWakeEchoRef.current = { text: "", spokenAt: 0 };
      dispatchResearchHostVoice({ type: "wake-heard", awaiting: false });
      if (awaitingCommand) void submitResearchHostQuestion(transcript, { voicePauseAt });
      else void submitResearchHostQuestion(wake.command, { voicePauseAt });
      scheduleResearchHostWake(550);
    };
    recognition.onerror = (event: any) => {
      dispatchResearchHostVoice({ type: "wake-listening", listening: false });
      researchHostRecognitionModeRef.current = null;
      abortResearchHostRecognition(researchHostRecognitionRef);
      if (["not-allowed", "service-not-allowed"].includes(String(event?.error || ""))) {
        researchHostMicrophoneGrantedRef.current = false;
        researchHostWakeArmedRef.current = false;
        researchHostWakeAwaitingRef.current = false;
        dispatchResearchHostVoice({ type: "wake-armed", enabled: false });
        dispatchResearchHostVoice({ type: "failed", message: "麦克风权限未获允许；请在浏览器站点权限中允许后重试。本页唤醒已关闭。" });
        return;
      }
      scheduleResearchHostWake(researchHostWakeAwaitingRef.current ? 1_400 : 550);
    };
    recognition.onend = () => {
      if (researchHostRecognitionRef.current === recognition) {
        researchHostRecognitionRef.current = null;
        researchHostRecognitionModeRef.current = null;
      }
      dispatchResearchHostVoice({ type: "wake-listening", listening: false });
      scheduleResearchHostWake(researchHostWakeAwaitingRef.current ? 1_400 : 550);
    };
    // start acknowledges the request; audiostart confirms actual capture.
    // https://webaudio.github.io/web-speech-api/#speechreco-events
    recognition.onaudiostart = () => dispatchResearchHostVoice({ type: "wake-listening", listening: true });
    recognition.onaudioend = () => dispatchResearchHostVoice({ type: "wake-listening", listening: false });
    guardResearchHostRecognition(recognition, researchHostRecognitionRef, {
      mode: "wake", onObservation: (observation: any) => dispatchResearchHostVoice({ type: "recognition-observed", observation }),
    });
    dispatchResearchHostVoice({ type: "wake-listening", listening: false });
    try {
      recognition.start();
    } catch {
      abortResearchHostRecognition(researchHostRecognitionRef, "start-failed");
      researchHostRecognitionModeRef.current = null;
      dispatchResearchHostVoice({ type: "wake-listening", listening: false });
      scheduleResearchHostWake(900);
    }
  }, [ensureResearchHostMicrophoneAccess, interruptResearchHostWork, scheduleResearchHostWake, submitResearchHostQuestion]);

  useEffect(() => {
    startResearchHostWakeRef.current = startResearchHostWakeListening;
  }, [startResearchHostWakeListening]);

  useEffect(() => {
    if (!researchHostVoice.recognitionSupported || !researchHostWakePreferredRef.current) return undefined;
    let disposed = false;
    void (async () => {
      const permissions = typeof navigator !== "undefined" ? navigator.permissions : null;
      const permission = await inspectResearchHostMicrophonePermission({ permissions });
      if (disposed || duplexVoiceOwned || permission?.status !== "granted" || !researchHostWakePreferredRef.current) return;
      researchHostMicrophoneGrantedRef.current = true;
      researchHostWakeArmedRef.current = true;
      dispatchResearchHostVoice({ type: "wake-armed", enabled: true });
      scheduleResearchHostWake(0);
    })();
    return () => { disposed = true; };
  }, [researchHostVoice.recognitionSupported, scheduleResearchHostWake]);

  useEffect(() => {
    const onVisibilityChange = () => {
      setResearchHostPageVisible(document.visibilityState === "visible");
      if (document.visibilityState !== "visible") {
        researchHostPttRequestRef.current = null;
        researchHostWakeAwaitingRef.current = false;
        researchHostWakeEchoRef.current = { text: "", spokenAt: 0 };
        dispatchResearchHostVoice({ type: "wake-heard", awaiting: false });
        if (researchHostRecognitionModeRef.current === "ptt") {
          researchHostRecognitionModeRef.current = null;
          abortResearchHostRecognition(researchHostRecognitionRef);
          dispatchResearchHostVoice({ type: "interrupted" });
        }
        if (researchHostRecognitionModeRef.current === "wake") {
          researchHostRecognitionModeRef.current = null;
          abortResearchHostRecognition(researchHostRecognitionRef);
          dispatchResearchHostVoice({ type: "wake-listening", listening: false });
        }
        return;
      }
      scheduleResearchHostWake(250);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [scheduleResearchHostWake]);

  const toggleResearchHostWake = useCallback(async (enabled: boolean) => {
    if (enabled && duplexVoiceOwned) return;
    const next = Boolean(enabled && researchHostVoice.recognitionSupported);
    researchHostWakePreferredRef.current = Boolean(enabled);
    persistResearchHostWakePreference(Boolean(enabled));
    dispatchResearchHostVoice({ type: "wake-preference", enabled: Boolean(enabled) });
    researchHostWakeAwaitingRef.current = false;
    if (!next) {
      researchHostWakeArmedRef.current = false;
      dispatchResearchHostVoice({ type: "wake-armed", enabled: false });
      if (researchHostWakeTimerRef.current !== null) {
        window.clearTimeout(researchHostWakeTimerRef.current);
        researchHostWakeTimerRef.current = null;
      }
      if (researchHostRecognitionModeRef.current === "wake") {
        researchHostRecognitionModeRef.current = null;
        abortResearchHostRecognition(researchHostRecognitionRef);
        dispatchResearchHostVoice({ type: "wake-listening", listening: false });
      }
      return;
    }
    if (!(await ensureResearchHostMicrophoneAccess())) {
      researchHostWakeArmedRef.current = false;
      dispatchResearchHostVoice({ type: "wake-armed", enabled: false });
      return;
    }
    if (duplexVoiceOwned) return;
    researchHostWakeArmedRef.current = true;
    dispatchResearchHostVoice({ type: "wake-armed", enabled: true });
    scheduleResearchHostWake(0);
  }, [ensureResearchHostMicrophoneAccess, researchHostVoice.recognitionSupported, scheduleResearchHostWake]);

  const startResearchHostListening = useCallback(async () => {
    if (duplexVoiceOwned) return;
    if (
      !researchHostVoice.recognitionSupported ||
      researchHostVoice.phase === "listening" ||
      researchHostPttRequestRef.current ||
      !researchHostContext
    ) return;
    interruptResearchHostWork("ptt", typeof performance !== "undefined" ? performance.now() : Date.now());
    const press = {};
    researchHostPttRequestRef.current = press;
    const allowed = await ensureResearchHostMicrophoneAccess();
    if (researchHostPttRequestRef.current !== press) return;
    researchHostPttRequestRef.current = null;
    if (!allowed) return;
    if (
      researchHostVoice.phase === "listening" ||
      (researchHostRecognitionRef.current && researchHostRecognitionModeRef.current === "ptt") ||
      !researchHostContext
    ) return;
    if (researchHostRecognitionModeRef.current === "wake") {
      researchHostRecognitionModeRef.current = null;
      abortResearchHostRecognition(researchHostRecognitionRef);
      dispatchResearchHostVoice({ type: "wake-listening", listening: false });
    }
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    researchHostRecognitionRef.current = recognition;
    researchHostRecognitionModeRef.current = "ptt";
    researchHostDiscardTranscriptRef.current = false;
    researchHostRecognitionFailedRef.current = false;
    researchHostTranscriptRef.current = "";
    researchHostSpeechPauseAtRef.current = null;
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onspeechstart = () => {
      researchHostSpeechPauseAtRef.current = null;
    };
    recognition.onspeechend = () => {
      researchHostSpeechPauseAtRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
    };
    recognition.onresult = (event: any) => {
      const transcriptState = accumulateResearchHostTranscript({
        finalText: researchHostTranscriptRef.current,
        event,
      });
      researchHostTranscriptRef.current = transcriptState.finalText;
      dispatchResearchHostVoice({
        type: "transcript",
        text: transcriptState.displayText,
        final: !transcriptState.interimText && Boolean(transcriptState.finalText),
      });
    };
    recognition.onerror = (event: any) => {
      if (event?.error === "aborted") return;
      researchHostRecognitionFailedRef.current = true;
      researchHostRecognitionModeRef.current = null;
      abortResearchHostRecognition(researchHostRecognitionRef);
      const permissionDenied = ["not-allowed", "service-not-allowed"].includes(String(event?.error || ""));
      if (permissionDenied) researchHostMicrophoneGrantedRef.current = false;
      dispatchResearchHostVoice({
        type: "failed",
        message: permissionDenied
          ? "麦克风权限未获允许；请在浏览器站点权限中允许后重试。"
          : "没有听清，请按住按钮再说一次。",
      });
      scheduleResearchHostWake(650);
    };
    recognition.onend = () => {
      if (researchHostRecognitionRef.current === recognition) {
        researchHostRecognitionRef.current = null;
        researchHostRecognitionModeRef.current = null;
      }
      const discard = researchHostDiscardTranscriptRef.current;
      const failed = researchHostRecognitionFailedRef.current;
      researchHostDiscardTranscriptRef.current = false;
      researchHostRecognitionFailedRef.current = false;
      if (discard || failed) {
        if (discard) dispatchResearchHostVoice({ type: "interrupted" });
        scheduleResearchHostWake(650);
        return;
      }
      const transcript = researchHostTranscriptRef.current.trim();
      const voicePauseAt = researchHostSpeechPauseAtRef.current
        ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
      if (transcript) void submitResearchHostQuestion(transcript, { voicePauseAt });
      else dispatchResearchHostVoice({ type: "interrupted" });
      scheduleResearchHostWake(650);
    };
    guardResearchHostRecognition(recognition, researchHostRecognitionRef, {
      mode: "ptt", onObservation: (observation: any) => dispatchResearchHostVoice({ type: "recognition-observed", observation }),
    });
    dispatchResearchHostVoice({ type: "listen-started" });
    try {
      recognition.start();
    } catch {
      abortResearchHostRecognition(researchHostRecognitionRef, "start-failed");
      researchHostRecognitionModeRef.current = null;
      dispatchResearchHostVoice({ type: "failed", message: "麦克风暂时无法启动；也可以直接输入问题。" });
      scheduleResearchHostWake(900);
    }
  }, [
    ensureResearchHostMicrophoneAccess,
    interruptResearchHostWork,
    researchHostContext,
    researchHostVoice.phase,
    researchHostVoice.recognitionSupported,
    snapshot.projectionStatus,
    scheduleResearchHostWake,
    submitResearchHostQuestion,
  ]);

  const stopResearchHostListening = useCallback(() => {
    researchHostPttRequestRef.current = null;
    if (researchHostRecognitionModeRef.current !== "ptt" || !researchHostRecognitionRef.current) return;
    researchHostSpeechPauseAtRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
    dispatchResearchHostVoice({ type: "listen-stopping" });
    stopResearchHostRecognition(researchHostRecognitionRef, () => {
      researchHostRecognitionModeRef.current = null;
      dispatchResearchHostVoice({ type: "listen-timeout" });
      scheduleResearchHostWake(650);
    });
  }, [scheduleResearchHostWake]);

  const startDuplexCall = (consent?: any) => {
    if (!personalConnection.allows("realtimeVoice")) return;
    if (duplexVoiceOwned || snapshot.busy || researchHostStateRef.current.nativeActive
      || researchHostStateRef.current.pendingTool || researchHostNativeRequestSlot.current()
      || researchHostCancelCompletionRef.current || !researchHostContext) return;
    const personal = personalConnection.isPersonal();
    const callScope = personal ? personalConnection.scopeKey() : null;
    let personalContext;
    if (personal) {
      if (referenceCleared || !selectedView?.id || snapshot.projectionStatus !== "COMPLETE"
        || personalConversationRetiring || !personalVoiceReady?.configured || personalVoiceReady.active) return;
      try {
        personalContext = personalConnection.voiceContext({ ...consent, card: selectedView.id,
          voiceRevision: personalVoiceReady.revision, wikiSourceRevision: personalConnection.cardSource() === "ima"
            ? wikiSourceMonitor.researchRevision() : null });
      } catch {
        setDuplexState({status:'error',active:false,muted:false,code:'DUPLEX_CONTEXT_INVALID'});
        return;
      }
    }
    duplexVoiceOwned = true;
    // Transfer voice ownership synchronously in the click gesture. Awaiting the
    // stop receipt happens in request(), after AudioContext.resume is initiated.
    researchHostPttRequestRef.current = null;
    researchHostWakeArmedRef.current = false;
    researchHostWakeAwaitingRef.current = false;
    if (researchHostWakeTimerRef.current !== null) window.clearTimeout(researchHostWakeTimerRef.current);
    researchHostWakeTimerRef.current = null;
    researchHostRecognitionModeRef.current = null;
    abortResearchHostRecognition(researchHostRecognitionRef);
    researchHostVadMonitorRef.current?.stop?.();
    researchHostVadMonitorRef.current = null;
    dispatchResearchHostVoice({type:'wake-armed',enabled:false});
    dispatchResearchHostVoice({type:'wake-listening',listening:false});
    dispatchResearchHostVoice({type:'interrupted'});
    const stopped = stopNarration('已切换到连续通话');
    const sessionId = personal ? createResearchHostSessionId() : readOrCreateResearchHostSessionId();
    if (!personal) researchHostSessionIdRef.current = sessionId;
    const context = personal ? personalContext : scopeResearchHostQuestionContext({
      ...researchHostContext, title:researchHostContext.variableTitle,
      stageId:researchHostContext.stage.id, stageLabel:researchHostContext.stage.label,
      summary:selectedCard?.eventSummary || selectedView?.expectationGap || '全局只读研究上下文',
      evidence:[], watchMemory:watchTaskContext(xiaomeiWatchStore.snapshot().state),
      radar:buildResearchHostAgentRadarContext(researchHostRadarIndex,{currentCardId:researchHostContext.cardId}),
    });
    setDuplexTranscript({question:'',answer:'',researchState:''});
    const deferredUiActions = new Map<string, any>();
    // Native done and bridge status can arrive separately. Track ownership
    // synchronously so disconnect never relies on a stale rendered label.
    let nativeResearchPending = false;
    let nativeCallModel: any = null;
    const client = createDuplexClient({
      onDiagnostic:(event: any)=>console.info(JSON.stringify(event)),
      workletUrl:personal ? '/variable-os-desk/personal-voice-worklet' : '/variable-os-desk/rpc?duplex=worklet',
      getContext:()=>({sessionId,context}),
      request:async(action: string,payload: any,{signal}: any)=>{
        if(action==='start' && !await stopped) throw Error('DUPLEX_VOICE_RELEASE_FAILED');
        if(action==='start' && personal && callScope !== personalConnection.scopeKey()) throw Error('DUPLEX_CONTEXT_CHANGED');
        if(personal) return personalConnection.voiceFetch(action,payload,{signal});
        if(!csrfToken) throw Error('DUPLEX_CSRF_UNAVAILABLE');
        // Never automatically retry audio or a billable start request.
        return fetch('/variable-os-desk/rpc?duplex=call',{method:'POST',signal,
          headers:{'content-type':'application/json','x-variable-os-csrf':csrfToken},
          body:JSON.stringify({action,...payload})});
      },
      onState:(next: any)=>{
        const active=['starting','listening','speaking'].includes(next.status);
        duplexVoiceOwned=active;
        setDuplexState({...next,active});
        if(!active) {
          if (personal) {
            setPersonalVoiceCheck(value => value + 1);
          }
          deferredUiActions.clear();
          if(nativeResearchPending) setDuplexTranscript(current=>({...current,
            researchState:'连接中断，研究未完成；可继续核对已有结果'}));
          dispatchResearchHostVoice({type:'answer-finished'});
          setResearchHost((current: any)=>current.nativeActive || current.pendingTool
            ? researchHostReducer(current,{type:'native-event',event:{type:'error',sessionId,
              error:{code:'DUPLEX_NATIVE_STREAM_CLOSED',message:'通话已断开，已请求取消；研究终态请恢复 Session Log 核对。'}}})
            : current);
          void stopNarration(personal ? '通话已结束' : '通话已结束，本机回退可手动启用');
        }
      },
      onEvent:(message: any)=>{
        if(message.type==='native') {
          const event=message.event;
          if(!event || (event.sessionId && event.sessionId !== sessionId)) return;
          if(personal && callScope !== personalConnection.scopeKey()) return;
          if(event.type==='user') {
            nativeResearchPending = true;
            dispatchResearchHostVoice({type:'question-submitted',text:event.text,speechMode:'contextual-v1'});
            if(nativeCallModel) dispatchResearchHostVoice({type:'model-selected',model:nativeCallModel});
          }
          setResearchHost((current: any)=>researchHostReducer(current,{type:'native-event',event}));
          if(event.type==='session') {
            deferredUiActions.clear();
            nativeCallModel = event.model || null;
            dispatchResearchHostVoice({type:'model-selected',model:event.model});
          }
          if(event.type==='tool-result' && event.uiAction && deferredUiActions.size < 32) {
            deferredUiActions.set(String(event.callId || event.seq),event);
          }
          if(event.type==='error' || event.type==='cancellation') deferredUiActions.clear();
          if(event.type==='done') {
            nativeResearchPending = false;
            setDuplexTranscript(current=>({...current,researchState:event.finalText || event.presentation?.text
              ? '研究结果已保留；语音交接状态待核对' : '研究回合已结束；请核对 Session Log'}));
            if(event.presentation) dispatchResearchHostVoice({type:'answer-presentation',presentation:event.presentation,final:true});
            // Written native details are not another TTS job. The cloud voice
            // owns playback; finishing the legacy state keeps fallback usable.
            dispatchResearchHostVoice({type:'answer-finished'});
            const actions=[...deferredUiActions.values()];
            deferredUiActions.clear();
            void (async()=>{
              for(const action of actions) {
                if(!duplexVoiceOwned || duplexClientRef.current !== client) break;
                try { await applyResearchHostNativeUiAction(action); }
                catch { setDuplexTranscript(current=>({...current,researchState:'研究已完成，页面导航未成功；请查看 Session Log'})); }
              }
            })();
          }
          return;
        }
        if(message.type==='status') {
          if(['researching','awaiting-confirmation','cancelling'].includes(message.state)) nativeResearchPending = true;
          else if(['complete','partial','failed','cancelled'].includes(message.state)) nativeResearchPending = false;
          const labels: any={researching:'正在查证', 'awaiting-confirmation':'等待你在页面确认',cancelling:'正在取消',complete:'已完成',partial:'部分完成，请看证据缺口',failed:'未完成',cancelled:'已取消',closed:'已关闭',idle:'空闲'};
          setDuplexTranscript(current=>({...current,researchState:labels[message.state]||'状态待核对'}));return;
        }
        const event=message.type==='provider'?message.event:null;
        if(!event) return;
        if(event.type==='conversation.item.input_audio_transcription.started') setDuplexTranscript(current=>({...current,question:'',answer:''}));
        if(event.type==='conversation.item.input_audio_transcription.delta') setDuplexTranscript(current=>({...current,question:String(event.delta||'').slice(0,1000)}));
        if(event.type==='conversation.item.input_audio_transcription.completed') setDuplexTranscript(current=>({...current,question:String(event.transcript||'').slice(0,1000)}));
        if(event.type==='response.output_text.delta') setDuplexTranscript(current=>({...current,answer:(current.answer+(event.delta||'')).slice(-4000)}));
        if(event.type==='response.output_text.done') setDuplexTranscript(current=>({...current,answer:String(event.text||'').slice(0,4000)}));
      },
    });
    duplexClientRef.current=client;
    void client.start();
  };

  return <div className="vos-root" translate="no">
    <section className="vos-paper-shell">
      <DeskHeader snapshot={snapshot} headingLevel={headingLevel} cardCount={cards.length} />
      {projectionBlocked ? <div className={`vos-projection-blocker${projectionUpdating ? " is-updating" : ""}`} role={projectionUpdating ? "status" : "alert"}>
        <span>{personalDesk ? "当前信源的可读状态尚未确认，卡片、研究及研判操作已暂停。"
          : projectionUpdating ? "正在同步权威账本，投影更新中；完成后将自动恢复，研判与映射暂时暂停。"
            : "投影暂不可用，研判与映射操作已暂停；权威账本未受影响。"}
          {!personalDesk && snapshot.inbox ? " 当前列表为只读快照，尚未追平最新水位。" : ""}</span>
        {!personalDesk && !projectionUpdating ? <button type="button" disabled={Boolean(snapshot.busy)}
          onClick={() => void repairDeskProjection()}>从账本修复投影</button> : null}
      </div> : null}
      {personalConnection.isPersonal() ? <PersonalCardActions /> : null}
      {snapshot.error ? <div className="vos-projection-blocker" role="alert">
        {snapshot.error.code === "FORBIDDEN_SCOPE" ? <><code>FORBIDDEN_SCOPE</code>{" · "}</> : null}
        {friendlyError(snapshot.error)}
      </div> : null}
      {watchCatalystUiEnabled ? <CatalystFunnelNav
        mode={catalystFunnelMode}
        funnel={snapshot.bootstrap?.catalystFunnel}
        blocked={projectionBlocked}
        onSelect={(mode: string) => void selectCatalystFunnel(mode)}
      /> : null}
      <div className={`vos-workbench ${radarExpanded ? "is-radar-expanded" : ""}`}>
        <DeskLayout
          readingFirst={personalConnection.cardSource() === "published"}
          readingScope={personalConnection.scopeKey()}
          readingContent={selectedView?.publishedCard ? <PublishedCardDetails card={selectedView.publishedCard} publication={selectedView.publication} />
            : !selectedView ? <div className="vos-paper-empty" role="status">{projectionBlocked ? "当前信源不可读，请检查连接与授权。" : "当前没有选中的发布卡。"}</div> : undefined}
          referenceRequired={personalConnection.isPersonal()}
          reference={!referenceCleared && selectedView ? { id: selectedView.id, title: selectedView.title, revision: selectedView.revision } : null}
          request={layoutRequest}
          onClearReference={() => { resetPersonalConversation(); setReferenceCleared(true); }}
          pending={deskPendingSummary({ local, host: researchHost, watch: watchSnapshot })}
          onShowAgentApproval={() => document.querySelector<HTMLElement>('.vos-host-confirm button')?.focus()}
          onShowWatchDraft={() => { const panel = document.querySelector<HTMLDetailsElement>('.vos-home-watch-details'); if (panel) { panel.open = true; panel.querySelector<HTMLElement>('summary')?.focus(); } }}
          radar={<>{snapshot.phase === "loading" ? <DeskLoading label={radarLoadingLabel({
        dateFilter: snapshot.radarUi?.dateFilter,
        todayDate: radarTodayDateId(),
      })} /> : !snapshot.inbox ? <div className="vos-paper-empty" role="status">
        <p>尚未取得可读快照</p>
        <p>{personalDesk ? "当前信源的变量数量未知。" : "暂时无法显示变量列表，不代表数据库没有变量。恢复后会自动读取。"}</p>
        <button type="button" disabled={Boolean(snapshot.busy)} onClick={() => void readDesk("reread")}>重新读取快照</button>
      </div> : catalystFunnelMode === "ALL" ? <CatalystSourcePanel
        list={snapshot.sourceList}
        funnel={snapshot.bootstrap?.catalystFunnel}
        uiState={snapshot.watchUi}
        busy={snapshot.sourceBusy}
        error={snapshot.sourceError}
        projectionBlocked={projectionBlocked}
        onFilter={(name: string, value: string) => void filterCatalystWatches(name, value)}
        onSelect={(sourceItemId: string) => selectCatalystSource(sourceItemId)}
        onScroll={(scrollTop: number) => dispatchWatch({ type: "set-scroll", scrollTop })}
        onRefresh={() => void readCatalystSourceList()}
      /> : catalystFunnelMode === "WATCH" ? <CatalystWatchPanel
        list={snapshot.watchList}
        detail={snapshot.watchDetail}
        funnel={snapshot.bootstrap?.catalystFunnel}
        uiState={snapshot.watchUi}
        busy={snapshot.watchBusy}
        error={snapshot.watchError}
        projectionBlocked={projectionBlocked}
        onFilter={(name: string, value: string) => void filterCatalystWatches(name, value)}
        onSelect={(watchId: string) => void selectCatalystWatch(watchId)}
        onToggleReference={(ref: string) => dispatchWatch({ type: "toggle-reference", ref })}
        onDraft={(watchId: string, value: string) => dispatchWatch({ type: "set-draft", watchId, value })}
        onScroll={(scrollTop: number) => dispatchWatch({ type: "set-scroll", scrollTop })}
        onRefresh={() => void readCatalystWatchList()}
      /> : catalystFunnelMode === "DISCARDED" ? <CatalystDiscardPanel
        funnel={snapshot.bootstrap?.catalystFunnel}
        projectionBlocked={projectionBlocked}
      /> : <RadarColumn preserveSelection
          cards={cards}
          views={views}
          uiState={snapshot.radarUi}
          homeFilter={snapshot.homeFilter}
          onHomeFilterChange={(homeFilter: { tab: string; query: string }) => patch({ homeFilter })}
          selectedId={snapshot.selectedCardId}
          pinnedIds={snapshot.prototype.pinnedIds}
          busy={snapshot.busy}
          dataReady={snapshot.phase === "ready"}
          emptyLabel={projectionBlocked ? "投影与账本暂未对齐，今日变量暂不可读。" : undefined}
          onSelect={(id: string, origin = "user") => {
            if (origin === "user" || personalConnection.cardSource() !== "published") {
              setLayoutRequest({ purpose: "details" });
            }
            setReferenceCleared(false);
            void selectDeskCard(id);
          }}
          onClearSelection={() => void selectDeskCard(null)}
          onTogglePin={(id: string) => dispatch({ type: "toggle-pin", cardId: id })}
          onUiChange={dispatchRadarUi}
          onReread={() => void readDesk("reread")}
          narration={narration}
          onToggleAutoNarration={() => {
            const enabled = !narration.autoEnabled;
            setAutoNarration(enabled, cards);
            if (enabled) void narrateLatestRadar(cards);
          }}
          onAutoNarrationScopeChange={setAutoNarrationScope}
          expanded={radarExpanded}
          onCollapse={() => setRadarExpanded(false)}
        />}
        <button
          className="vos-radar-resize-handle"
          type="button"
          aria-label={radarExpanded ? "收起雷达为单列" : "展开雷达为双列"}
          aria-pressed={radarExpanded}
          title={radarExpanded ? "向左拖动或点击，返回三栏卷宗" : "向右拖动或点击，展开双列雷达"}
          onClick={toggleRadarExpanded}
          onPointerDown={startRadarResize}
          onPointerMove={moveRadarResize}
          onPointerUp={endRadarResize}
          onPointerCancel={endRadarResize}
          onMouseDown={startRadarResizeMouse}
        ><span aria-hidden="true">{radarExpanded ? "‹" : "›"}</span></button></>}
        workspace={<>{personalConnection.isPersonal() ? <IndependentResearchPanel call={remoteRpc} subscribe={subscribeIndependentResearch} /> : null}<TimelineColumn assistantOnly researchScopeKey={wikiSourceGeneration}
          personalResearch={personalConnection.isPersonal()} researchSource={personalConnection.cardSource()}
          webResearchAvailable={personalConnection.allows("webResearch")}
          webRequiresApiSupplement={personalConnection.allows("webRequiresApiSupplement")}
          publishedResearchAvailable={personalConnection.allows("conversationPublishedResearch")}
          draftApprovalAvailable={personalConnection.allows("conversationDrafts")}
          onChangeConversationPlan={resetPersonalConversation}
          onLoadHistory={loadPersonalHistory} onRestoreHistory={restorePersonalHistory}
          personalRetirementState={personalRetirementState} onRetryPersonalRetirements={retryPersonalRetirements}
          view={selectedView}
          local={local}
          activeStageId={activeStageId}
          activeTimelineNodeId={activeTimelineNodeId}
          evidenceDetails={snapshot.evidenceDetails}
          evidenceDetailErrors={snapshot.evidenceDetailErrors}
          deepResearch={selectedView ? snapshot.deepResearch[selectedView.id] : null}
          researchHostContext={researchHostContext}
          researchHost={researchHost}
          watchPanel={!personalConnection.allows("researchAssistant") ? null : <details className="vos-home-watch-details" open={Boolean(watchSnapshot.draft)}><summary>关注任务与提醒 · {watchSnapshot.state.tasks.filter((task: any) => task.status === "active").length} 项关注中 · {watchSnapshot.state.alerts.length} 条动态</summary><ResearchHostWatchPanel snapshot={watchSnapshot}
            blocked={personalReadOnly || snapshot.projectionStatus !== "COMPLETE"} busy={watchBusy} autoNarration={narration.autoEnabled}
            speechReady={narration.unlocked} speechSupported={narration.supported} onUnlockSpeech={() => patchNarration({ unlocked: true })}
            onCreate={async (draft: any) => {
              if (state.projectionStatus !== "COMPLETE") return false;
              const saved = await xiaomeiWatchStore.transact((watch: any) => addWatchTask(watch, draft, researchHostRadarIndex,
                { id: `watch-${crypto.randomUUID()}` }));
              if (saved && draft.priority !== "quiet") patchNarration({ unlocked: true });
              return saved;
            }}
            onStatus={updateWatchTaskStatus} onDismissDraft={() => xiaomeiWatchStore.draft(null)}
            onClearEnded={() => void xiaomeiWatchStore.transact((watch: any) => ({ ...watch,
              tasks: watch.tasks.filter((t: any) => !["cancelled", "expired"].includes(t.status)) }))}
            onOpenCard={(id: string) => { setReferenceCleared(false); setLayoutRequest({ purpose: "details" }); void selectDeskCard(id); }}
            onSpeak={(alert: any) => {
              if (watchBusy || narrationState.active || !narrationState.supported) return false;
              enqueueWatchSpeech({ ...alert, id: `watch-preview-${alert.id}` });
              return true;
            }} /></details>}
          researchHostVoice={researchHostVoice}
          researchHostRecovery={researchHostRecoveryState(researchHost, researchHostVoice, narration)}
          researchHostSpeech={narration}
          onToggleResearchHostNarration={(enabled: boolean) => {
            patchNarration({ replyEnabled: enabled, message: enabled ? "本页研究回应播报已开启" : "研究回应播报已关闭" });
            if (!enabled) void stopNarration("研究回应播报已关闭");
          }}
          duplex={{...duplexState,...duplexTranscript,mode:duplexMode,
            available:personalConnection.allows("realtimeVoice") && (!personalConnection.isPersonal()
              || Boolean(personalVoiceReady?.configured && !personalVoiceReady.active)),
            revision:personalVoiceReady?.revision ?? "",
            refresh:()=>setPersonalVoiceCheck(value=>value+1),
            selectMode:(mode: string)=>{if(!duplexVoiceOwned)setDuplexMode(mode);},
            start:startDuplexCall,hangup:()=>void duplexClientRef.current?.hangup(),
            toggleMute:()=>void duplexClientRef.current?.setMuted(!duplexState.muted),
            stopSpeaking:()=>void duplexClientRef.current?.stopSpeaking(),
            cancelResearch:()=>void duplexClientRef.current?.cancelResearch()}}
          onSelectResearchHostVoice={async (voice: string) => {
            if (duplexVoiceOwned) return;
            if (state.busy || researchHostStateRef.current.nativeActive || researchHostStateRef.current.pendingTool
              || researchHostCancelCompletionRef.current || researchHostNativeRequestSlot.current()
              || ["thinking", "answering", "listening"].includes(researchHostVoicePhaseRef.current)
              || narrationStopsPending || narrationState.active || narrationState.queue.length) return;
            narrationStopsPending += 1;
            try {
              const result = await runHostNarrationCommand({ action: "selectVoice", voice });
              if (result.ok) { configureNarrationBackend(result.result); patchNarration({ status: "idle", message: "音色已选择，可点击试听声音" }); }
              else patchNarration({ status: "error", message: friendlyError(result.error) });
            } finally { narrationStopsPending -= 1; pumpNarrationQueue(); }
          }}
          onPreviewResearchHostSpeech={async () => {
            const canPreview = () => {
              if (duplexVoiceOwned) return false;
              const host = researchHostStateRef.current;
              return document.visibilityState === "visible" && !state.busy && !host.nativeActive && !host.pendingTool
                && !researchHostCancelCompletionRef.current && !researchHostNativeRequestSlot.current()
                && !["thinking", "answering", "listening"].includes(researchHostVoicePhaseRef.current)
                && !narrationStopsPending && !narrationState.active && !narrationState.queue.length
                && narrationState.supported;
            };
            if (!canPreview()) return;
            if (narrationState.status === "error"
              && (!await stopNarration("正在重试本机播报") || !canPreview())) return;
            // An explicit, fixed local audition is not an Agent reply and must
            // never contribute a voice-turn first-answer latency sample.
            enqueueResearchHostSentence("这是本机语音试听。涨幅2.5%。你可以随时点打断停止播放。", ++researchHostSentenceSequenceRef.current, undefined, true);
          }}
          onContinueResearchHost={(consent: any) => recoverResearchHostAnswer("continue", consent)}
          onReplayResearchHost={() => recoverResearchHostAnswer("replay")}
          researchHostBusy={Boolean(snapshot.busy) || (personalConnection.isPersonal()
            ? !personalConnection.allows("researchConversation") || !selectedView || referenceCleared || projectionBlocked
              || personalConversationRetiring || Boolean(researchHostCancelCompletionRef.current) || ["thinking", "answering"].includes(researchHostVoice.phase)
              || personalHistoryRestoring
            : !personalConnection.allows("researchAssistant"))}
          blocked={projectionBlocked || Boolean(snapshot.busy)}
          canSwitchResearchHostCard={cards.length > 1}
          onToggleResearchHost={() => setResearchHost((current: any) => researchHostReducer(current, { type: "toggle-expanded" }))}
          onRequestResearchHostTool={requestResearchHostTool}
          onConfirmResearchHostTool={confirmResearchHostTool}
          onCancelResearchHostTool={cancelResearchHostTool}
          onSubmitResearchHostQuestion={(question: string, consent: any) => void submitResearchHostQuestion(question, consent)}
          onStartResearchHostListening={startResearchHostListening}
          onStopResearchHostListening={stopResearchHostListening}
          onInterruptResearchHostVoice={interruptResearchHostVoice}
          onToggleResearchHostWake={toggleResearchHostWake}
          onExpandEvidence={loadEvidenceDetail}
          onDeepResearch={(force: boolean) => void runDeepResearch(selectedView, force)}
          onDispatch={dispatch}
          emptyLabel={deskColumnEmptyLabel({ column: "timeline", projectionBlocked, busy: Boolean(snapshot.busy) })}
        /></>}
        details={<TimelineColumn showResearchHost={false} researchScopeKey={wikiSourceGeneration}
          view={selectedView} local={local} activeStageId={activeStageId} activeTimelineNodeId={activeTimelineNodeId}
          evidenceDetails={snapshot.evidenceDetails} evidenceDetailErrors={snapshot.evidenceDetailErrors}
          deepResearch={selectedView ? snapshot.deepResearch[selectedView.id] : null}
          deepResearchAvailable={personalConnection.allows("deepResearch")}
          webResearchAvailable={personalConnection.allows("webResearch")}
          webRequiresApiSupplement={personalConnection.allows("webRequiresApiSupplement")}
          apiSupplementAvailable={personalConnection.allows("apiSupplement")}
          researchSource={personalConnection.cardSource()}
          personalResearch={personalConnection.isPersonal()}
          onCancelDeepResearch={() => personalResearchControllers.get(selectedView?.id)?.abort()}
          onChangeResearchScope={(scope: "selected" | "library") => changeDeepResearchScope(selectedView?.id, scope)}
          onExpandEvidence={loadEvidenceDetail} onDeepResearch={(force: boolean, consent: any) => void runDeepResearch(selectedView, force, undefined, consent)}
          onDispatch={dispatch} blocked={personalReadOnly || projectionBlocked || Boolean(snapshot.busy)}
          emptyLabel={selectedCard ? "当前参考卷宗暂不可读；可重新读取，未自动切换其他卡片。" : personalConnection.isPersonal() ? "尚未选择参考卡片" : "选择卡片查看详情；小美仍可全局问答。"}
        />}
        versionNotice={newerReference ? <div role="status" className="vos-home-version-notice">有新版本；{referenceCleared ? '参考已清除，详情与草稿' : '当前参考与未提交草稿'}仍留在第 {selectedCard.revision || 1} 版。<button type="button" onClick={() => { setReferenceCleared(false); void selectDeskCard(cardId(newerReference)); }}>主动查看新版本</button></div> : null}
        decision={<DecisionColumn
          key={personalConnection.isPersonal() ? `${personalConnection.scopeKey()}:${selectedView?.id ?? ""}` : "local"}
          view={selectedView}
          local={local}
          personal={personalConnection.isPersonal()}
          source={personalConnection.cardSource()}
          autoJudgmentAvailable={personalConnection.allows("autoJudgment")}
          busy={snapshot.busy}
          blocked={personalReadOnly || projectionBlocked}
          narration={narration}
          onDispatch={dispatch}
          onAutoJudgment={(consent: any) => void runAutoJudgment(selectedView, undefined, consent)}
          onCancelAutoJudgment={cancelPersonalJudgment}
          onNarrate={() => void enqueueDeskNarration(selectedView, local)}
          onSubmit={() => void submitJudgment(selectedCard)}
          onMappingReview={(mapping: any, review: string, correction?: string) => void submitMappingReview(selectedCard, mapping, review, correction)}
          onReveal={() => void revealFeedback(selectedCard)}
          emptyLabel={deskColumnEmptyLabel({ column: "decision", projectionBlocked, busy: Boolean(snapshot.busy) })}
        />}
        />
      </div>
      <div className="vos-live-region" role="status" aria-live="polite">{snapshot.prototype.activity}</div>
      {selectedView && local.recordEditorOpen ? <RecordEditor view={selectedView} local={local} onDispatch={dispatch} onClose={closeEditor} dialogRef={editorRef} blocked={personalReadOnly || projectionBlocked || Boolean(snapshot.busy)} /> : null}
    </section>
  </div>;
}

function DeskOverlay() {
  useDeskStyles();
  const snapshot = useDeskState();
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => patch({ overlayOpen: false }), []);
  useFocusTrap(snapshot.overlayOpen, dialogRef, close);
  if (!snapshot.overlayOpen) return null;
  return <div ref={dialogRef} className="vos-overlay" role="dialog" aria-modal="true" aria-label="变量发现台">
    <button className="vos-overlay-close" type="button" aria-label="关闭变量发现台" onClick={close}><DeskIcon name="close" /></button>
    <DeskSurface headingLevel={2} />
  </div>;
}

function EmbeddedDeskSurface() {
  const snapshot = useDeskState();
  return snapshot.overlayOpen ? null : <DeskSurface headingLevel={1} />;
}

function SidebarAction({ wide }: { wide?: boolean }) {
  useDeskStyles();
  return <Button className="vos-footer-action" data-wide={wide ? "true" : "false"} size="sm" variant="ghost" aria-label="打开变量发现台" onClick={() => patch({ overlayOpen: true })}><DeskIcon name="crosshair" size={18} /><span>变量发现台</span></Button>;
}

function InputDock() {
  useDeskStyles();
  const snapshot = useDeskState();
  const narration = useNarrationState();
  const hasActiveNarration = Boolean(narration.active || narration.queue.length);
  const message = narration.status === "idle" && !hasActiveNarration
    ? snapshot.prototype.activity
    : narration.message;
  return <div className={`vos-copilot-dock tone-${snapshot.prototype.activityTone} voice-${narration.status}`}>
    <span className="vos-copilot-icon"><DeskIcon name="sparkle" size={18} /></span>
    <span role="status" aria-live="polite"><strong>DeepSeek 研究助手</strong><small>{message}</small></span>
    <span className={`vos-wave ${narration.status === "speaking" ? "is-speaking" : ""}`} aria-hidden="true"><i /><i /><i /><i /><i /></span>
    <div className="vos-narration-controls" aria-label="语音播报控制">
      <select aria-label="播报语速" disabled={!narration.supported} value={narration.rate} onChange={(event) => setNarrationRate(Number(event.target.value))}>
        <option value="0.8">0.8×</option>
        <option value="1">1.0×</option>
        <option value="1.2">1.2×</option>
      </select>
      {narration.status === "speaking" ? <button type="button" aria-label="暂停播报" title="暂停播报" onClick={pauseNarration}><DeskIcon name="pause" size={14} /></button> : null}
      {narration.status === "paused" ? <button type="button" aria-label="继续播报" title="继续播报" onClick={resumeNarration}><DeskIcon name="play" size={14} /></button> : null}
      {hasActiveNarration ? <button type="button" aria-label="停止播报" title="停止播报" onClick={() => void stopNarration()}><DeskIcon name="stop" size={14} /></button> : null}
    </div>
    <button type="button" onClick={() => patch({ overlayOpen: true })}>打开变量台</button>
  </div>;
}

async function wikiSourceRpc(method: string, params = {}, options = {}) {
  if (personalConnection.isPersonal()) return remoteRpc(method, params, options);
  const result = await rpc(method, params, options);
  if (!result.ok) throw Object.assign(Error("Wiki source request failed"), { code: result.error?.code });
  if (["wikiSourceConfigure", "wikiSourceCredentials"].includes(method)) wikiSourceMonitor.observe(result.result);
  return result.result;
}

function SettingsSection() {
  const [voiceStatus, setVoiceStatus] = useState<any>(null);
  const [voiceReadVersion, setVoiceReadVersion] = useState(0);
  return <section className="vos-service-settings" aria-label="服务配置">
    <h2 style={{ fontSize: 18, margin: "0 0 12px", letterSpacing: 0 }}>服务配置</h2>
    {personalConnection.isPersonal() ? <SourceConnectionSettings call={remoteRpc} /> : null}
    <WikiSourceSettings call={wikiSourceRpc} onChange={invalidateWikiResearch} />
    {personalConnection.isPersonal() ? <ModelServiceSettings call={remoteRpc} /> : null}
    {personalConnection.isPersonal() ? <WebResearchSettings call={remoteRpc} /> : null}
    {personalConnection.isPersonal() ? <VoiceServiceSettings call={remoteRpc}
      onStatus={setVoiceStatus} readVersion={voiceReadVersion} /> : null}
    <DeskDiagnosticsSection voiceStatus={voiceStatus} onRead={() => setVoiceReadVersion(value => value + 1)} />
  </section>;
}

function DeskDiagnosticsSection({ voiceStatus, onRead }: any = {}) {
  useDeskStyles();
  const snapshot = useDeskState();
  const narration = useNarrationState();
  // Publication readiness can change without remounting the credential forms.
  useEffect(() => { if (state.phase === "idle") void readDesk("diagnose"); },
    [snapshot.phase, personalConnection.scopeKey()]);
  const diagnostics = snapshot.bootstrap?.diagnostics;
  const health = snapshot.bootstrap?.health;
  const sourceRuntime = snapshot.bootstrap?.sourceRuntime;
  const personal = personalConnection.isPersonal();
  const pipelines = sourcePipelineHealth(sourceRuntime);
  const rows = personal ? [
    ["状态权威", personalConnection.cardSource() === "published" ? "业主发布原卡" : "个人账本"],
    ["投影状态", translateStatus(health?.projectionStatus || snapshot.projectionStatus)],
    ["连接状态", sourceConnectionLabel(snapshot.bootstrap?.source?.connection)],
    ["信源接收", publicationIntakeLabel(snapshot.bootstrap?.wikiIntake ?? snapshot.bootstrap?.publicationIntake)],
    ["模型配置", modelReadinessLabel(diagnostics?.modelService)],
    ["成卡", personalConnection.allows("cardGeneration") ? "按次授权 · 当前 Host 模型" : "未配置"],
    ["授权资料补证", personalConnection.allows("deepResearch") ? "按次授权 · 当前 Host 模型" : "未配置"],
    ["网页检索", webReadinessLabel(diagnostics?.webService)],
    ["当前卡片对话", personalConnection.allows("researchConversation") ? "按次授权 · 当前 Host 模型" : "未配置"],
    ["本机播报", narration.supported ? narration.replyEnabled ? "研究回应播报已开启" : "可用 · 研究回应播报未开启" : "当前设备不可用"],
    ["连续通话", voiceSettingsLabel(voiceStatus)],
    ["研究快照", health?.snapshotId || "尚未读取"],
    ["账本水位", health?.ledgerWatermark || "尚未读取"],
    ["资料截止", health?.marketCutoff || "UNKNOWN"],
  ] : [
    ["投影状态", translateStatus(health?.projectionStatus || snapshot.projectionStatus)],
    ["持续信源", sourceRuntimeLabel(sourceRuntime)],
    ["自动同步", liveSyncLabel(sourceRuntime?.liveSync)],
    ...pipelines.map((pipeline) => [`${pipeline.name}资料`, `${pipeline.sourceAgeLabel} · ${pipeline.checkLabel}`]),
    ["分析队列", sourceQueueLabel(sourceRuntime?.queue)],
    ["模型熔断", analysisCircuitLabel(sourceRuntime?.analysisCircuit)],
    ["Token 预算", analysisTokenBudgetLabel(sourceRuntime?.analysisTokenBudget)],
    [
      "分析通道",
      Number(diagnostics?.harnessModel?.analysisConcurrencyLimit || 0) >= 4
        ? "四通道 · 最新线索优先 + 历史积压清理"
        : Number(diagnostics?.harnessModel?.analysisConcurrencyLimit || 0) === 2
          ? "双通道 · 最新线索优先 + 历史积压清理"
          : "单通道",
    ],
    ["语音播报", narration.supported ? narration.autoEnabled ? "本机语音可用 · 自动播报已开启" : "本机语音可用 · 自动播报未开启" : "当前浏览器不支持"],
    ["最近一轮", sourceLatestRunLabel(sourceRuntime?.latestRun)],
    ["最近一轮耗时", sourceCycleTimingsLabel(sourceRuntime?.latestRun)],
    ["最近模型耗时", sourceAnalysisLatencyLabel(sourceRuntime?.latestAnalysis)],
    ["研究快照", health?.snapshotId || "尚未生成"],
    ["账本水位", health?.ledgerWatermark || "尚未读取"],
    ["资料截止", health?.marketCutoff || "待确认"],
    ["证据分析", diagnostics?.remoteModelConfigured ? diagnostics?.model || "远端模型" : "本地结构解析（远端模型未启用）"],
    ["变量台版本", diagnostics?.version || "正式工作台"],
    ["微信冻结源", diagnostics?.dataSources?.wechat || "未配置"],
    ["六度确认源", diagnostics?.dataSources?.liudu || "未配置"],
  ];
  return <section className="vos-settings" translate="no">
    <h2>变量发现台诊断与维护</h2>
    {personal ? <p role="status">个人账本；信源、模型与语音按配置和显式授权启用。</p> : <p>实时控制器每 5 分钟执行一次外部信源同步和本地证据分析；界面每 60 秒读取管线健康。每轮只执行一次，不自动重试。JSONL 是权威研究账本，SQLite 只保存可重建的运行状态和投影。</p>}
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <section className="vos-settings-group vos-settings-readonly" aria-labelledby="vos-settings-readonly-title">
      <h3 id="vos-settings-readonly-title">只读诊断</h3><p>只重新读取当前状态，不写入账本、不触发信源同步。</p>
      <div className="vos-settings-actions"><Button variant="primary" disabled={Boolean(snapshot.busy)}
        onClick={() => { onRead?.(); void readDesk("diagnose"); }}>重新读取诊断</Button></div>
    </section>
    <section className="vos-settings-group vos-settings-side-effects" aria-labelledby="vos-settings-side-effects-title">
      <h3 id="vos-settings-side-effects-title">有副作用操作</h3>
      {!personal ? <p>会触碰投影、扫描本地资料或访问外部信源；执行前请确认当前操作范围。</p> : null}
      <div className="vos-settings-actions">
        <Button disabled={personal || Boolean(snapshot.busy)} onClick={() => void repairDeskProjection()}>修复投影</Button>
        <Button disabled={personal || Boolean(snapshot.busy)} onClick={() => void refreshDeskSources()}>只扫描本地资料</Button>
        <Button disabled={!personalConnection.allows("sourceIntake") || Boolean(snapshot.busy)} onClick={() => void syncLatestSources()}>立即同步全部信源</Button>
      </div>
    </section>{snapshot.error ? <p role="alert">
      {snapshot.error.code === "FORBIDDEN_SCOPE" ? <><code>FORBIDDEN_SCOPE</code>{" · "}</> : null}
      {friendlyError(snapshot.error)}
    </p> : null}
  </section>;
}

function ToolResultCard(props: any) {
  useDeskStyles();
  const block = props?.block;
  const failed = Boolean(block?.error || block?.result?.isError);
  const settled = Boolean(block?.status === "settled" || block?.result || block?.output);
  return <div className="vos-tool-card"><StateDot state={failed ? "error" : settled ? "done" : "ongoing"} /><span><strong>{TOOL_LABELS[props.toolName] || "变量研究工具"}</strong><small>{failed ? "处理失败，请展开查看详情" : settled ? "处理完成" : "正在处理"}</small></span></div>;
}

export const name = "variable-os-desk-ui-client";
export const inject = ["slots"];

function invalidateWikiResearch() {
  invalidateIndependentResearch();
  wikiSourceGeneration++;
  for (const controller of personalResearchControllers.values()) controller.abort();
  personalResearchControllers.clear();
  patch({ deepResearch: {} });
  if (personalConnection.isPersonal() && personalConnection.cardSource() === "ima") personalConnection.invalidate();
}
let observedWikiGeneration = wikiSourceMonitor.snapshot().generation;
wikiSourceMonitor.subscribe(snapshot => {
  if (snapshot.generation === observedWikiGeneration) return;
  observedWikiGeneration = snapshot.generation;
  invalidateWikiResearch();
});

let observedReadingScope = personalConnection.readingScopeKey();
personalConnection.subscribe(() => {
  const readingScope = personalConnection.readingScopeKey();
  const preserveReading = personalConnection.isPersonal() && personalConnection.cardSource() === 'published'
    && readingScope === observedReadingScope;
  observedReadingScope = readingScope;
  cancelPersonalJudgment();
  personalCardRequest?.abort(); personalCardRequest = null;
  deskReadGeneration++; wikiSourceGeneration++;
  deskReadRequest = null; sourceHealthRequest = null; csrfToken = null;
  casefileVersions.clear(); casefileRequests.clear(); evidenceRequests.clear();
  researchHostNativeRequestSlot.abort();
  replaceResearchHostSessionId();
  sharedResearchHostState = createResearchHostState();
  patch({ phase: "idle", busy: null, bootstrap: null, inbox: null, snapshotReadOnly: false,
    casefiles: {}, evidenceDetails: {}, evidenceDetailErrors: {}, deepResearch: {},
    // Retain only navigation intent across a connected publication revision.
    // All original content and research state above are still retired first.
    selectedCardId: preserveReading ? state.selectedCardId : null,
    projectionStatus: null, error: null, prototype: createPrototypeState(),
    watchUi: createCatalystWatchUiState(),
    radarUi: preserveReading ? state.radarUi : createRadarUiState(),
    homeFilter: preserveReading ? state.homeFilter : { tab: 'all', query: '' },
    watchList: null, watchDetail: null, sourceList: null });
  configureNarrationBackend(null);
});

export function apply(ctx: any) {
  if (!ctx.slots) return;
  const slots = providerSlots(ctx.slots);
  if (publicSetupMarker((window as any).__VARIABLE_OS_PUBLIC_SETUP__)) {
    slots.inject("settings.onboarding", function* () {
      // Native rc.2 elects the lowest priority; the official entry defaults to 0.
      yield slots.register({ name: "settings.onboarding", id: "deepseek-official", order: 0, priority: -100 },
        (props: any) => <PublicOnboarding {...props} openDesk={() => patch({ overlayOpen: true })} />);
    });
  }
  slots.inject("conversation.view", () =>
    slots.inject("conversation.input.dock", () =>
      slots.inject("sidebar.footer.action", () =>
        slots.inject("shell.overlay", () =>
          slots.inject("settings.section", () =>
            slots.inject("tool.call.toolview", function* () {
              yield slots.register({ name: "conversation.view", id: "variable-desk", order: 30, label: () => "变量台" }, EmbeddedDeskSurface);
              yield slots.register({ name: "conversation.input.dock", id: "variable-desk-status", order: 30 }, InputDock);
              yield slots.register({ name: "sidebar.footer.action", id: "variable-desk-open", order: 30 }, SidebarAction);
              yield slots.register({ name: "shell.overlay", id: "variable-desk-overlay", order: 30 }, DeskOverlay);
              yield slots.register({ name: "settings.section", id: "variable-os-desk", order: 45, label: () => "变量发现台" }, SettingsSection);
              for (const toolName of TOOL_NAMES) {
                yield slots.register({ name: "tool.call.toolview", key: toolName, id: `variable-os-${toolName}` }, ToolResultCard);
              }
            }),
          ),
        ),
      ),
    ),
  );
}
