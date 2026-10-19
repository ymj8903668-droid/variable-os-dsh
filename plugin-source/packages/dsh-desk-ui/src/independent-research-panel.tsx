// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import * as React from "react";
import { isIndependentPlan, isIndependentResult, isIndependentHistoryList, isIndependentHistoryRestore,
  isIndependentSavedHistory } from "./independent-research-contract.mjs";
import { ResearchHostMarkdown } from "./desk-components";

const messages: Record<string, string> = {
  MODEL_CONSENT_REQUIRED: "请先在统一配置中选择 IMA 知识库，并允许模型使用授权资料。",
  AUTH_REQUIRED: "请先填写你自己的 IMA 接口身份。",
  MODEL_SETTINGS_UNAVAILABLE: "请先在统一配置中配置你的 DeepSeek 模型。",
  MODEL_CREDENTIAL_REQUIRED: "当前个人模型缺少凭证，请到统一配置填写。",
  MODEL_SELECTION_REQUIRED: "请先选择个人研究模型。",
  SOURCE_UNAVAILABLE: "资料或服务暂不可用；联网研究需要配置你自己的 Tavily。",
  FORBIDDEN_SCOPE: "当前资料授权已失效，未交付研究结果。",
  WIKI_SOURCE_CHANGED: "IMA 配置已改变，请重新查看计划。",
  MODEL_SETTINGS_CHANGED: "模型配置已改变，请重新查看计划。",
  SOURCE_CHANGED: "来源或联网配置已改变，请重新查看计划。",
  RESEARCH_PLAN_UNAVAILABLE: "这份计划已使用或过期，请重新查看计划；不会自动重跑。",
  RESEARCH_BUDGET_EXHAUSTED: "达到本次调用上限，研究已停止；没有自动加量。",
  RESEARCH_INPUT_TOO_LARGE: "原文与引用超出本次模型输入上限，已在下一次模型或联网调用前停止；原文未截断，计划不会自动重跑。",
  RESEARCH_SEGMENT_LIMIT: "完整原文超过已批准的分段上限，研究已停止；没有截断原文、增加调用或自动重跑。",
  RESEARCH_SEGMENT_JSON_INVALID: "逐段研读的模型回复不是合格 JSON，本次研究已停止，没有自动重试。",
  RESEARCH_SEGMENT_FIELDS_INVALID: "逐段研读的模型回复缺少必要字段或字段类型不符，本次研究已停止，没有自动重试。",
  RESEARCH_SEGMENT_LENGTH_EXCEEDED: "逐段研读的模型摘要超过已批准长度，本次研究已停止，没有截断摘要或自动重试。",
  RESEARCH_SEGMENT_TEXT_INVALID: "逐段研读的模型摘要含无效文字，本次研究已停止，没有自动重试。",
  RESEARCH_SEGMENT_EMPTY: "逐段研读返回了空摘要，本次研究已停止，没有自动重试。",
  RESEARCH_DISCLOSURE_EXHAUSTED: "这些信源的可用披露额度已用尽，本次研究已停止，没有自动扩大额度或重试。",
  RESEARCH_REPORT_LENGTH_EXCEEDED: "模型报告超过本次信源允许的长度，研究已停止，没有截断报告或自动重试。",
  RESEARCH_RESULT_INVALID: "模型返回的计划或引用不符合要求，研究已停止；没有自动重试。",
  DEEP_RESEARCH_OUTPUT_INVALID: "结果超出输出或原文披露限制，未交付报告。",
  CLIENT_BUSY: "已有操作仍在结束，请稍后重新查看计划。",
  RESEARCH_HISTORY_UNAVAILABLE: "私人历史暂不可读，请检查本机存储；不会重新生成报告。",
  RESEARCH_HISTORY_CHANGED: "这份历史已删除或所属身份已改变，请重新加载列表。",
  RESEARCH_HISTORY_BUSY: "私人历史正在更新，请稍后手动重试。",
  RESEARCH_HISTORY_CAPACITY: "私人历史已达32份上限，请先删除不再需要的记录；尚未开始本次研究。",
  RESEARCH_HISTORY_STALE: "引用原文已变化或撤回，相关旧报告已从私人历史移除；不会自动重新研究。",
};

