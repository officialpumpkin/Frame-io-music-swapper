import { useState, useRef, useEffect, useCallback, useMemo } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────

const TRACK_PALETTE = [
  "#F59E0B","#EF4444","#10B981","#6366F1",
  "#EC4899","#14B8A6","#F97316","#A78BFA",
  "#FB923C","#34D399","#60A5FA","#F472B6",
];

// Frame rate used purely to render the frames field of the timecode readout.
// The selector that used to drive this lived in the marker export panel.
const DISPLAY_FPS = 25;

// ─── Frame.io API Layer ───────────────────────────────────────────────────────

const API_BASE = "/api/frameio";

async function apiRequest(token, method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// V4 wraps every successful payload in a `data` envelope; V2 returned the
// object directly. Unwrap once here so callers see the same shape as before.
const unwrap = (r) => (r && typeof r === "object" && "data" in r ? r.data : r);

// media_links variants must be named individually — a bare `include=media_links`
// returns nothing. `original` is the only one a <video> element can play
// natively; `efficient` and `high_quality` are both HLS manifests.
const MEDIA_INCLUDE =
  "include=media_links.original,media_links.efficient,media_links.thumbnail";

const FIO = {
  me:          (t)                              => apiRequest(t, "GET",  "/me").then(unwrap),
  accounts:    (t)                              => apiRequest(t, "GET",  "/accounts").then(unwrap),
  // V4: assets → files, account_id required in every path
  asset:       (t, acct, id)                    => apiRequest(t, "GET",  `/accounts/${acct}/files/${id}?${MEDIA_INCLUDE}`).then(unwrap),
  children:    (t, acct, id)                    => apiRequest(t, "GET",  `/accounts/${acct}/files/${id}/children?type=file&page=1&page_size=40&${MEDIA_INCLUDE}`).then(unwrap),
  reviewLink:  (t, acct, id)                    => apiRequest(t, "GET",  `/accounts/${acct}/review_links/${id}`).then(unwrap),
};

// Parse any Frame.io URL and return { type, id }
function parseFrameioURL(url) {
  const u = url.trim();

  const reviewMatch  = u.match(/\/(?:reviews|r)\/([a-f0-9-]{36})/i);
  if (reviewMatch) return { type: "review_link", id: reviewMatch[1] };
  const presentMatch = u.match(/\/presentations\/([a-f0-9-]{36})/i);
  if (presentMatch) return { type: "review_link", id: presentMatch[1] };

  // Extract ALL UUIDs from the URL
  const uuids = [...u.matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)];

  if (uuids.length > 0) {
    // In V4 URLs, the actual asset/folder is always the LAST ID in the chain
    const targetId = uuids[uuids.length - 1][0];
    return { type: "asset", id: targetId };
  }

  return null;
}

// Resolve any URL → { type: 'video'|'folder', asset?, assets?, folderName? }
async function resolveURL(token, accountId, url) {
  let finalUrl = url.trim();

  // Check if it's a shortlink. If so, let our backend expand it first.
  if (/f\.io\//i.test(finalUrl)) {
    if (!finalUrl.startsWith('http')) finalUrl = `https://${finalUrl}`;
    const expandRes = await fetch(`/api/expand?url=${encodeURIComponent(finalUrl)}`);
    if (!expandRes.ok) throw new Error("Could not expand shortlink.");
    const expandData = await expandRes.json();
    finalUrl = expandData.expandedUrl || finalUrl;
  }

  const parsed = parseFrameioURL(finalUrl);
  if (!parsed) throw new Error("Couldn't find a Frame.io asset ID in that URL.");

  if (parsed.type === "review_link") {
    const link = await FIO.reviewLink(token, accountId, parsed.id);
    // V4 may wrap items differently
    const items = link.items || link.assets || link.data || [];
    const videos = items.filter(a => a.type === "file" || a.item_type === "file");
    if (videos.length === 1) return { type: "video", asset: videos[0] };
    if (videos.length > 1)  return { type: "folder", assets: videos, folderName: link.name || "Review Link" };
    throw new Error("This review link contains no video assets.");
  }

  const asset = await FIO.asset(token, accountId, parsed.id);
  if (asset.type === "file" || asset.item_type === "file") return { type: "video", asset };

  // Folder / project — V4 may wrap children in { data: [...] }
  const childrenRes = await FIO.children(token, accountId, parsed.id);
  const children    = Array.isArray(childrenRes) ? childrenRes : (childrenRes.data || []);
  const videos = children.filter(a =>
    (a.type === "file" || a.item_type === "file") && /video/i.test(a.media_type || "")
  );
  if (videos.length === 0) throw new Error("No video files found in this folder.");
  if (videos.length === 1) return { type: "video", asset: videos[0] };
  return { type: "folder", assets: videos, folderName: asset.name };
}

