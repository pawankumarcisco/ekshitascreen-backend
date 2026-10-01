import React, { useState, useEffect } from 'react';
import {
  ArrowLeft,
  Tv,
  Settings,
  Sliders,
  Play,
  Pause,
  RotateCw,
  Maximize2,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  Monitor,
  Send
} from 'lucide-react';
import { Screen, ScreenConfiguration, Playlist, MediaAsset } from '../types';
import { PlaylistEditor } from './PlaylistEditor';
import { api } from '../services/api';

interface ScreenDetailProps {
  screenId: string;
  onBack: () => void;
  mediaAssets: MediaAsset[];
  onEditPlaylist: (playlistId: string) => void;
}

export const ScreenDetail: React.FC<ScreenDetailProps> = ({
  screenId,
  onBack,
  mediaAssets,
  onEditPlaylist
}) => {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [config, setConfig] = useState<ScreenConfiguration | null>(null);
  const [publishedPlaylist, setPublishedPlaylist] = useState<Playlist | null>(null);
  const [draftPlaylist, setDraftPlaylist] = useState<Playlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [configPublishing, setConfigPublishing] = useState(false);
  const [configPublishMessage, setConfigPublishMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(true);

  const fetchScreenData = async () => {
    try {
      setLoading(true);
      const [screenData, playlistData, contentPlaylists] = await Promise.all([
        api.getScreen(screenId),
        api.getScreenPlaylist(screenId),
        api.getContentPlaylists()
      ]);
      if (screenData.assignedPlaylistId) {
        screenData.assignedPlaylist = contentPlaylists.find(playlist => playlist.id === screenData.assignedPlaylistId) || screenData.assignedPlaylist;
      }
      setScreen(screenData);
      setConfig(screenData.configuration || null);
      setPublishedPlaylist(playlistData.published);
      setDraftPlaylist(playlistData.draft);
    } catch (err) {
      console.error('Failed to load screen details', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchScreenData();
  }, [screenId]);

  // Slideshow preview interval runner
  const activeItems = (
    screen?.assignedPlaylist?.items?.length
      ? screen.assignedPlaylist.items
      : (publishedPlaylist?.items || draftPlaylist?.items || [])
  ).filter(i => i.enabled);

  useEffect(() => {
    if (!previewPlaying || activeItems.length <= 1) return;

    const currentSlide = activeItems[activeSlideIndex];
    const durationMs = (currentSlide?.durationSeconds || config?.intervalSeconds || 10) * 1000;

    const timer = setTimeout(() => {
      setActiveSlideIndex((prev) => (prev + 1) % activeItems.length);
    }, durationMs);

    return () => clearTimeout(timer);
  }, [previewPlaying, activeSlideIndex, activeItems, config]);

  const handleConfigChange = async (updates: Partial<ScreenConfiguration>) => {
    if (!config) return;
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    try {
      setConfigSaving(true);
      const saved = await api.updateScreenConfig(screenId, updates);
      setConfig(saved);
    } catch (e) {
      console.error('Failed to save configuration', e);
    } finally {
      setConfigSaving(false);
    }
  };

  const handleConfigPublish = async () => {
    if (!config) return;

    setConfigPublishing(true);
    setConfigPublishMessage(null);
    try {
      const draft = await api.getGeneralSettingsDraft('SCREEN', screenId);
      const imageFit = config.fitMode === 'FILL'
        ? 'COVER'
        : config.fitMode === 'STRETCH'
          ? 'STRETCH'
          : 'CONTAIN';
      const overrides = {
        ...(draft.overrides || {}),
        resolutionWidth: config.width,
        resolutionHeight: config.height,
        orientation: config.orientation,
        contentRotation: config.rotation,
        imageFit,
        defaultSlideDurationSeconds: config.intervalSeconds,
        transition: config.transition,
        transitionDurationMs: config.transitionDurationMs,
        playbackOrder: config.shuffle ? 'SHUFFLE' : 'PLAYLIST_ORDER',
        repeatPlaylist: config.loop,
        startOnBoot: config.autoStart
      };

      await api.saveGeneralSettingsDraft('SCREEN', screenId, overrides);
      const publication = await api.publishGeneralSettings('SCREEN', screenId);
      const targetCount = publication.targets?.length || 0;
      setConfigPublishMessage({
        type: 'success',
        text: `Published to ${targetCount} Android player${targetCount === 1 ? '' : 's'}.`
      });
    } catch (error) {
      setConfigPublishMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to publish player settings.'
      });
    } finally {
      setConfigPublishing(false);
    }
  };

  const handleSaveDraft = async (items: any[]) => {
    await api.saveDraftPlaylist(screenId, items);
    await fetchScreenData();
  };

  const handlePublish = async () => {
    await api.publishPlaylist(screenId);
    await fetchScreenData();
  };

  if (loading && !screen) {
    return (
      <div className="p-12 text-center text-slate-500">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-sky-600" />
        <p className="text-xs">Loading screen telemetry...</p>
      </div>
    );
  }

  if (!screen) {
    return (
      <div className="p-12 text-center text-slate-500">
        <p className="text-sm">Screen not found.</p>
        <button onClick={onBack} className="mt-3 text-xs text-sky-600 font-semibold hover:underline">
          Return to Screens
        </button>
      </div>
    );
  }

  const currentPreviewItem = activeItems[activeSlideIndex];
  const currentAsset = currentPreviewItem?.mediaAsset || mediaAssets.find(a => a.id === currentPreviewItem?.mediaAssetId);
  const previewImgUrl = currentAsset?.url || currentAsset?.thumbnailUrl;

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition-colors"
              title="Back to list"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>

            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-slate-900">{screen.name}</h1>
                <div className="flex items-center gap-1.5 text-xs">
                  {screen.device?.isOnline ? (
                    <span className="flex items-center gap-1 text-emerald-600 font-medium">
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      Online
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-slate-400 font-medium">
                      <span className="w-2 h-2 rounded-full bg-slate-300" />
                      Offline
                    </span>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {screen.location ? `${screen.location} Â· ` : ''}Device UID: <span className="font-mono">{screen.device?.deviceUid}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={fetchScreenData}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh Status</span>
            </button>
          </div>
        </div>
      </div>


      {/* Existing screen preview and legacy per-screen editor remain compatible. */}
      {/* Two Column Grid: Screen Preview & Screen Configuration */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Screen Live Preview */}
        <div className="lg:col-span-7 bg-white rounded-xl border border-slate-200 p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Live Screen Preview</h3>
                <p className="text-xs text-slate-500">Real-time simulation of active playlist rendering</p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPreviewPlaying(!previewPlaying)}
                  className="p-1.5 rounded-md text-slate-600 hover:bg-slate-100 transition-colors"
                  title={previewPlaying ? 'Pause preview' : 'Play preview'}
                >
                  {previewPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 text-sky-600" />}
                </button>
              </div>
            </div>

            {/* Virtual Screen Bezel */}
            <div className="bg-slate-950 p-2.5 rounded-xl border-4 border-slate-800 shadow-lg relative overflow-hidden">
              <div
                className="aspect-video w-full bg-black rounded-sm overflow-hidden relative flex items-center justify-center"
                style={{
                  transform: `rotate(${config?.rotation || 0}deg)`,
                  transition: 'transform 0.3s ease'
                }}
              >
                {previewImgUrl ? (
                  <img
                    key={activeSlideIndex}
                    src={previewImgUrl}
                    alt="Active slide"
                    className="w-full h-full animate-fadeIn"
                    style={{
                      objectFit:
                        config?.fitMode === 'FILL'
                          ? 'cover'
                          : config?.fitMode === 'STRETCH'
                          ? 'fill'
                          : 'contain',
                      transition: `opacity ${(config?.transitionDurationMs || 400) / 1000}s ease`
                    }}
                  />
                ) : (
                  <div className="text-center p-8">
                    <Monitor className="w-10 h-10 text-slate-700 mx-auto mb-2" />
                    <p className="text-xs text-slate-400">No active media to display</p>
                  </div>
                )}

                {/* Overlay index badge */}
                {activeItems.length > 0 && (
                  <div className="absolute bottom-2 right-2 bg-black/70 backdrop-blur-xs text-white text-[10px] font-mono px-2 py-0.5 rounded">
                    {activeSlideIndex + 1} / {activeItems.length}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>
              Now showing:{' '}
              <strong className="text-slate-700">
                {currentAsset?.originalName || 'No image'}
              </strong>
            </span>
            <span className="font-mono">
              Slide {activeSlideIndex + 1} of {activeItems.length}
            </span>
          </div>
        </div>

        {/* Right: Screen Configuration */}
        <div className="lg:col-span-5 bg-white rounded-xl border border-slate-200 p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Screen Configuration</h3>
                <p className="text-xs text-slate-500">Resolution, interval, rotation & transitions</p>
              </div>
              <div className="flex items-center gap-2">
                {configSaving && (
                  <span className="text-[11px] text-sky-600 font-medium flex items-center gap-1">
                    <RefreshCw className="w-3 h-3 animate-spin" /> Saving...
                  </span>
                )}
                <button
                  onClick={handleConfigPublish}
                  disabled={!config || configSaving || configPublishing}
                  title="Publish configuration to the Android player"
                  className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {configPublishing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  {configPublishing ? 'Publishing...' : 'Publish'}
                </button>
              </div>
            </div>

            {configPublishMessage && (
              <div className={`mb-3 flex items-center gap-1.5 rounded-md px-2.5 py-2 text-[11px] ${configPublishMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                {configPublishMessage.type === 'success' ? <CheckCircle className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                <span>{configPublishMessage.text}</span>
              </div>
            )}

            <div className="space-y-3.5 text-xs">
              {/* Resolution Profile */}
              <div>
                <label className="block text-slate-600 font-medium mb-1">Canvas Resolution</label>
                <select
                  value={`${config?.width}x${config?.height}`}
                  onChange={(e) => {
                    const [w, h] = e.target.value.split('x').map(Number);
                    handleConfigChange({ width: w, height: h });
                  }}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500"
                >
                  <option value="1920x1080">1920 Ã— 1080 (Full HD 1080p - Recommended)</option>
                  <option value="1280x720">1280 Ã— 720 (HD 720p)</option>
                  <option value="3840x2160">3840 Ã— 2160 (Ultra HD 4K)</option>
                </select>
              </div>

              {/* Orientation & Rotation */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-medium mb-1">Orientation</label>
                  <select
                    value={config?.orientation || 'LANDSCAPE'}
                    onChange={(e) => handleConfigChange({ orientation: e.target.value as any })}
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  >
                    <option value="LANDSCAPE">Landscape (Horizontal)</option>
                    <option value="PORTRAIT">Portrait (Vertical)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-600 font-medium mb-1">Rotation Angle</label>
                  <select
                    value={config?.rotation ?? 0}
                    onChange={(e) => handleConfigChange({ rotation: Number(e.target.value) })}
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500"
                  >
                    <option value="0">0Â° (Standard)</option>
                    <option value="90">90Â° Clockwise</option>
                    <option value="180">180Â° Inverted</option>
                    <option value="270">270Â° Counter-Clockwise</option>
                  </select>
                </div>
              </div>

              {/* Fit Mode & Default Interval */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-medium mb-1">Image Fit Mode</label>
                  <select
                    value={config?.fitMode || 'FIT'}
                    onChange={(e) => handleConfigChange({ fitMode: e.target.value as any })}
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  >
                    <option value="FIT">Fit (Maintain aspect ratio)</option>
                    <option value="FILL">Fill (Crop to canvas)</option>
                    <option value="STRETCH">Stretch</option>
                    <option value="CENTER">Center (Original size)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-600 font-medium mb-1">Default Interval</label>
                  <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
                    <input
                      type="number"
                      min={1}
                      max={3600}
                      value={config?.intervalSeconds ?? 10}
                      onChange={(e) => handleConfigChange({ intervalSeconds: Number(e.target.value) || 10 })}
                      className="w-full bg-transparent font-mono font-semibold text-slate-900 focus:outline-none"
                    />
                    <span className="text-slate-400">sec</span>
                  </div>
                </div>
              </div>

              {/* Transition Type & Duration */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 font-medium mb-1">Transition Style</label>
                  <select
                    value={config?.transition || 'FADE'}
                    onChange={(e) => handleConfigChange({ transition: e.target.value as any })}
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  >
                    <option value="FADE">Fade (Cross-dissolve)</option>
                    <option value="SLIDE_LEFT">Slide Left</option>
                    <option value="SLIDE_RIGHT">Slide Right</option>
                    <option value="SLIDE_UP">Slide Up</option>
                    <option value="SLIDE_DOWN">Slide Down</option>
                    <option value="ZOOM_IN">Zoom In</option>
                    <option value="ZOOM_OUT">Zoom Out</option>
                    <option value="FADE_ZOOM">Fade + Zoom</option>
                    <option value="NONE">None (Instant Cut)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-600 font-medium mb-1">Transition Duration</label>
                  <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
                    <input
                      type="number"
                      min={0}
                      max={2000}
                      step={50}
                      value={config?.transitionDurationMs ?? 400}
                      onChange={(e) => handleConfigChange({ transitionDurationMs: Number(e.target.value) || 400 })}
                      className="w-full bg-transparent font-mono font-semibold text-slate-900 focus:outline-none"
                    />
                    <span className="text-slate-400">ms</span>
                  </div>
                </div>
              </div>

              {/* Playback Flags: Loop, Shuffle, Auto-Start */}
              <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config?.loop ?? true}
                    onChange={(e) => handleConfigChange({ loop: e.target.checked })}
                    className="rounded text-sky-600 focus:ring-sky-500"
                  />
                  <span className="text-slate-700">Loop continuous</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config?.shuffle ?? false}
                    onChange={(e) => handleConfigChange({ shuffle: e.target.checked })}
                    className="rounded text-sky-600 focus:ring-sky-500"
                  />
                  <span className="text-slate-700">Shuffle order</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config?.autoStart ?? true}
                    onChange={(e) => handleConfigChange({ autoStart: e.target.checked })}
                    className="rounded text-sky-600 focus:ring-sky-500"
                  />
                  <span className="text-slate-700">Auto-start on boot</span>
                </label>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 text-[11px] text-slate-400 font-mono">
            Config revision: #{config?.version || 1} Â· Last updated: {new Date(config?.updatedAt || Date.now()).toLocaleTimeString()}
          </div>
        </div>
      </div>

      {/* Visual Playlist Editor */}
      <PlaylistEditor
        screenId={screenId}
        publishedPlaylist={publishedPlaylist}
        draftPlaylist={draftPlaylist}
        assignedPlaylist={screen.assignedPlaylist}
        onEditPlaylist={onEditPlaylist}
        mediaAssets={mediaAssets}
        onSaveDraft={handleSaveDraft}
        onPublish={handlePublish}
        appliedVersion={screen.appliedVersion}
        publishedVersion={screen.publishedVersion}
      />
    </div>
  );
};
