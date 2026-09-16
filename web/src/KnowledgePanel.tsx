import { useEffect, useRef, useState } from 'react';
import './knowledge.css';

type Dataset = { id: string; version: string; hash: string; title: string; checkedDate: string; clinicalReviewStatus: string };
type KnowledgeResult = {
  status: 'found' | 'no_match' | 'out_of_scope' | 'unavailable';
  dataset: Dataset | null;
  scope: { patient: string; learner: string; mode: string; notCovered: string[] } | null;
  results: { factId: string; text: string; parameters?: Record<string, unknown>; source: { id: string; title: string; url: string; sections: string[]; guidelineYear: number | null } }[];
  limitations: string[];
};
type Metadata = { status: 'ready' | 'unavailable'; dataset: Dataset | null; factCount: number; indexedFactCount: number; mode: string; error?: string };
type Props = { sessionId: string; token: string; active: boolean; events: Array<Record<string, any>> };
const failureMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const sourceUrl = (value: string) => /^https?:\/\//i.test(value) ? value : undefined;

async function request(path: string, token: string, signal: AbortSignal, query?: string) {
  const response = await fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { Authorization: `Bearer ${token}`, ...(query ? { 'Content-Type': 'application/json' } : {}) }, ...(query ? { method: 'POST', body: JSON.stringify({ query, limit: 4 }) } : {}) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : data?.error?.message ?? `Reference lookup failed (${response.status}).`);
  if (!data) throw new Error('The reference service returned an unreadable response.');
  return data;
}

function LookupResult({ result, query, coach }: { result: KnowledgeResult; query?: string; coach?: boolean }) {
  return <section className="knowledge-result" aria-label={coach ? 'Latest coach lookup' : 'Reference search result'}>
    <div className="knowledge-result-heading"><span className="badge">{coach ? 'Coach lookup' : 'Reference search'}</span><span>{result.status === 'found' ? `${result.results.length} reference${result.results.length === 1 ? '' : 's'}` : result.status.replaceAll('_', ' ')}</span></div>
    {query && <p className="knowledge-query">{query}</p>}
    {result.status !== 'found' && <p className="knowledge-note">{result.status === 'out_of_scope' ? 'This question is outside the training dataset’s scope.' : result.status === 'no_match' ? 'No matching reference was found. Try a more specific question.' : 'The training references are unavailable.'}</p>}
    <ol className="knowledge-facts">{result.results.map(fact => <li key={fact.factId}>
      <p>{fact.text}</p>
      <div className="knowledge-source">{sourceUrl(fact.source.url) ? <a href={sourceUrl(fact.source.url)} target="_blank" rel="noreferrer">{fact.source.title} ↗</a> : <span>{fact.source.title}</span>}<code>{fact.factId}</code></div>
      {!!fact.source.sections.length && <small>Source sections: {fact.source.sections.join(' · ')}</small>}
      {fact.parameters && Object.keys(fact.parameters).length > 0 && <details><summary>Reference parameters</summary><pre>{JSON.stringify(fact.parameters, null, 2)}</pre></details>}
    </li>)}</ol>
    {!!result.limitations.length && <div className="knowledge-limitations"><strong>Reference limits</strong><ul>{result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
  </section>;
}

export function KnowledgePanel({ sessionId, token, active, events }: Props) {
  const [query, setQuery] = useState('');
  const [metadata, setMetadata] = useState<{ sessionId: string; data?: Metadata; failure?: string } | null>(null);
  const [manual, setManual] = useState<{ sessionId: string; query: string; result?: KnowledgeResult; failure?: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [reload, setReload] = useState(0);
  const searchController = useRef<AbortController | null>(null);
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/knowledge`;
  useEffect(() => {
    const controller = new AbortController();
    setMetadata(null); setManual(null); setQuery(''); setSearching(false);
    searchController.current?.abort();
    void request(path, token, controller.signal).then(data => {
      if (!controller.signal.aborted) setMetadata({ sessionId, data });
    }).catch(error => { if (!controller.signal.aborted) setMetadata({ sessionId, failure: failureMessage(error) }); });
    return () => { controller.abort(); searchController.current?.abort(); };
  }, [path, token, sessionId, reload]);
  useEffect(() => { if (!active) { searchController.current?.abort(); setSearching(false); } }, [active]);
  const search = async () => {
    const submitted = query.trim();
    if (!submitted || !active) return;
    searchController.current?.abort();
    const controller = new AbortController(); searchController.current = controller;
    setSearching(true); setManual({ sessionId, query: submitted });
    try {
      const result = await request(path, token, controller.signal, submitted) as KnowledgeResult;
      if (!controller.signal.aborted) setManual({ sessionId, query: submitted, result });
    } catch (error) { if (!controller.signal.aborted) setManual({ sessionId, query: submitted, failure: failureMessage(error) }); }
    finally { if (!controller.signal.aborted) setSearching(false); }
  };
  const currentMetadata = metadata?.sessionId === sessionId ? metadata : null;
  const currentManual = manual?.sessionId === sessionId ? manual : null;
  const coachEvent = events.findLast(event => event.type === 'knowledge.retrieved' && (!event.sessionId || event.sessionId === sessionId) && event.payload?.origin === 'coach' && event.payload?.result);
  const coachResult = coachEvent?.payload.result as KnowledgeResult | undefined;
  const dataset = currentMetadata?.data?.dataset ?? coachResult?.dataset;
  return <section className="panel knowledge-panel" aria-label="Training references">
    <div className="panel-head"><h2>Training references</h2><span className="tiny">Grounded lookup</span></div>
    <div className="knowledge-body">
      <p className="knowledge-note">Search the supplied reference facts. Searching here does not send a message to the coach or mark a practice step complete.</p>
      {!currentMetadata && <p className="knowledge-note" role="status">Loading reference dataset…</p>}
      {(currentMetadata?.failure || currentMetadata?.data?.status === 'unavailable') && <div className="knowledge-error" role="status"><p>{currentMetadata.failure ?? currentMetadata.data?.error ?? 'The reference dataset is unavailable.'}</p><button className="plain" onClick={() => setReload(value => value + 1)}>Reload references</button></div>}
      {dataset && <><p className="knowledge-note">{dataset.clinicalReviewStatus}</p><details className="knowledge-dataset"><summary>{dataset.title} · v{dataset.version}</summary><p>Source check: {dataset.checkedDate}{currentMetadata?.data && ` · ${currentMetadata.data.indexedFactCount} searchable facts`}</p><code>{dataset.id} · {dataset.hash.slice(0, 12)}</code></details></>}
      <form onSubmit={event => { event.preventDefault(); void search(); }}>
        <label htmlFor={`knowledge-query-${sessionId}`}>Search training material</label>
        <div className="knowledge-search"><input id={`knowledge-query-${sessionId}`} value={query} onChange={event => setQuery(event.target.value)} maxLength={1200} placeholder="e.g. hand placement" disabled={!active} /><button className="secondary" type="submit" disabled={!active || !query.trim()}>{searching ? 'Search again' : 'Search'}</button></div>
      </form>
      {!active && <p className="knowledge-note">Reference search is available while coaching is active and no demonstration is playing.</p>}
      {searching && <p className="knowledge-note" role="status">Searching references…</p>}
      {currentManual?.failure && <p className="knowledge-error" role="alert">{currentManual.failure} Try the search again.</p>}
      <div aria-live="polite" aria-busy={searching}>{currentManual?.result && <LookupResult result={currentManual.result} query={currentManual.query} />}</div>
      {coachResult && <LookupResult result={coachResult} query={coachEvent?.payload.query} coach />}
    </div>
  </section>;
}