// Pick best available playback URL from an asset
function videoURL(asset) {
  // V4 uses media_links; fall back to V2 transcodes for compatibility.
  // Note V4 exposes download_url / inline_url, not url — and `efficient` and
  // `high_quality` are HLS manifests that only Safari plays without hls.js, so
  // the original MP4 (served inline) is preferred for playback everywhere.
  const ml = asset.media_links || {};
  const t  = asset.transcodes  || {};
  return (
    ml.original?.inline_url     ||
    ml.original?.download_url   ||
    ml.efficient?.url           ||
    ml.high_quality?.url        ||
    // Last resort: HLS. Plays in Safari, needs hls.js elsewhere.
    ml.efficient?.download_url  ||
    ml.high_quality?.download_url ||
    t.h264_1080 || t.h264_720 || t.h264_540 || t.h264_360 ||
    asset.original || null
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(s, fps = 25) {
  if (!s || isNaN(s)) s = 0;
  const m  = Math.floor(s / 60);
  const sc = Math.floor(s % 60);
  const fr = Math.floor((s % 1) * fps);
  return `${String(m).padStart(2,"0")}:${String(sc).padStart(2,"0")}:${String(fr).padStart(2,"0")}`;
}

function colorFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return TRACK_PALETTE[Math.abs(h) % TRACK_PALETTE.length];
}

async function analyseAudio(file, numBars = 300) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    ctx.close();

    const duration    = audioBuffer.duration;
    const numChannels = audioBuffer.numberOfChannels;
    const length      = audioBuffer.length;
    const mono        = new Float32Array(length);
    for (let c = 0; c < numChannels; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += ch[i] / numChannels;
    }
    const samplesPerBar = Math.floor(length / numBars);
    const raw = Array.from({ length: numBars }, (_, b) => {
      const start = b * samplesPerBar;
      const end   = Math.min(start + samplesPerBar, length);
      let peak = 0;
      for (let i = start; i < end; i++) {
        const abs = Math.abs(mono[i]);
        if (abs > peak) peak = abs;
      }
      return peak;
    });
    const max  = Math.max(...raw, 0.001);
    const wave = raw.map(v => Math.max(v / max, 0.05));
    return { wave, duration };
  } catch {
    return { wave: Array.from({ length: numBars }, () => 0.15), duration: 0 };
  }
}

function WaveformSVG({ waveform, progress, color, height = 56, dimmed = false }) {
  const BAR_W = 1;
  const GAP   = 0.5;
  const n     = waveform.length;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${n * (BAR_W + GAP) - GAP} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
    >
      {waveform.map((v, i) => {
        const x      = i * (BAR_W + GAP);
        const halfH  = Math.max(1.5, v * (height / 2) * 0.92);
        const y      = height / 2 - halfH;
        const barH   = halfH * 2;
        const played = progress > 0 && i / n < progress;
        return (
          <rect
            key={i}
            x={x} y={y}
            width={BAR_W} height={barH}
            fill={color}
            opacity={played ? (dimmed ? 0.3 : 0.88) : (dimmed ? 0.07 : 0.18)}
          />
        );
      })}
    </svg>
  );
}

function uid() { return Math.random().toString(36).slice(2,10); }

// ─── Styles ───────────────────────────────────────────────────────────────────

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap');

