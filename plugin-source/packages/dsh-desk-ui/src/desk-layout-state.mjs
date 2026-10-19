// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
// Layout-only state: no Session, draft content, tool calls or write commands.
const MODES = new Set(['intraday', 'research']);
export function createDeskLayoutState(preference, width = 1440) {
  const value = preference && typeof preference === 'object' && !Array.isArray(preference) ? preference : {};
  return {
    mode: MODES.has(value.mode) ? value.mode : 'intraday',
    leftOpen: typeof value.leftOpen === 'boolean' ? value.leftOpen : width >= 960,
    leftWidth: Number.isFinite(value.leftWidth) ? Math.min(440, Math.max(280, value.leftWidth)) : 320,
    drawer: { open: false, purpose: 'details' },
  };
}
export function deskLayoutReducer(state, action) {
  switch (action.type) {
    case 'measure': return measureDeskLayout(state, action.width, action.hasPreference);
    case 'set-mode': return MODES.has(action.mode) ? { ...state, mode: action.mode } : state;
    case 'toggle-left': return { ...state, leftOpen: !state.leftOpen,
      drawer: action.width < 960 && !state.leftOpen ? { ...state.drawer, open: false } : state.drawer };
    case 'resize-left': return Number.isFinite(action.width)
      ? { ...state, leftWidth: Math.min(440, Math.max(280, action.width)) } : state;
    case 'open-drawer': return { ...state, leftOpen: action.width < 960 ? false : state.leftOpen,
      drawer: { open: true, purpose: action.purpose === 'decision' ? 'decision' : 'details' } };
    case 'read-card': return { ...state, leftOpen: action.width < 960 ? false : state.leftOpen,
      drawer: { ...state.drawer, open: false } };
    case 'close-drawer': return { ...state, drawer: { ...state.drawer, open: false } };
    default: return state;
  }
}
export function deskLayoutGeometry(state, width) {
  const container = Number.isFinite(width) && width > 0 ? width : 1440;
  const listOverlay = container < 960;
  const railWidth = state.leftOpen && !listOverlay ? state.leftWidth : 44;
  return { listOverlay, railWidth, drawerWidth: Math.min(420, container),
    docked: container >= 1360 && container - railWidth - 420 >= 560 };
}
export function deskLayoutPreference(state) {
  return { mode: state.mode, leftOpen: state.leftOpen, leftWidth: state.leftWidth };
}
export function deskPendingSummary({ local = {}, host = {}, watch = {} } = {}) {
  const draft = Boolean(local.dirty && local.submitState !== 'submitting');
  const agent = Boolean(host.pendingTool);
  const watchDraft = Boolean(watch.draft);
  return { count: Number(draft) + Number(agent) + Number(watchDraft), draft, agent, watch: watchDraft };
}
export function measureDeskLayout(state, width, hasPreference) {
  return width < 960 && (!hasPreference || state.drawer.open) ? { ...state, leftOpen: false } : state;
}
export function filterDeskHomeCards(cards, { tab = 'all', query = '', pinnedIds = [] } = {}) {
  const pins = new Set(pinnedIds);
  const needle = query.trim().toLocaleLowerCase();
  return cards.filter(card => (tab !== 'pinned' || pins.has(card.cardRevisionId))
    && (tab !== 'review' || ['MUST_REVIEW', 'URGENT'].includes(card.tier))
    && (!needle || [card.eventSummary, card.variableTitle, card.catalystSummary, card.sourceName]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)));
}
export function deskCardIdentity(card) {
  return card.catalystIdentityKey || card.variableIdentityKey || card.variableId || card.cardRevisionId;
}
export function countNewDeskCards(previous, current) {
  if (!previous.length) return 0;
  const known = new Set(previous.map(deskCardIdentity));
  return new Set(current.filter(card => !known.has(deskCardIdentity(card))).map(deskCardIdentity)).size;
}
export function retainDeskReference(previous, selectedId, resolvedId) {
  return previous.length ? selectedId : resolvedId;
}
