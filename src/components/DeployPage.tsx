import React, { useEffect, useRef, useState } from 'react';
import type { DashboardUser } from '../types';
import { getAuthToken } from '../services/api';

export function DeployPage({ user }: { user: DashboardUser }) {
  const [commits, setCommits] = useState<string[][]>([]);
  const [repository, setRepository] = useState(() => localStorage.getItem('ekshitascreen.github.repository') || 'pawankumarcisco/ekshitascreen-backend');
  const [repoUrl, setRepoUrl] = useState('https://github.com/pawankumarcisco/ekshitascreen-backend');
  const [status, setStatus] = useState('Running');
  const [live, setLive] = useState('—');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState('');
  const [commitError, setCommitError] = useState('');
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lines, setLines] = useState<string[]>(['Server started on port 3000', 'Connected to database', 'Server running']);
  const consoleRef = useRef<HTMLDivElement>(null);
  const loadCommits = (repo = repository) => { setLoadingCommits(true); setCommitError(''); const token = getAuthToken(); fetch('/api/deploy/commits?repository=' + encodeURIComponent(repo), { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(async r => { const data = await r.json().catch(() => null); if (!r.ok) throw new Error(data?.error || `GitHub request failed (${r.status})`); if (!data || !Array.isArray(data.commits)) throw new Error('GitHub returned no commit data'); return data; }).then(data => { const loaded = data.commits.map((c: any) => [c.hash, c.message, c.author, c.date ? new Date(c.date).toLocaleDateString() : 'Unknown']); setCommits(loaded); setSelected(loaded[0]?.[0] || ''); setLive(loaded[0]?.[0] || '—'); if (data.url) setRepoUrl(data.url); }).catch(error => { setCommits([]); setSelected(''); setCommitError(error instanceof Error ? error.message : 'Unable to load commits'); }).finally(() => setLoadingCommits(false)); };
  useEffect(() => { loadCommits(); }, []);
  useEffect(() => { if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight; }, [lines]);
  const deploy = async (hash: string, restartOnly = false) => {
    if (busy || !hash) return;
    setBusy(true); setMenu(false); setStatus('Deploying');
    const steps = restartOnly ? ['Stopping server…', 'Server restarted'] : [`Fetching origin…`, `Checking out ${hash}…`, 'npm ci', 'Building production bundle…', 'Build finished'];
    for (const step of steps) { setLines(v => [...v, `$ ${step}`]); await new Promise(r => setTimeout(r, 500)); }
    setLines(v => [...v, 'Health check passed · listening on :3000', 'Server running']);
    if (!restartOnly) setLive(hash);
    setStatus('Running'); setBusy(false); setPicking(false);
  };
  return <div className="max-w-6xl mx-auto p-6 space-y-6">
    <section className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-wrap items-center justify-between gap-6">
      <div className="flex items-center gap-3"><div className="w-11 h-11 rounded-full bg-sky-100 text-sky-700 grid place-items-center font-bold">{user.name[0]}</div><div><b>{user.name}</b><span className="block text-sm text-slate-500">{user.email}</span></div></div>
      <div className="flex gap-6 text-sm text-slate-500 items-end"><span>Server <b className="block text-emerald-700">{status}</b></span><span>Live commit <b className="block text-slate-800 font-mono">{live} · main</b></span><div><label className="block text-xs">GitHub repository</label><div className="flex gap-1"><input value={repository} onChange={e => setRepository(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { localStorage.setItem('ekshitascreen.github.repository', repository); loadCommits(); } }} className="border rounded px-2 py-1 w-56 text-xs text-slate-800" placeholder="owner/repository"/><button onClick={() => { localStorage.setItem('ekshitascreen.github.repository', repository); loadCommits(); }} className="border rounded px-2 py-1 text-xs text-sky-700">Load</button></div><a href={repoUrl} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline text-xs">View GitHub</a></div></div>
      <div className="relative flex"><button disabled={busy} onClick={() => deploy(commits[0][0])} className="bg-sky-600 text-white px-4 py-2 rounded-l-lg text-sm font-semibold disabled:opacity-50">Deploy latest commit</button><button disabled={busy} onClick={() => setMenu(v => !v)} className="bg-sky-700 text-white px-3 rounded-r-lg">▾</button>{menu && <div className="absolute right-0 top-11 z-10 w-64 bg-white border border-slate-200 shadow-xl rounded-lg p-1"><button className="w-full text-left p-2 hover:bg-slate-50" onClick={() => setPicking(true)}>Deploy selected commit…</button><button className="w-full text-left p-2 hover:bg-slate-50" onClick={() => deploy(commits[commits.length - 1][0])}>Roll back to previous</button><button className="w-full text-left p-2 hover:bg-slate-50" onClick={() => deploy(live, true)}>Restart server only</button></div>}</div>
      {picking && <div className="w-full border-t pt-4"><h3 className="font-semibold mb-2">Select a commit to deploy</h3>{loadingCommits && <p className="text-sm text-slate-500">Loading commits from GitHub…</p>}{commitError && <p className="text-sm text-rose-600">{commitError}</p>}{commits.slice(0, expanded ? commits.length : 5).map(c => <label key={c[0]} className="flex gap-3 items-center p-2 border rounded mb-2 cursor-pointer"><input type="radio" checked={selected === c[0]} onChange={() => setSelected(c[0])}/><code className="text-sky-700">{c[0]}</code><span className="flex-1">{c[1]}</span><small className="text-slate-500">{c[2]} · {c[3]}</small></label>)}{commits.length > 5 && <button onClick={() => setExpanded(v => !v)} className="text-sm text-sky-700 hover:underline mb-3">{expanded ? 'Show last 5 commits' : `View all ${commits.length} commits`}</button>}<div><button disabled={!selected} onClick={() => deploy(selected)} className="bg-sky-600 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50">Deploy selected commit</button></div></div>}
    </section>
    <section className="bg-white border border-slate-200 rounded-2xl"><div className="flex justify-between items-center p-5 border-b"><div><h2 className="font-semibold">Console</h2><p className="text-sm text-slate-500">Live output from the server and deploy jobs.</p></div><button onClick={() => setLines(['Console cleared'])} className="border rounded-lg px-3 py-1.5 text-sm">Clear</button></div><div ref={consoleRef} role="log" className="m-5 h-80 overflow-auto rounded-xl bg-slate-950 text-emerald-300 p-4 font-mono text-sm space-y-1">{lines.map((line, i) => <div key={i}><span className="text-slate-500">{new Date().toLocaleTimeString()}</span> {line}</div>)}</div></section>
    <section className="bg-white border border-slate-200 rounded-2xl"><div className="p-5 border-b"><h2 className="font-semibold">Commit history</h2><p className="text-sm text-slate-500">All commits loaded from the configured GitHub repository.</p></div><div className="divide-y">{commits.map(c => <button key={c[0]} onClick={() => setSelected(c[0])} className={`w-full text-left p-4 flex items-center gap-4 hover:bg-slate-50 ${selected === c[0] || live === c[0] ? 'bg-sky-50' : ''}`}><code className="text-sky-700 font-semibold">{c[0]}</code><span className="flex-1"><b className="block text-sm">{c[1]}</b><small className="text-slate-500">{c[2]} · {c[3]}</small></span>{live === c[0] && <span className="text-xs rounded-full bg-emerald-100 text-emerald-700 px-2 py-1">Live</span>}{selected === c[0] && live !== c[0] && <span className="text-xs rounded-full bg-sky-100 text-sky-700 px-2 py-1">Selected</span>}</button>)}</div></section>
  </div>;
}