export function IndependentResearchPanel({ call, subscribe }: { call: Function; subscribe?: Function }) {
  const [topic, setTopic] = React.useState(""), [web, setWeb] = React.useState(false);
  const [segmented, setSegmented] = React.useState(false);
  const [plan, setPlan] = React.useState<any>(null), [result, setResult] = React.useState<any>(null);
  const [approved, setApproved] = React.useState(false), [phase, setPhase] = React.useState("idle");
  const [message, setMessage] = React.useState("");
  const [historyList, setHistoryList] = React.useState<any>(null), [selectedHistory, setSelectedHistory] = React.useState("");
  const operation = React.useRef<AbortController | null>(null), sequence = React.useRef(0);
  const notice = React.useRef<HTMLParagraphElement | null>(null), resultElement = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => { if (message) notice.current?.scrollIntoView({ block: "nearest" }); }, [message]);
  React.useEffect(() => { if (result) resultElement.current?.scrollIntoView({ block: "start" }); }, [result]);
  const reset = React.useCallback(() => {
    sequence.current++; operation.current?.abort(); operation.current = null;
    setPlan(null); setResult(null); setApproved(false); setPhase("idle"); setMessage("");
    setHistoryList(null); setSelectedHistory("");
  }, []);
  React.useEffect(() => {
    const stop = subscribe?.(() => reset());
    return () => { stop?.(); sequence.current++; operation.current?.abort(); };
  }, [subscribe, reset]);
  const busy = ["preparing", "running", "listing", "restoring", "deleting"].includes(phase);
  async function perform(run: boolean) {
    if (busy || run && (!plan || !approved)) return;
    const selected = plan, id = ++sequence.current, controller = new AbortController();
    operation.current = controller; setMessage(""); setResult(null); setApproved(false);
    setPhase(run ? "running" : "preparing");
    if (run) setPlan(null); // A sent approval is never offered for replay.
    try {
      const value = await call(run ? "independentResearchRun" : "independentResearchPrepare",
        run ? { planId: selected.planId, approved: true } : { topic: topic.trim(), webSearchAllowed: web,
          ...(segmented ? { inputMode: "segmented" } : {}) },
        { signal: controller.signal });
      if (id !== sequence.current || controller.signal.aborted) return;
      if (run ? !isIndependentResult(value, selected) || !isIndependentSavedHistory(value.history, selected)
        : !isIndependentPlan(value)) throw { code: "RESEARCH_RESULT_INVALID" };
      if (run) { setResult(value); setHistoryList(null); setSelectedHistory(""); setPhase("done"); }
      else { setPlan(value); setPhase("planned"); }
    } catch (error: any) {
      if (id !== sequence.current) return;
      setPhase("error"); setPlan(null);
      setMessage(controller.signal.aborted ? "本次研究已取消，不会自动重跑。"
        : messages[error?.code] || "本次操作未完成；不会自动重试或恢复付费调用。请检查配置后重新查看计划。");
    } finally { if (id === sequence.current) operation.current = null; }
  }
  async function historyTask(kind: "List" | "Read" | "Delete") {
    if (busy || kind !== "List" && !selectedHistory) return;
    const selected = selectedHistory, id = ++sequence.current, controller = new AbortController();
    operation.current = controller; setMessage(""); setApproved(false); setPlan(null);
    if (kind !== "List") setResult(null);
    setPhase(kind === "List" ? "listing" : kind === "Read" ? "restoring" : "deleting");
    try {
      const value = await call(`independentResearchHistory${kind}`, kind === "List" ? {} : { id: selected }, { signal: controller.signal });
      if (id !== sequence.current || controller.signal.aborted) return;
      if (kind === "List") {
        if (!isIndependentHistoryList(value)) throw { code: "RESEARCH_RESULT_INVALID" };
        setHistoryList(value); setSelectedHistory(value.entries.some((row: any) => row.id === selected) ? selected : value.entries[0]?.id || "");
      } else if (kind === "Read") {
        if (!isIndependentHistoryRestore(value, selected)) throw { code: "RESEARCH_RESULT_INVALID" };
        setResult({ ...value.result, history: value.history }); setTopic(value.plan.topic);
        setSegmented(value.plan.inputMode === "segmented");
      } else {
        if (value?.removed !== true) throw { code: "RESEARCH_RESULT_INVALID" };
        const entries = historyList.entries.filter((row: any) => row.id !== selected);
        setHistoryList({ ...historyList, entries }); setSelectedHistory(entries[0]?.id || "");
        setMessage("这份私人历史已删除。");
      }
      setPhase("done");
    } catch (error: any) {
      if (id !== sequence.current) return;
      setResult(null); setPhase("error");
      if (["AUTH_REQUIRED", "FORBIDDEN_SCOPE", "RESEARCH_HISTORY_CHANGED", "RESEARCH_HISTORY_STALE"].includes(error?.code)) {
        setHistoryList(null); setSelectedHistory("");
      }
      setMessage(controller.signal.aborted ? "本次历史操作已取消，未调用模型。"
        : messages[error?.code] || "历史未完成核验，未显示报告；不会自动重试或重新研究。");
    } finally { if (id === sequence.current) operation.current = null; }
  }
  return <details className="vos-independent-research">
    <summary>独立问题研究 <small>自配 IMA · DeepSeek · 可选 Tavily</small></summary>
    <p>不需要先生成私人卡。使用你订阅的「自进化的ai杰」资料和自己的服务凭证；不影响业主原卡同步。</p>
    <form onSubmit={event => { event.preventDefault(); void perform(false); }}>
      <label>研究问题<textarea aria-label="独立研究问题" maxLength={200} rows={3} value={topic} disabled={busy}
        onChange={event => { reset(); setTopic(event.target.value); }} placeholder="例如：某行业增长逻辑有哪些证据、反证与待验证条件？" /></label>
      <label><input type="checkbox" checked={web} disabled={busy} onChange={event => { reset(); setWeb(event.target.checked); }} />使用我自己的 Tavily 联网补证</label>
      <label><input type="checkbox" checked={segmented} disabled={busy} onChange={event => { reset(); setSegmented(event.target.checked); }} />长原文逐段研读（增加模型调用）</label>
      <button type="submit" disabled={busy || topic.trim().length < 2}>查看本次研究计划</button>
    </form>
    {phase === "preparing" ? <p role="status">正在读取本地配置；尚未调用模型或联网服务。</p> : null}
    {plan ? <section aria-label="本次研究计划">
      <h3>本次研究计划</h3><p>{plan.topic}</p>
      <dl><dt>授权知识库</dt><dd>{plan.libraryId}</dd><dt>个人模型</dt><dd>{plan.model.provider} / {plan.model.model}</dd></dl>
      <p>最多 4 轮 IMA 查询、4 份完整原文；80 次 IMA API 请求、8 次下载（含交付前复核）。最多 {plan.limits.maxModelCalls} 次模型调用，每次输出 4096 tokens、输入 60000 字符（含系统说明）；{plan.limits.maxWebSearches} 次 Tavily 搜索；总时限 {plan.limits.totalTimeoutMs / 60000} 分钟。</p>
      {plan.inputMode === "segmented" ? <p>逐段研读：最多 {plan.limits.maxSegments} 段，每段不超过 {plan.limits.segmentCharacters} 字符。先逐段提取事实、反证与缺口，再进行三阶段综合；所有读入原文均需处理，超过总段数会停止，不截断。中间摘要只在本次运行保留，不能证明语义覆盖。</p> : null}
      <ol><li>读取授权证据，找出需要补证的问题。</li><li>补查反证与相反解释。</li><li>综合结论、缺口及证伪条件，复核全部原文后交付。</li></ol>
      <p>按你自己的服务账户计费；上述调用上限不代表固定金额。计划 5 分钟内有效，仅批准一次；失败不重试。有限检索不代表完整知识库或历史。</p>
      <p>报告长度还受信源累计披露额度限制；额度用尽会在可避免的付费调用前停止。</p>
      <p>{plan.historyPersistence === "local-private" ? "完成后报告与引用保存在本机私人历史，最多32份；不保存原文或凭证。" : "当前Host没有持久存储，历史仅在本次Host进程保留。"}查看历史时重新核验IMA授权和原文，不调用模型。</p>
      <label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />我同意按此范围和上限，将授权资料发送给我的模型{plan.webSearchAllowed ? "，并用自己的 Tavily 检索" : ""}。</label>
      <button type="button" disabled={!approved} onClick={() => void perform(true)}>批准并开始本次研究</button>
    </section> : null}
    {phase === "running" ? <div role="status"><p>正在按已批准的计划检索与综合；交付前复核引用，最多 {segmented ? 30 : 5} 分钟。</p>
      <button type="button" onClick={() => { operation.current?.abort(); setMessage("正在取消；已发出的调用仍可能由服务商计费。"); }}>取消本次研究</button></div> : null}
    <section aria-label="私人研究历史"><h3>私人研究历史</h3>
      <p>列表只显示本机记录时间。查看报告需联网重新核验IMA授权和最多4份原文，最多80次API请求、90秒；无需模型Key，不调用模型或Tavily。网页引用仅保留研究时的搜索记录。</p>
      <button type="button" disabled={busy} onClick={() => void historyTask("List")}>加载私人历史</button>
      {historyList ? historyList.entries.length ? <>
        <label>记录<select aria-label="私人研究记录" value={selectedHistory} disabled={busy} onChange={event => {
          setSelectedHistory(event.target.value); setResult(null); setPlan(null); setApproved(false); setMessage("");
        }}>{historyList.entries.map((row: any) => <option key={row.id} value={row.id}>
          {new Date(row.createdAt).toLocaleString("zh-CN")} · {row.id.slice(0, 8)} · {row.status === "ready" ? "可核验" : row.status === "running" ? "正在执行" : "中断，不能续跑"}
        </option>)}</select></label>
        <div className="vos-independent-history-actions">
          <button type="button" disabled={busy || historyList.entries.find((row: any) => row.id === selectedHistory)?.status !== "ready"} onClick={() => void historyTask("Read")}>核验并查看历史</button>
          <button type="button" disabled={busy || !selectedHistory} onClick={() => void historyTask("Delete")}>删除此历史</button>
        </div></> : <p>暂无可查看的私人研究记录。</p> : null}
      {phase === "restoring" ? <div role="status"><p>正在重新读取授权原文，未调用模型或Tavily。</p>
        <button type="button" onClick={() => operation.current?.abort()}>取消历史核验</button></div> : null}
    </section>
    {message ? <p role="alert" ref={notice}>{message}</p> : null}
    {result ? <section aria-label="独立研究结果" ref={resultElement}><h3>{result.status === "empty" ? "未找到资料" : "研究结果 · 有限覆盖"}</h3>
      <p>{result.history?.proof === "REVALIDATED" ? `历史引用已重新核验：${new Date(result.history.checkedAt).toLocaleString("zh-CN")}。`
        : result.history?.persistence === "local-private" ? "报告已保存至本机私人历史。" : "历史仅在当前Host进程保留。"}
        研究时间：{new Date(result.generatedAt).toLocaleString("zh-CN")}。授权和原文以本次复核时为准；网页摘录没有重新检索，离页或配置变化会清除当前显示。</p>
      <ResearchHostMarkdown text={result.synthesisMarkdown} />
      <p>生成这份报告时：模型调用 {result.calls.model} 次，联网搜索 {result.calls.web} 次；原文 {result.readScope.included} 份。全库及历史覆盖未证明。</p>
      {result.reportCharacterLimit ? <p>本次报告长度上限 {result.reportCharacterLimit} 字符，受信源许可和已有披露记录限制。</p> : null}
      {result.queryAdmission ? <p>模型提出 {result.queryAdmission.proposed} 条补查，去重 {result.queryAdmission.duplicates} 条，按预算执行 {result.queryAdmission.admitted} 条；{result.queryAdmission.omitted} 条未查询，相关问题仍属覆盖缺口。</p> : null}
      {result.inputProcessing ? <>
        <p>长原文研读：已将读入原文分为 {result.inputProcessing.segmentCount} 段逐段发送模型，再依据模型摘要综合。分段无遗漏仍不能证明语义覆盖，摘要可能遗漏或误解事实；中间摘要不保存。</p>
        <details><summary>分段与原文核验</summary>
          <p>下面按 Unicode 字符计数；每段位置连续且绑定原文。查看历史时会重新下载原文并逐段比较哈希，不重新生成摘要。</p>
          {result.inputProcessing.documents.map((document: any) => <div key={document.ref}>
            <p>[{document.ref}] {document.characters} 字符，共 {document.segments.length} 段。</p>
            <ul>{document.segments.map((segment: any) => <li key={segment.id}>
              {segment.id} · 第 {segment.start + 1}–{segment.end} 字符 · SHA-256 <code style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>{segment.contentHash}</code>
            </li>)}</ul>
          </div>)}
        </details>
      </> : null}
      {result.readScope.queries.some((row: any) => row.omittedFor?.includes("SOURCE_COVERAGE_UNKNOWN"))
        ? <p>IMA 未提供搜索分页结束标记；命中数只代表已返回的结果，搜索覆盖范围未知。</p> : null}
      <ul>{result.refs.map((ref: any) => <li key={ref.ref}>[{ref.ref}] {ref.sourceType === "web"
        ? <a href={ref.url} target="_blank" rel="noopener noreferrer">{ref.title || "网页搜索摘录"}</a>
        : <>{ref.title} · 原文哈希 {ref.contentHash.slice(0, 12)}…</>}{ref.sourceType === "web" ? "（搜索摘录，未读取网页全文）" : "（本次已复核，历史版本未知）"}</li>)}</ul>
    </section> : null}
  </details>;
}
