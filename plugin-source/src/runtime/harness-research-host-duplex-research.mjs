// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CALLS = 256;

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

// These callbacks are local UI sinks. Their failures cannot change research
// ownership or send their exception messages back to the external provider.
function notify(callback, value) {
  try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* local UI only */ }
}

function parseCalls(event) {
  if (event?.type !== 'response.function_call_arguments.done'
    || !Array.isArray(event.items) || event.items.length < 1 || event.items.length > 8) return null;
  const calls = new Map();
  for (const item of event.items) {
    if (!item || item.name !== 'research_company' || typeof item.call_id !== 'string' || !CALL_ID.test(item.call_id)
      || (item.type !== undefined && item.type !== 'function_call')
      || typeof item.arguments !== 'string' || item.arguments.length > 4_096) return null;
    let args;
    try { args = JSON.parse(item.arguments); } catch { return null; }
    if (!args || Array.isArray(args) || typeof args !== 'object'
      || Object.keys(args).length !== 1 || typeof args.question !== 'string') return null;
    const question = args.question.trim();
    if (!question || question.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(question)) return null;
    if (calls.has(item.call_id) && calls.get(item.call_id) !== question) return null;
    calls.set(item.call_id, question);
  }
  return calls;
}

function cloudResult(result, job, sessionId) {
  if (job.controller.signal.aborted || job.cancelled) return {status:'cancelled',spokenText:''};
  if (result?.sessionId !== sessionId) return {status:'failed',spokenText:''};
  if (job.awaitingApproval || result.awaitingApproval) return {status:'awaiting-confirmation',spokenText:''};
  if (job.toolError || result.toolError || result.stepLimitHit || result.ok === false) return {status:'partial',spokenText:''};
  const spokenText = result.presentation?.spokenText;
  if (result.presentation?.speechStatus !== 'ready' || typeof spokenText !== 'string'
    || !spokenText.trim() || Array.from(spokenText).length > 600) return {status:'partial',spokenText:''};
  return {status:result.researchStatus === 'partial' ? 'partial' : 'complete',spokenText:spokenText.trim()};
}

/**
 * Server-owned bridge; runResearch is the existing recovery ingress + manager.run.
 * It receives {sessionId, context, question}, {signal, onEvent}. Neither the
 * cloud tool nor this bridge selects a model, creates an Agent or approves tools.
 * submitToolResults receives official dialogue items; its caller wraps them in
 * conversation.item.create. Written details and native events go only to the UI.
 * One research may run at a time. Remaining batch calls receive BUSY; call ids
 * are retained for this bounded connection, including after submission failure.
 */
export function createDuplexResearchBridge({
  runResearch, sessionId, context = {}, onNativeEvent, onStatus, submitToolResults,
} = {}) {
  if (typeof runResearch !== 'function' || typeof submitToolResults !== 'function'
    || typeof sessionId !== 'string' || !/^xiaomei-agent-[a-z0-9-]{16,96}$/.test(sessionId)) {
    throw Error('DUPLEX_RESEARCH_CONFIG_INVALID');
  }
  let boundContext;
  try { boundContext = freeze(structuredClone(context)); } catch { throw Error('DUPLEX_RESEARCH_CONFIG_INVALID'); }
  const seen = new Map();
  let active = null, closed = false, state = 'idle';
  const status = () => Object.freeze({state,active:active !== null,closed});
  const transition = next => { state = next; notify(onStatus,status()); };
  const receipt = (ok, code) => Object.freeze({ok,code,status:status()});

  async function research(question) {
    let settle;
    const job = {controller:new AbortController(),toolError:false,awaitingApproval:false,cancelled:false,
      settled:new Promise(resolve => { settle = resolve; })};
    active = job;
    transition('researching');
    const onEvent = event => {
      if (closed || active !== job) return;
      if (event?.type === 'tool-result' && (['failure','failed','error'].includes(event.status) || event.errorCode)) job.toolError = true;
      if (event?.type === 'error' || event?.type === 'tool-error') job.toolError = true;
      if (event?.type === 'cancellation') job.cancelled = true;
      if (event?.type === 'approval') {
        job.awaitingApproval = event.status === 'awaiting-confirmation';
        if (['rejected','cancelled'].includes(event.status)) job.toolError = true;
        if (!job.controller.signal.aborted) transition(job.awaitingApproval ? 'awaiting-confirmation' : 'researching');
      }
      notify(onNativeEvent,event);
    };
    let result;
    try {
      if (job.controller.signal.aborted) result = {status:'cancelled',spokenText:''};
      else result = cloudResult(await runResearch(Object.freeze({sessionId,context:boundContext,question}),
        {signal:job.controller.signal,onEvent}), job, sessionId);
    } catch {
      result = {status:job.controller.signal.aborted || job.cancelled ? 'cancelled' : 'failed',spokenText:''};
    } finally {
      if (active === job) active = null;
      if (!closed) transition(result?.status || 'failed');
      settle();
    }
    return result;
  }

  return Object.freeze({
    status,
    async handleCalls(event) {
      if (closed) return receipt(false,'DUPLEX_RESEARCH_CLOSED');
      const calls = parseCalls(event);
      if (!calls) return receipt(false,'DUPLEX_TOOL_CALL_INVALID');
      // Preflight every item before reserving an id or running any research.
      for (const [id,question] of calls) {
        if (seen.has(id) && seen.get(id) !== question) return receipt(false,'DUPLEX_TOOL_CALL_CONFLICT');
      }
      const fresh = [...calls].filter(([id]) => !seen.has(id));
      if (seen.size + fresh.length > MAX_CALLS) return receipt(false,'DUPLEX_TOOL_CALL_LIMIT');
      if (!fresh.length) return receipt(true,'DUPLEX_TOOL_CALL_DUPLICATE');
      for (const [id,question] of fresh) seen.set(id,question);
      const wasBusy = active !== null;
      const results = fresh.map(([call_id]) => ({call_id,result:{status:'busy',spokenText:''}}));
      if (!wasBusy) results[0].result = await research(fresh[0][1]);
      if (closed) return receipt(false,'DUPLEX_RESEARCH_CLOSED');
      const items = results.map(({call_id,result}) => ({call_id,role:'tool',
        content:[{type:'input_text',text:JSON.stringify(result)}]}));
      try { await submitToolResults(freeze(items)); }
      catch { return receipt(false,'DUPLEX_TOOL_SUBMISSION_FAILED'); }
      return receipt(true,'DUPLEX_TOOL_RESULTS_SUBMITTED');
    },
    async cancelResearch() {
      const job = active;
      if (job) {
        job.cancelled = true; job.controller.abort();
        if (!closed) transition('cancelling');
        await job.settled;
      }
      return status();
    },
    async close(reason) {
      closed = true;
      const job = active;
      transition('closed');
      if (job) { job.cancelled = true; job.controller.abort(reason); await job.settled; }
      return status();
    },
  });
}
