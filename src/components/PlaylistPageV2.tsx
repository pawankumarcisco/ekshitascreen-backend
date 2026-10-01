import React from 'react';
import { ArrowDown, ArrowUp, Copy, ImagePlus, Plus, Save, Search, Send, Trash2, X } from 'lucide-react';
import { api } from '../services/api';
import type { ContentPlaylist, MediaAsset } from '../types';

const input = 'border border-sky-100 rounded px-2 py-1.5 text-xs';

export function PlaylistPageV2({ assets, onMediaChanged, initialPlaylistId }: { assets: MediaAsset[]; onMediaChanged: () => Promise<void>; initialPlaylistId?: string | null }) {
  const [playlists, setPlaylists] = React.useState<ContentPlaylist[]>([]);
  const [selected, setSelected] = React.useState<ContentPlaylist | null>(null);
  const [items, setItems] = React.useState<any[]>([]);
  const [query, setQuery] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickedIds, setPickedIds] = React.useState<string[]>([]);
  const [message, setMessage] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);

  const load = React.useCallback(async () => setPlaylists(await api.getContentPlaylists()), []);
  React.useEffect(() => { load().catch(e => setMessage(e.message)); }, [load]);

  React.useEffect(() => {
    if (!initialPlaylistId || selected?.id === initialPlaylistId) return;
    const playlist = playlists.find(item => item.id === initialPlaylistId);
    if (playlist) choose(playlist);
  }, [initialPlaylistId, playlists, selected?.id]);

  const choose = (playlist: ContentPlaylist) => {
    setSelected({ ...playlist });
    setItems((playlist.items || []).map(item => ({ ...item })));
  };
  const move = (index: number, delta: number) => setItems(current => {
    const next = [...current], destination = index + delta;
    if (destination < 0 || destination >= next.length) return next;
    [next[index], next[destination]] = [next[destination], next[index]];
    return next;
  });
  const addPicked = () => {
    const existing = new Set(items.map(item => item.mediaAssetId));
    const additions = assets.filter(asset => pickedIds.includes(asset.id) && !existing.has(asset.id))
      .map(asset => ({ mediaAssetId: asset.id, mediaAsset: asset, durationSeconds: 10, enabled: true }));
    setItems(current => [...current, ...additions]);
    setPickedIds([]); setPickerOpen(false);
  };
  const persist = async () => {
    if (!selected) return;
    await api.updateContentPlaylist(selected.id, { name: selected.name, description: selected.description });
    await api.saveContentPlaylistItems(selected.id, items);
    await load();
  };
  const save = async () => {
    setSaving(true); setMessage('');
    try {
      await persist();
      setMessage('Playlist changes saved. Publish to update its assigned screens.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Save failed');
    } finally { setSaving(false); }
  };
  const publish = async () => {
    if (!selected?.assignedScreens?.length) return;
    setPublishing(true); setMessage('');
    try {
      await persist();
      const screenIds = selected.assignedScreens.map(screen => screen.id);
      await api.createPublication({
        sourceScreenId: screenIds[0],
        screenIds,
        groupIds: [],
        playlistId: selected.id,
        idempotencyKey: crypto.randomUUID()
      });
      setMessage(`Playlist saved and published to ${screenIds.length} assigned screen${screenIds.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Publish failed');
    } finally { setPublishing(false); }
  };

  return <div className="grid grid-cols-[300px_1fr] gap-4">
    <aside className="bg-white border border-sky-100 rounded-xl p-4">
      <button onClick={async () => { const p = await api.createContentPlaylist({ name: `Playlist ${playlists.length + 1}` }); await load(); choose({ ...p, items: [] } as any); }} className="w-full bg-sky-600 text-white text-xs rounded px-3 py-2.5 inline-flex justify-center gap-1"><Plus className="w-3.5 h-3.5" />Create Playlist</button>
      <div className="relative mt-3"><Search className="absolute left-2 top-2 w-3.5 h-3.5 text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search playlists" className="w-full border border-sky-100 rounded pl-7 pr-2 py-1.5 text-xs" /></div>
      <div className="mt-3 space-y-2 max-h-[620px] overflow-auto">{playlists.filter(p => `${p.name} ${p.description || ''}`.toLowerCase().includes(query.toLowerCase())).map(p => <button key={p.id} onClick={() => choose(p)} className={`w-full text-left border rounded p-3 ${selected?.id === p.id ? 'border-sky-300 bg-sky-50' : 'border-sky-100'}`}><b className="text-xs">{p.name}</b><span className="block text-[10px] text-slate-500">{p.imageCount || 0} images · {p.totalDurationSeconds || 0}s · {p.assignedScreens?.length || 0} screens</span></button>)}</div>
    </aside>
    <section className="bg-white border border-sky-100 rounded-xl p-5 min-h-80">
      {!selected ? <div className="text-xs text-slate-400 text-center py-24">Create or select a playlist.</div> : <>
        <div className="grid grid-cols-[1fr_1.5fr_auto_auto] gap-2"><input className={input} value={selected.name} onChange={e => setSelected({ ...selected, name: e.target.value })} /><input className={input} value={selected.description || ''} placeholder="Description (optional)" onChange={e => setSelected({ ...selected, description: e.target.value })} /><button title="Duplicate" onClick={async () => { await api.duplicateContentPlaylist(selected.id); await load(); }}><Copy className="w-4 h-4 text-sky-600" /></button><button title="Delete" onClick={async () => { if (!confirm(`Delete “${selected.name}”?`)) return; try { await api.deleteContentPlaylist(selected.id); setSelected(null); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Delete failed'); } }}><Trash2 className="w-4 h-4 text-rose-500" /></button></div>
        <button onClick={() => setPickerOpen(true)} className="mt-3 border border-sky-200 text-sky-700 rounded px-3 py-2 text-xs inline-flex gap-1"><ImagePlus className="w-3.5 h-3.5" />Add Images</button>
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-3 mt-4">{items.map((item, index) => { const asset = item.mediaAsset || assets.find(a => a.id === item.mediaAssetId); return <div key={item.id || index} className="border border-sky-100 rounded-lg overflow-hidden"><img src={asset?.thumbnailUrl || asset?.url} className="w-full aspect-video object-cover bg-slate-50" /><div className="p-2 text-xs"><b className="block truncate">{asset?.originalName}</b><span className="text-[10px] text-slate-400">{asset?.width}×{asset?.height} · {asset ? Math.round(asset.fileSize / 1024) : 0} KB</span><div className="flex items-center gap-2 mt-2"><input type="number" min="1" max="86400" value={item.durationSeconds || 10} onChange={e => setItems(v => v.map((x, n) => n === index ? { ...x, durationSeconds: Number(e.target.value) } : x))} className={input + ' w-16'} /><span>sec</span><label><input type="checkbox" checked={item.enabled !== false} onChange={e => setItems(v => v.map((x, n) => n === index ? { ...x, enabled: e.target.checked } : x))} /> enabled</label><span className="ml-auto flex"><button onClick={() => move(index, -1)}><ArrowUp className="w-3 h-3" /></button><button onClick={() => move(index, 1)}><ArrowDown className="w-3 h-3" /></button><button onClick={() => setItems(v => v.filter((_, n) => n !== index))}><Trash2 className="w-3 h-3 text-rose-500" /></button></span></div></div></div>; })}</div>
        <div className="flex justify-between items-center mt-4"><span className="text-xs text-slate-500">{items.filter(i => i.enabled !== false).length} enabled · {items.reduce((sum, i) => sum + (i.enabled !== false ? Number(i.durationSeconds || 10) : 0), 0)} seconds</span><div className="flex gap-2"><button disabled={saving || publishing} onClick={save} className="border border-sky-200 text-sky-700 text-xs rounded px-4 py-2 inline-flex gap-1 disabled:opacity-50"><Save className="w-3 h-3" />{saving ? 'Saving…' : 'Save'}</button><button disabled={saving || publishing || !selected.assignedScreens?.length || !items.some(i => i.enabled !== false)} onClick={publish} title={selected.assignedScreens?.length ? `Publish to ${selected.assignedScreens.length} assigned screen(s)` : 'Assign this playlist to a screen before publishing'} className="bg-sky-600 text-white text-xs rounded px-4 py-2 inline-flex gap-1 disabled:opacity-50"><Send className="w-3 h-3" />{publishing ? 'Publishing…' : `Publish to ${selected.assignedScreens?.length || 0} Screen${selected.assignedScreens?.length === 1 ? '' : 's'}`}</button></div></div>
      </>}
      {message && <div className="mt-3 text-xs text-sky-700 bg-sky-50 p-2 rounded">{message}</div>}
    </section>
    {pickerOpen && <div className="fixed inset-0 z-50 bg-slate-900/30 flex items-center justify-center p-5" onMouseDown={() => setPickerOpen(false)}><div className="bg-white rounded-xl border border-sky-100 w-full max-w-4xl p-5" onMouseDown={e => e.stopPropagation()}><div className="flex justify-between"><div><h3 className="text-sm font-semibold">Add Images</h3><p className="text-xs text-slate-500">Select multiple thumbnails from the Media Library.</p></div><button onClick={() => setPickerOpen(false)}><X className="w-4 h-4" /></button></div><div className="grid grid-cols-3 md:grid-cols-5 gap-3 mt-4 max-h-[55vh] overflow-auto">{assets.filter(a => a.mimeType.startsWith('image/')).map(asset => <button key={asset.id} onClick={() => setPickedIds(v => v.includes(asset.id) ? v.filter(id => id !== asset.id) : [...v, asset.id])} className={`text-left border rounded-lg overflow-hidden ${pickedIds.includes(asset.id) ? 'border-sky-500 ring-2 ring-sky-100' : 'border-sky-100'}`}><img src={asset.thumbnailUrl || asset.url} className="w-full aspect-video object-cover" /><span className="block text-[10px] truncate p-2">{asset.originalName}</span></button>)}</div><div className="flex justify-between items-center mt-4"><label className="text-xs border border-sky-200 text-sky-700 rounded px-3 py-2 cursor-pointer"><input type="file" accept="image/jpeg,image/png" multiple hidden onChange={async e => { if (!e.target.files?.length) return; await api.uploadMedia([...e.target.files], { dpi: 150, quality: 90 }); await onMediaChanged(); }} />Upload New Images</label><button disabled={!pickedIds.length} onClick={addPicked} className="bg-sky-600 text-white rounded px-4 py-2 text-xs disabled:opacity-40">Add {pickedIds.length} Selected</button></div></div></div>}
  </div>;
}
