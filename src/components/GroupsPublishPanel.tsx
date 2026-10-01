import React from 'react';
import { Layers, Plus, Send, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from '../services/api';
import type { PublishJob, Screen, ScreenGroup } from '../types';

export function GroupsPublishPanel({ screens, onFilter }: { screens: Screen[]; onFilter: (ids: string[] | null) => void }) {
  const [groups, setGroups] = React.useState<ScreenGroup[]>([]);
  const [jobs, setJobs] = React.useState<PublishJob[]>([]);
  const [modal, setModal] = React.useState<'group' | 'publish' | null>(null);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [selectedScreens, setSelectedScreens] = React.useState<string[]>([]);
  const [selectedGroups, setSelectedGroups] = React.useState<string[]>([]);
  const [sourceScreenId, setSourceScreenId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [error, setError] = React.useState('');

  const load = React.useCallback(async () => {
    const [g, j] = await Promise.all([api.getScreenGroups(), api.getPublications()]);
    setGroups(g); setJobs(j);
  }, []);
  React.useEffect(() => { load().catch(e => setError(e.message)); }, [load]);
  React.useEffect(() => {
    const timer = window.setInterval(() => api.getPublications().then(setJobs).catch(() => {}), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const toggle = (id: string, setter: React.Dispatch<React.SetStateAction<string[]>>) => setter(v => v.includes(id) ? v.filter(x => x !== id) : [...v, id]);
  const resolved = new Set(selectedScreens);
  groups.filter(g => selectedGroups.includes(g.id)).forEach(g => g.screenIds.forEach(id => resolved.add(id)));
  const visible = screens.filter(s => !query || (s.name + ' ' + (s.location || '')).toLowerCase().includes(query.toLowerCase()));

  async function createGroup() {
    setBusy(true); setError('');
    try { await api.createScreenGroup({ name, description, screenIds: selectedScreens }); setModal(null); setName(''); setDescription(''); setSelectedScreens([]); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Group creation failed'); } finally { setBusy(false); }
  }
  async function publish() {
    setBusy(true); setError('');
    try {
      await api.createPublication({ sourceScreenId, screenIds: selectedScreens, groupIds: selectedGroups, idempotencyKey: crypto.randomUUID() });
      setModal(null); setSelectedScreens([]); setSelectedGroups([]); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Publish failed'); } finally { setBusy(false); }
  }

  return <div className="space-y-3 mb-4">
    <div className="bg-white border border-sky-100 rounded-xl px-4 py-3 flex flex-wrap items-center gap-2 shadow-xs">
      <Layers className="w-4 h-4 text-sky-600" />
      <span className="text-sm font-semibold text-slate-800">Screen groups</span>
      <button onClick={() => onFilter(null)} className="text-xs px-2 py-1 border border-sky-100 rounded text-sky-700">All screens</button>
      {groups.map(g => <span key={g.id} className="inline-flex border border-sky-100 rounded">
        <button onClick={() => onFilter(g.screenIds)} className="text-xs px-2 py-1 text-slate-600">{g.name} <span className="text-slate-400">{g.onlineScreens}/{g.totalScreens} online</span></button>
        <button title="Delete group" onClick={async () => { if (confirm(`Delete group “${g.name}”? Screens and publish history are preserved.`)) { await api.deleteScreenGroup(g.id); await load(); onFilter(null); } }} className="px-1.5 text-slate-400 hover:text-rose-600"><Trash2 className="w-3 h-3"/></button>
      </span>)}
      <div className="ml-auto flex gap-2">
        <button onClick={() => { setSelectedScreens([]); setModal('group'); }} className="inline-flex items-center gap-1 text-xs text-sky-700 border border-sky-200 rounded px-2.5 py-1.5"><Plus className="w-3 h-3"/>Manage groups</button>
        <button onClick={() => { setSelectedScreens([]); setSelectedGroups([]); setModal('publish'); }} className="inline-flex items-center gap-1 text-xs text-white bg-sky-600 rounded px-3 py-1.5"><Send className="w-3 h-3"/>Publish</button>
      </div>
    </div>

    {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded px-3 py-2">{error}</div>}
    {jobs.length > 0 && <div className="bg-white border border-sky-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-sky-50 flex justify-between"><div><h3 className="text-sm font-semibold">Publish progress & history</h3><p className="text-[11px] text-slate-500">PLAYING is shown only after device playback acknowledgement.</p></div><button onClick={load}><RefreshCw className="w-3.5 h-3.5 text-sky-600"/></button></div>
      <div className="divide-y divide-sky-50 max-h-80 overflow-auto">
        {jobs.map(job => <div key={job.id} className="p-3">
          <div className="flex flex-wrap gap-3 text-xs mb-2"><b>Content v{job.contentVersion}</b><span>{new Date(job.createdAt).toLocaleString()}</span><span>{job.targetCount} targets</span>{Object.entries(job.counts).filter(([,v]) => v > 0).map(([k,v]) => <span key={k} className="uppercase text-slate-500">{k} {v}</span>)}
            {job.counts.failed > 0 && <button onClick={async () => { await api.retryAllFailed(job.id); await load(); }} className="text-sky-700">Retry all failed</button>}
          </div>
          <div className="grid gap-1">{job.targets.map(t => <div key={t.id} className="grid grid-cols-[1.4fr_.8fr_1fr_1fr_auto] gap-2 items-center text-[11px]">
            <span>{t.screen?.name || t.screenNameSnapshot} <i className="text-slate-400">{t.screen?.device?.isOnline ? 'online' : 'offline'}</i></span>
            <span className="font-medium">{t.status}</span><span>v{t.activeVersion || 0} / desired v{t.targetVersion}</span>
            <span>{t.progressPercent}% · {t.filesCompleted}/{t.totalFiles} files {t.errorMessage && <b className="text-rose-600">{t.errorMessage}</b>}</span>
            {t.status === 'FAILED' && <button onClick={async () => { await api.retryPublishTarget(job.id, t.id); await load(); }} className="text-sky-700">Retry</button>}
          </div>)}</div>
        </div>)}
      </div>
    </div>}

    {modal && <div className="fixed inset-0 z-50 bg-slate-900/30 flex items-center justify-center p-4" onMouseDown={() => setModal(null)}>
      <div className="bg-white rounded-xl border border-sky-100 shadow-xl w-full max-w-2xl p-5" onMouseDown={e => e.stopPropagation()}>
        <div className="flex justify-between mb-3"><div><h3 className="text-base font-semibold">{modal === 'group' ? 'Create screen group' : 'Publish to screens'}</h3><p className="text-xs text-slate-500">{modal === 'group' ? 'Screens can belong to multiple groups.' : 'Targets are resolved and deduplicated by the server.'}</p></div><button onClick={() => setModal(null)}><X className="w-4 h-4"/></button></div>
        {modal === 'group' ? <div className="grid gap-2 mb-3"><input value={name} onChange={e => setName(e.target.value)} placeholder="Group name" className="border border-sky-100 rounded px-3 py-2 text-sm"/><input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)" className="border border-sky-100 rounded px-3 py-2 text-sm"/></div> :
          <div className="grid gap-2 mb-3"><label className="text-xs font-medium">Playlist/configuration source</label><select value={sourceScreenId} onChange={e => setSourceScreenId(e.target.value)} className="border border-sky-100 rounded px-3 py-2 text-sm"><option value="">Select a screen with a saved draft</option>{screens.map(s => <option key={s.id} value={s.id}>{s.name} · draft v{s.draftVersion || 1}</option>)}</select>
          <label className="text-xs font-medium mt-1">Groups</label><div className="flex flex-wrap gap-2">{groups.filter(g => g.isActive).map(g => <label key={g.id} className="text-xs border border-sky-100 rounded px-2 py-1"><input type="checkbox" checked={selectedGroups.includes(g.id)} onChange={() => toggle(g.id, setSelectedGroups)} className="mr-1"/>{g.name} ({g.totalScreens})</label>)}</div></div>}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search screens" className="w-full border border-sky-100 rounded px-3 py-2 text-sm mb-2"/>
        <div className="max-h-52 overflow-auto border border-sky-50 rounded divide-y divide-sky-50">{visible.map(s => <label key={s.id} className="flex items-center justify-between px-3 py-2 text-xs"><span><input type="checkbox" checked={selectedScreens.includes(s.id)} onChange={() => toggle(s.id, setSelectedScreens)} className="mr-2"/>{s.name} · {s.location || 'No location'}</span><span className={s.device?.isOnline ? 'text-emerald-600' : 'text-slate-400'}>{s.device?.isOnline ? 'Online' : 'Offline'}</span></label>)}</div>
        <div className="mt-4 flex items-center justify-between"><span className="text-xs text-slate-500">{modal === 'publish' ? `${resolved.size} unique screens · offline targets remain queued` : `${selectedScreens.length} members`}</span><button disabled={busy || (modal === 'group' ? !name : !sourceScreenId || resolved.size === 0)} onClick={modal === 'group' ? createGroup : publish} className="text-xs bg-sky-600 text-white rounded px-4 py-2 disabled:opacity-40">{busy ? 'Saving…' : modal === 'group' ? 'Create group' : 'Publish immutable snapshot'}</button></div>
      </div>
    </div>}
  </div>;
}