.ml3 *, .ml3 *::before, .ml3 *::after { box-sizing: border-box; margin:0; padding:0; }
.ml3 { font-family:'Inter',system-ui,sans-serif; background:#0C0C13; color:#DCDCEE; border-radius:14px; overflow:hidden; display:flex; flex-direction:column; min-height:720px; font-size:13px; }
.mono { font-family:'IBM Plex Mono',monospace; }

.ml3-header { padding:10px 16px; background:#13131C; border-bottom:1px solid #1E1E2C; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.ml3-dot { width:8px; height:8px; border-radius:50%; background:#F59E0B; flex-shrink:0; }
.ml3-wordmark { font-size:12px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:#EEEEF5; }
.ml3-sub { font-size:10px; color:#606078; }
.ml3-token-wrap { display:flex; align-items:center; gap:6px; margin-left:auto; }
.ml3-input { background:#16161F; border:1px solid #22222F; color:#A0A0BC; border-radius:6px; padding:5px 9px; font-size:11px; outline:none; font-family:'IBM Plex Mono',monospace; }
.ml3-input:focus { border-color:#F59E0B66; color:#DCDCEE; }
.ml3-input::placeholder { color:#454560; }
.ml3-token-input { width:220px; letter-spacing:.03em; }
.ml3-url-input { width:260px; }
.ml3-btn { border-radius:6px; padding:5px 11px; font-size:11px; cursor:pointer; font-weight:500; transition:all .12s; white-space:nowrap; border:1px solid; }
.ml3-btn-amber { background:#F59E0B18; border-color:#F59E0B55; color:#F59E0B; }
.ml3-btn-amber:hover { background:#F59E0B28; }
.ml3-btn-amber:disabled { opacity:.35; cursor:default; }
.ml3-btn-ghost { background:transparent; border-color:#252535; color:#707090; }
.ml3-btn-ghost:hover { border-color:#353550; color:#A0A0BC; }
.ml3-status { font-size:10px; padding:3px 8px; border-radius:4px; font-weight:500; }
.ml3-status-ok   { background:#10B98120; color:#10B981; border:1px solid #10B98140; }
.ml3-status-err  { background:#EF444420; color:#EF4444; border:1px solid #EF444440; }
.ml3-status-busy { background:#F59E0B20; color:#F59E0B; border:1px solid #F59E0B40; }

.ml3-body { display:grid; grid-template-columns:1fr 285px; flex:1; overflow:hidden; }
.ml3-left { display:flex; flex-direction:column; border-right:1px solid #1E1E2C; overflow:hidden; }

/* Video */
.ml3-video-wrap { position:relative; background:#06060B; flex-shrink:0; }
.ml3-video-wrap video { display:block; width:100%; aspect-ratio:16/9; background:#000; }
.ml3-placeholder { aspect-ratio:16/9; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; }
.ml3-vid-overlay { position:absolute; bottom:0; left:0; right:0; padding:22px 12px 10px; background:linear-gradient(transparent,rgba(6,6,11,.94)); display:flex; align-items:center; gap:7px; pointer-events:none; }
.ml3-tc { position:absolute; top:10px; left:12px; font-family:'IBM Plex Mono',monospace; font-size:11px; color:rgba(220,220,238,.35); pointer-events:none; }
.ml3-live { position:absolute; top:10px; right:12px; display:flex; align-items:center; gap:5px; }

/* Folder picker */
.ml3-picker { position:absolute; inset:0; background:rgba(12,12,19,.97); display:flex; flex-direction:column; z-index:20; }
.ml3-picker-header { padding:12px 14px; border-bottom:1px solid #1E1E2C; display:flex; align-items:center; justify-content:space-between; }
.ml3-picker-list { flex:1; overflow-y:auto; padding:8px; }
.ml3-picker-item { padding:10px 12px; border-radius:7px; border:1px solid #1E1E2C; margin-bottom:4px; cursor:pointer; display:flex; align-items:center; gap:10px; transition:background .1s; }
.ml3-picker-item:hover { background:#16161F; border-color:#2A2A3C; }
.ml3-picker-thumb { width:52px; height:30px; border-radius:4px; background:#1E1E2C; object-fit:cover; flex-shrink:0; }

/* Waveform stack */
.ml3-wavestack { position:relative; flex-shrink:0; border-bottom:1px solid #1E1E2C; }
.ml3-wstack-hint { font-size:9px; color:#4A4A65; text-transform:uppercase; letter-spacing:.1em; padding:6px 13px 3px; }

/* Track waveform rows */
.ml3-wrow { position:relative; padding:0 13px; cursor:pointer; transition:background .12s; border-bottom:1px solid #13131C; overflow:hidden; user-select:none; }
.ml3-wrow:hover { background:#111119; }
.ml3-wrow.active { background:#14141E; }
.ml3-wrow-empty { padding:18px 13px; font-size:10px; color:#4A4A65; text-align:center; letter-spacing:.05em; }

/* Track label */
.ml3-wrow-label { position:absolute; top:5px; left:18px; display:flex; align-items:center; gap:5px; z-index:2; pointer-events:none; max-width:55%; }
.ml3-wrow-name { font-size:10px; font-weight:500; color:#606078; letter-spacing:.02em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ml3-wrow.active .ml3-wrow-name { color:#B0B0CC; }
.ml3-wrow-analysing { font-size:8.5px; color:#4A4A65; letter-spacing:.08em; text-transform:uppercase; }

/* Transport */
.ml3-transport { padding:9px 13px; border-bottom:1px solid #1E1E2C; display:flex; align-items:center; gap:7px; flex-shrink:0; }
.ml3-play-btn { background:#F59E0B; border:none; color:#0C0C13; border-radius:7px; padding:7px 16px; cursor:pointer; font-weight:700; font-size:12px; letter-spacing:.04em; transition:all .1s; white-space:nowrap; }
.ml3-play-btn:hover { background:#FBBF24; }
.ml3-play-btn:active { transform:scale(.97); }
.ml3-stop-btn { background:none; border:1px solid #22222F; color:#707090; border-radius:5px; padding:4px 9px; cursor:pointer; font-size:11px; transition:all .1s; }
.ml3-stop-btn:hover { border-color:#353550; color:#A0A0BC; }
.ml3-vol { display:flex; align-items:center; gap:6px; margin-left:auto; }
.ml3-vol input[type=range] { width:64px; cursor:pointer; }

/* Right panel */
.ml3-right { display:flex; flex-direction:column; overflow:hidden; }
.ml3-panel-head { display:flex; border-bottom:1px solid #1E1E2C; flex-shrink:0; }
.ml3-panel-title { flex:1; padding:9px 6px; text-align:center; font-size:9.5px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:#F59E0B; border-bottom:2px solid #F59E0B; }
.ml3-tab-body { flex:1; overflow-y:auto; }

/* Tracks */
.ml3-drop { margin:9px; border:1.5px dashed #22222F; border-radius:8px; padding:13px 10px; text-align:center; cursor:pointer; transition:all .15s; }
.ml3-drop:hover, .ml3-drop.over { border-color:#F59E0B; background:rgba(245,158,11,.05); }
.ml3-titem { padding:8px 10px; margin:2px 7px; border-radius:7px; cursor:pointer; border:1px solid transparent; transition:background .1s; }
.ml3-titem:hover { background:#13131C; }
.ml3-titem.on { background:#16161F; border-color:#22222F; }
.ml3-ticon { width:28px; height:28px; border-radius:5px; display:flex; align-items:flex-end; justify-content:center; gap:1.5px; padding-bottom:4px; flex-shrink:0; }
.ml3-io { display:flex; align-items:center; gap:4px; margin-top:5px; }
.ml3-io-inp { background:#13131C; border:1px solid #1E1E2C; color:#8080A0; border-radius:4px; padding:2px 5px; font-size:10px; width:44px; text-align:center; font-family:'IBM Plex Mono',monospace; outline:none; }
.ml3-io-inp:focus { border-color:#F59E0B55; color:#DCDCEE; }
.ml3-pbars { display:flex; align-items:flex-end; gap:1.5px; height:13px; flex-shrink:0; }
.ml3-pbar { width:2px; border-radius:1px; }
.ml3-rm { background:none; border:none; color:#353550; cursor:pointer; font-size:14px; padding:2px 4px; border-radius:4px; line-height:1; transition:color .1s; flex-shrink:0; }
.ml3-rm:hover { color:#ef4444; }

.ml3-divider { font-size:9px; color:#4A4A65; text-transform:uppercase; letter-spacing:.1em; padding:8px 10px 3px; font-weight:600; }
.ml3-empty { padding:20px 12px; text-align:center; font-size:11px; color:#4A4A65; line-height:1.8; }
.ml3 ::-webkit-scrollbar { width:3px; }
.ml3 ::-webkit-scrollbar-thumb { background:#22222F; border-radius:2px; }

@keyframes ml3-pulse { 0%,100%{opacity:1}50%{opacity:.2} }
@keyframes ml3-b0 { to{height:30%} }
@keyframes ml3-b1 { to{height:88%} }
@keyframes ml3-b2 { to{height:50%} }
@keyframes ml3-b3 { to{height:95%} }
`;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function MusicLayerV3() {

  // ── Connection state
  const [token, setToken]           = useState("server-auth");
  const [tokenInput, setTokenInput] = useState("");
  const [connStatus, setConnStatus] = useState("ok");
  const [connMsg, setConnMsg]       = useState("Secured by Vercel");

  // ── Frame.io account (V4 requires account_id in every path)
  const [accountId, setAccountId]   = useState(null);

  // ── Asset / video state
  const [urlInput, setUrlInput]     = useState("");
  const [resolving, setResolving]   = useState(false);
  const [resolveErr, setResolveErr] = useState("");
  const [currentAsset, setCurrentAsset] = useState(null);
  const [folderAssets, setFolderAssets] = useState(null);
  const [folderName, setFolderName]     = useState("");

  // ── Playback
  const [playing, setPlaying] = useState(false);
  const [pos, setPos]         = useState(0);
  const [dur, setDur]         = useState(0);
  const [vol, setVol]         = useState(0.8);

  // ── Music tracks
  const [tracks, setTracks]         = useState([]);
  const [activeTrackId, setActiveTrackId] = useState(null);
  const [dragOver, setDragOver]     = useState(false);

  // ── Refs
  const videoRef     = useRef(null);
  const audioRef     = useRef(null);
  const rafRef       = useRef(null);
  const startRef     = useRef(0);
  const posRef       = useRef(0);
  const waveStackRef = useRef(null);

  // Mirror refs
  const tracksRef        = useRef(tracks);
  const activeTrackIdRef = useRef(activeTrackId);
  const playingRef       = useRef(playing);
  const volRef           = useRef(vol);
  const durRef           = useRef(dur);

  useEffect(() => { tracksRef.current        = tracks;        }, [tracks]);
  useEffect(() => { activeTrackIdRef.current = activeTrackId; }, [activeTrackId]);
  useEffect(() => { playingRef.current       = playing;       }, [playing]);
  useEffect(() => { volRef.current           = vol;           }, [vol]);

  const activeTrack  = tracks.find(t => t.id === activeTrackId) || null;
  const effectiveDur = currentAsset ? dur : (activeTrack?.audioDuration || dur || 0);
  useEffect(() => { durRef.current = effectiveDur; }, [effectiveDur]);

  // ── Auto-fetch account_id on mount — V4 requires it in every endpoint path
  useEffect(() => {
    (async () => {
      try {
        const accts = await FIO.accounts("server-auth");
        const list  = Array.isArray(accts) ? accts : (accts.data || []);
        if (list[0]?.id) setAccountId(list[0].id);
        else console.warn("Music Layer: no Frame.io accounts found for this token.");
      } catch (e) {
        console.warn("Music Layer: account_id fetch failed —", e.message);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Connect token (manual reconnect flow)
  const connectToken = useCallback(async () => {
    if (!tokenInput.trim()) return;
    setConnStatus("connecting");
    try {
      const me    = await FIO.me(tokenInput.trim());
      const accts = await FIO.accounts(tokenInput.trim());
      const list  = Array.isArray(accts) ? accts : (accts.data || []);
      const acctId = list[0]?.id;
      if (!acctId) throw new Error("No Frame.io accounts found for this token.");
      setToken(tokenInput.trim());
      setAccountId(acctId);
      setConnStatus("ok");
      setConnMsg(me.email || me.name || "Connected");
    } catch (e) {
      setConnStatus("error");
      setConnMsg(e.message);
    }
  }, [tokenInput]);

  // ── Resolve Frame.io URL
  const handleResolve = useCallback(async () => {
    if (!urlInput.trim() || !token) return;
    setResolving(true);
    setResolveErr("");
    setFolderAssets(null);
    try {
      // Lazy-fetch accountId if the auto-init hasn't completed yet
      let acctId = accountId;
      if (!acctId) {
        const accts = await FIO.accounts(token);
        const list  = Array.isArray(accts) ? accts : (accts.data || []);
        acctId = list[0]?.id;
        if (!acctId) throw new Error("Could not determine Frame.io account ID. Check your token has account access.");
        setAccountId(acctId);
      }
      const result = await resolveURL(token, acctId, urlInput.trim());
      if (result.type === "video") {
        const url = videoURL(result.asset);
        if (!url) throw new Error("No playable URL found for this asset.");
        setCurrentAsset({ id: result.asset.id, name: result.asset.name, url });
      } else {
        setFolderName(result.folderName);
        setFolderAssets(result.assets.map(a => ({
          id: a.id, name: a.name,
          thumb: a.media_links?.thumbnail?.url || a.transcodes?.thumbnail_small || a.thumb || null,
          url: videoURL(a),
        })));
      }
    } catch (e) {
      setResolveErr(e.message);
    }
    setResolving(false);
  }, [urlInput, token, accountId]);

  const selectFolderAsset = useCallback((a) => {
    setCurrentAsset(a);
    setFolderAssets(null);
  }, []);

  // ── Video events
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !currentAsset?.url) return;
    v.src = currentAsset.url;
    v.crossOrigin = "anonymous";
    const onMeta = () => setDur(v.duration || 0);
    const onTime = () => {
      if (!playing) return;
      posRef.current = v.currentTime;
      setPos(v.currentTime);
    };
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [currentAsset?.url]);

  // ── Music track routing
  const trackForTime = useCallback((time, list) => {
    for (const t of list) {
      const inP  = t.inPoint  ?? 0;
      const outP = t.outPoint ?? Infinity;
      if (time >= inP && time < outP) return t;
    }
    return null;
  }, []);

  // ── Playback
  const handlePlay = useCallback(() => {
    const v = videoRef.current;
    if (playing) {
      setPlaying(false);
      v?.pause();
      audioRef.current?.pause();
    } else {
      startRef.current = performance.now();
      posRef.current   = pos;
      setPlaying(true);
      v?.play().catch(() => {});
      const track = trackForTime(pos, tracks);
      if (track && audioRef.current) {
        if (audioRef.current.src !== track.url) audioRef.current.src = track.url;
        audioRef.current.volume      = vol;
        audioRef.current.currentTime = Math.max(0, pos - (track.inPoint ?? 0) + (track.audioOffset ?? 0));
        audioRef.current.play().catch(() => {});
      }
    }
  }, [playing, pos, tracks, vol, trackForTime]);

  const handleStop = useCallback(() => {
    const v = videoRef.current;
    setPlaying(false);
    setPos(0);
    if (v) { v.pause(); v.currentTime = 0; }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
  }, []);

  // RAF loop for music-only mode
  useEffect(() => {
    if (currentAsset) return;
    if (playing) {
      startRef.current = performance.now();
      posRef.current   = pos;
      const tick = () => {
        const next   = posRef.current + (performance.now() - startRef.current) / 1000;
        const maxDur = durRef.current || 300;
        if (next >= maxDur) { setPos(maxDur); setPlaying(false); return; }
        setPos(next);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else cancelAnimationFrame(rafRef.current);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, currentAsset]);

  // Volume sync
  useEffect(() => { if (audioRef.current) audioRef.current.volume = vol; }, [vol]);

  // Auto-route music (only when in/out arrangement is defined)
  useEffect(() => {
    if (!playing || tracks.length === 0) return;
    const hasArrangement = tracks.some(t => t.inPoint != null || t.outPoint != null);
    if (!hasArrangement) return;
    const track = trackForTime(pos, tracks);
    if (!track) { audioRef.current?.pause(); return; }
    const a = audioRef.current;
    if (!a) return;
    if (a.src !== track.url) {
      a.src          = track.url;
      a.volume       = vol;
      a.currentTime  = Math.max(0, pos - (track.inPoint ?? 0) + (track.audioOffset ?? 0));
      a.play().catch(() => {});
      setActiveTrackId(track.id);
    }
  }, [Math.floor(pos * 4), playing]);

  // ── Seek
  const seekTo = useCallback((t) => {
    const activeT  = tracksRef.current.find(x => x.id === activeTrackIdRef.current);
    const trackDur = activeT?.audioDuration || durRef.current || 300;
    const s = Math.max(0, Math.min(t, trackDur));
    setPos(s);
    posRef.current   = s;
    startRef.current = performance.now();

    const v = videoRef.current;
    if (v) v.currentTime = s;

    if (activeT && audioRef.current) {
      audioRef.current.volume      = volRef.current;
      audioRef.current.currentTime = Math.max(0, s - (activeT.inPoint ?? 0));
      if (playingRef.current) audioRef.current.play().catch(() => {});
    }
  }, []);

  // ── Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const inField = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
      if (e.code === "Space" && !inField) { e.preventDefault(); handlePlay(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePlay]);

  // ── Track file handling
  const handleFiles = useCallback((files) => {
    const valid = Array.from(files).filter(f =>
      f.type.startsWith("audio/") || /\.(mp3|wav|aac|flac|ogg|m4a)$/i.test(f.name)
    );
    if (!valid.length) return;

    const newTracks = valid.map((f, i) => ({
      id: uid(), name: f.name.replace(/\.[^.]+$/, ""),
      url: URL.createObjectURL(f),
      color: colorFor(f.name + i),
      wave: Array.from({ length: 300 }, () => 0.15),
      analysing: true,
      size: f.size > 1048576 ? `${(f.size/1048576).toFixed(1)} MB` : `${(f.size/1024).toFixed(0)} KB`,
      inPoint: null, outPoint: null, audioOffset: 0,
    }));

    const isFirstBatch = tracks.length === 0;
    setTracks(prev => [...prev, ...newTracks]);

    if (isFirstBatch) {
      setActiveTrackId(newTracks[0].id);
      if (audioRef.current) {
        audioRef.current.src    = newTracks[0].url;
        audioRef.current.volume = vol;
      }
    }

    valid.forEach(async (f, i) => {
      const id = newTracks[i].id;
      const { wave, duration } = await analyseAudio(f);
      setTracks(prev => prev.map(t => t.id === id
        ? { ...t, wave, analysing: false, audioDuration: duration }
        : t
      ));
      if (i === 0 && duration > 0) setDur(prev => prev || duration);
    });
  }, [vol, tracks.length]);

  const removeTrack = useCallback((id, e) => {
    e.stopPropagation();
    setTracks(prev => {
      const next = prev.filter(t => t.id !== id);
      if (id === activeTrackId) {
        setActiveTrackId(next[0]?.id || null);
        if (audioRef.current) {
          if (next[0]) audioRef.current.src = next[0].url;
          else { audioRef.current.pause(); setPlaying(false); }
        }
      }
      return next;
    });
  }, [activeTrackId]);

  const updateTrackIO = useCallback((id, field, val) => {
    const n = parseFloat(val);
    setTracks(prev => prev.map(t => t.id === id ? { ...t, [field]: isNaN(n) ? null : n } : t));
  }, []);

  const selectTrack = useCallback((id, overridePos = null) => {
    const currentActiveId = activeTrackIdRef.current;
    const currentTracks   = tracksRef.current;
    const currentPos      = posRef.current;

    if (id === currentActiveId && overridePos === null) return;

    const newTrack = currentTracks.find(x => x.id === id);
    if (!newTrack) return;

    setTracks(prev => prev.map(t =>
      t.id === currentActiveId ? { ...t, savedPos: currentPos } : t
    ));

    const restorePos = overridePos !== null ? overridePos : (newTrack.savedPos ?? 0);

    setActiveTrackId(id);
    setPos(restorePos);
    posRef.current   = restorePos;
    startRef.current = performance.now();

    if (audioRef.current) {
      audioRef.current.src         = newTrack.url;
      audioRef.current.volume      = volRef.current;
      audioRef.current.currentTime = Math.max(0, restorePos - (newTrack.inPoint ?? 0));
      if (playingRef.current) audioRef.current.play().catch(() => {});
    }
  }, []);

  const handleWaveformClick = useCallback((e, trackId) => {
    const rect     = e.currentTarget.getBoundingClientRect();
    const PAD      = 13;
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left - PAD) / (rect.width - PAD * 2)));

    const clickedTrack = tracksRef.current.find(t => t.id === trackId);
    const trackDur     = clickedTrack?.audioDuration || durRef.current || 0;
    const newPos       = fraction * trackDur;

    if (trackId !== activeTrackIdRef.current) {
      selectTrack(trackId, newPos);
    } else {
      seekTo(newPos);
    }
  }, [selectTrack, seekTo]);

  // ── Derived
  const pbAnim = useMemo(() => [
    { height:"60%", animation: playing ? "ml3-b0 .28s ease infinite alternate" : "none" },
    { height:"30%", animation: playing ? "ml3-b1 .42s ease infinite alternate" : "none" },
    { height:"80%", animation: playing ? "ml3-b2 .35s ease infinite alternate" : "none" },
    { height:"45%", animation: playing ? "ml3-b3 .5s ease infinite alternate"  : "none" },
  ], [playing]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <style>{CSS}</style>
      <audio ref={audioRef} />

      <div className="ml3">
        {/* ── Header ── */}
        <div className="ml3-header">
          <div className="ml3-dot" />
          <span className="ml3-wordmark">Music Layer</span>
          <span className="ml3-sub">for Frame.io</span>

          {/* Token connect */}
          {connStatus !== "ok" ? (
            <div className="ml3-token-wrap">
              <input
                className="ml3-input ml3-token-input"
                type="password"
                placeholder="Frame.io API token…"
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && connectToken()}
              />
              <button
                className="ml3-btn ml3-btn-amber"
                onClick={connectToken}
                disabled={connStatus === "connecting"}
              >
                {connStatus === "connecting" ? "Connecting…" : "Connect"}
              </button>
              {connStatus === "error" && (
                <span className="ml3-status ml3-status-err">{connMsg}</span>
              )}
            </div>
          ) : (
            <div className="ml3-token-wrap">
              <span className="ml3-status ml3-status-ok">✓ {connMsg}</span>
              <button
                className="ml3-btn ml3-btn-ghost"
                style={{ fontSize:10 }}
                onClick={() => { setToken(""); setConnStatus("idle"); setConnMsg(""); }}
              >
                Disconnect
              </button>
            </div>
          )}

          {/* URL resolver */}
          <div className="ml3-token-wrap">
            <input
              className="ml3-input ml3-url-input"
              placeholder={token ? "Paste Frame.io URL (folder, review link, asset)…" : "Connect API token first"}
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleResolve()}
              disabled={!token}
            />
            <button
              className="ml3-btn ml3-btn-amber"
              onClick={handleResolve}
              disabled={!token || resolving || !urlInput.trim()}
            >
              {resolving ? "Resolving…" : "Load"}
            </button>
            {currentAsset && (
              <button className="ml3-btn ml3-btn-ghost" onClick={() => { setCurrentAsset(null); setUrlInput(""); }}>✕</button>
            )}
            {resolveErr && <span className="ml3-status ml3-status-err">{resolveErr}</span>}
            {currentAsset && (
              <span className="ml3-status ml3-status-ok" style={{ maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                ✓ {currentAsset.name}
              </span>
            )}
          </div>
        </div>

        {/* ── Body ── */}
        <div className="ml3-body">

          {/* ── Left ── */}
          <div className="ml3-left">

            {/* Video */}
            <div className="ml3-video-wrap">
              {currentAsset?.url ? (
                <video ref={videoRef} controls={false} playsInline style={{ aspectRatio:"16/9" }} />
              ) : (
                <div className="ml3-placeholder">
                  <svg width="34" height="34" viewBox="0 0 34 34" fill="none" style={{ opacity:.07 }}>
                    <rect x="1" y="1" width="32" height="32" rx="6" stroke="#888" strokeWidth="1.2"/>
                    <polygon points="13,10 25,17 13,24" fill="#888"/>
                  </svg>
                  <span style={{ fontSize:9.5, color:"#606078", letterSpacing:".12em", textTransform:"uppercase" }}>
                    {token ? "Load a Frame.io URL above" : "Connect API token to load video"}
                  </span>
                </div>
              )}

              {/* Folder picker overlay */}
              {folderAssets && (
                <div className="ml3-picker">
                  <div className="ml3-picker-header">
                    <div>
                      <div style={{ fontSize:12, fontWeight:600, color:"#d0d0e0" }}>{folderName}</div>
                      <div style={{ fontSize:10, color:"#707090", marginTop:2 }}>Select a video to review</div>
                    </div>
                    <button className="ml3-btn ml3-btn-ghost" onClick={() => setFolderAssets(null)}>✕</button>
                  </div>
                  <div className="ml3-picker-list">
                    {folderAssets.map(a => (
                      <div key={a.id} className="ml3-picker-item" onClick={() => selectFolderAsset(a)}>
                        {a.thumb
                          ? <img className="ml3-picker-thumb" src={a.thumb} alt="" />
                          : <div className="ml3-picker-thumb" style={{ display:"flex", alignItems:"center", justifyContent:"center", opacity:.3 }}>
                              <svg width="16" height="16" viewBox="0 0 16 16"><polygon points="5,3 13,8 5,13" fill="#888"/></svg>
                            </div>
                        }
                        <div>
                          <div style={{ fontSize:12, fontWeight:500, color:"#ccc" }}>{a.name}</div>
                          <div style={{ fontSize:10, color:"#707090", marginTop:2 }}>{a.url ? "Playable" : "No stream URL"}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="ml3-tc mono">{fmt(pos, DISPLAY_FPS)}</div>
              {activeTrack && (
                <div className="ml3-vid-overlay">
                  <div style={{ width:5, height:5, borderRadius:"50%", background:activeTrack.color, flexShrink:0 }} />
                  <span style={{ fontSize:10, color:"rgba(208,208,224,.6)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{activeTrack.name}</span>
                </div>
              )}
              {playing && (
                <div className="ml3-live">
                  <div style={{ width:5, height:5, borderRadius:"50%", background:"#ef4444", animation:"ml3-pulse .9s infinite" }} />
                  <span style={{ fontSize:9, color:"#ef4444", letterSpacing:".12em", textTransform:"uppercase" }}>Live</span>
                </div>
              )}
            </div>

            {/* ── Waveform Stack ── */}
            <div className="ml3-wavestack" ref={waveStackRef}>

              <div className="ml3-wstack-hint">
                Click to seek · Space = play
              </div>

              {/* Track waveform rows */}
              {tracks.length === 0 ? (
                <div className="ml3-wrow-empty">Upload tracks in the panel → to see waveforms here</div>
              ) : (
                tracks.map(t => {
                  const isActive = t.id === activeTrackId;
                  const rowH     = isActive ? 68 : 50;

                  return (
                    <div
                      key={t.id}
                      className={`ml3-wrow${isActive ? " active" : ""}`}
                      style={{ height: rowH }}
                      onClick={e => handleWaveformClick(e, t.id)}
                    >
                      <div className="ml3-wrow-label">
                        <div style={{ width:5, height:5, borderRadius:"50%", background:t.color, flexShrink:0 }} />
                        <span className="ml3-wrow-name">{t.name}</span>
                        {t.analysing && <span className="ml3-wrow-analysing">Analysing…</span>}
                      </div>

                      <WaveformSVG
                        waveform={t.wave}
                        progress={isActive && t.audioDuration ? pos / t.audioDuration : 0}
                        color={t.color}
                        height={rowH}
                        dimmed={!isActive}
                      />
                    </div>
                  );
                })
              )}
            </div>

            {/* Transport */}
            <div className="ml3-transport">
              <button className="ml3-stop-btn" onClick={handleStop}>⏮</button>
              <button className="ml3-play-btn" onClick={handlePlay}>
                {playing ? "⏸  Pause" : "▶  Play"}
              </button>
              <span className="mono" style={{ fontSize:10, color:"#606078" }}>{fmt(pos,DISPLAY_FPS)} / {fmt(effectiveDur,DISPLAY_FPS)}</span>
              <div className="ml3-vol">
                <span style={{ fontSize:9, color:"#606078", textTransform:"uppercase", letterSpacing:".08em" }}>Music</span>
                <input type="range" min="0" max="1" step="0.01" value={vol}
                  onChange={e => setVol(parseFloat(e.target.value))}
                  style={{ accentColor: activeTrack?.color || "#F59E0B" }}
                />
                <span className="mono" style={{ fontSize:10, color:"#9090A8", minWidth:24 }}>{Math.round(vol*100)}%</span>
              </div>
            </div>

          </div>

          {/* ── Right panel ── */}
          <div className="ml3-right">
            <div className="ml3-panel-head">
              <div className="ml3-panel-title">
                Tracks{tracks.length ? ` (${tracks.length})` : ""}
              </div>
            </div>

            <div className="ml3-tab-body">
                <div
                  className={`ml3-drop${dragOver ? " over" : ""}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
                  onClick={() => { const i=document.createElement("input"); i.type="file"; i.accept="audio/*"; i.multiple=true; i.onchange=e=>handleFiles(e.target.files); i.click(); }}
                >
                  <div style={{ fontSize:10, color:"#707090", lineHeight:1.7 }}>
                    Drop audio files · or click to browse<br/>
                    <span style={{ fontSize:9, color:"#4A4A65" }}>MP3 · WAV · AAC · FLAC · OGG</span>
                  </div>
                </div>

                {tracks.length === 0
                  ? <div className="ml3-empty">No tracks yet.<br/>Upload audio to start building your arrangement.</div>
                  : <>
                      <div className="ml3-divider">Arrangement</div>
                      {tracks.map(t => {
                        const isOn = t.id === activeTrackId;
                        return (
                          <div key={t.id} className={`ml3-titem${isOn ? " on" : ""}`} onClick={() => selectTrack(t.id)}>
                            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                              <div className="ml3-ticon" style={{ background:`${t.color}18`, border:`1px solid ${t.color}28` }}>
                                {[.4,.85,.5,1,.65].map((h,i) => (
                                  <div key={i} style={{ width:2, height:`${h*100}%`, background:t.color, borderRadius:1, opacity:isOn?1:.3 }} />
                                ))}
                              </div>
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontSize:11.5, fontWeight:500, color:isOn?"#DCDCEE":"#707090", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{t.name}</div>
                                <div style={{ fontSize:9.5, color:"#606078" }}>{t.size}{t.audioDuration ? ` · ${fmt(t.audioDuration, DISPLAY_FPS)}` : ""}</div>
                              </div>
                              {isOn && playing && (
                                <div className="ml3-pbars">
                                  {pbAnim.map((s,i) => <div key={i} className="ml3-pbar" style={{ ...s, background:t.color }} />)}
                                </div>
                              )}
                              {isOn && !playing && (
                                <span style={{ fontSize:9, background:`${t.color}18`, color:t.color, padding:"2px 5px", borderRadius:3, fontWeight:500, textTransform:"uppercase", letterSpacing:".06em" }}>active</span>
                              )}
                              <button className="ml3-rm" onClick={e => removeTrack(t.id, e)}>×</button>
                            </div>
                            <div className="ml3-io">
                              <span style={{ fontSize:9, color:"#606078", textTransform:"uppercase", letterSpacing:".06em" }}>in</span>
                              <input className="ml3-io-inp" placeholder="0s"
                                value={t.inPoint != null ? t.inPoint : ""}
                                onChange={e => updateTrackIO(t.id, "inPoint", e.target.value)}
                                onClick={e => e.stopPropagation()} />
                              <span style={{ fontSize:9, color:"#353550" }}>→</span>
                              <span style={{ fontSize:9, color:"#606078", textTransform:"uppercase", letterSpacing:".06em" }}>out</span>
                              <input className="ml3-io-inp" placeholder="end"
                                value={t.outPoint != null ? t.outPoint : ""}
                                onChange={e => updateTrackIO(t.id, "outPoint", e.target.value)}
                                onClick={e => e.stopPropagation()} />
                              <span style={{ fontSize:9, color:"#353550" }}>s</span>
                            </div>
                          </div>
                        );
                      })}
                    </>
                }
            </div>
          </div>
        </div>
      </div>
    </>
  );
}