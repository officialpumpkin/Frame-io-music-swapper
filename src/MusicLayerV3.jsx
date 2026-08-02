import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { exportWithMusic, exportFileName, downloadBlob } from "./exportMix.js";

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
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=swap');

.bms {
  --bg:#08080D; --surface:#11111A; --surface-2:#181822; --line:#20202D;
  --text:#E8E8F2; --muted:#7A7A94; --dim:#4E4E64;
  --accent:#F59E0B; --green:#10B981; --red:#EF4444;

  position:fixed; inset:0; display:flex; flex-direction:column; overflow:hidden;
  background:var(--bg); color:var(--text); font-size:13px;
  font-family:'Inter',system-ui,-apple-system,sans-serif;
  -webkit-tap-highlight-color:transparent;
}
.bms *, .bms *::before, .bms *::after { box-sizing:border-box; margin:0; padding:0; }
.bms button { font-family:inherit; }
.mono { font-family:'IBM Plex Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }
.bms-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }

/* ── Top bar ─────────────────────────────────────────────────────────────── */
.bms-top {
  flex-shrink:0; display:flex; align-items:center; gap:10px; height:54px; z-index:30;
  padding-left:max(12px, env(safe-area-inset-left));
  padding-right:max(12px, env(safe-area-inset-right));
  background:var(--surface); border-bottom:1px solid var(--line);
}
.bms-brand { display:flex; align-items:center; gap:9px; min-width:0; overflow:hidden; }
/* Brand artwork ships as black-on-transparent, so it is inverted for the dark UI. */
.bms-mark { width:21px; height:21px; flex-shrink:0; filter:invert(1); opacity:.94; }
.bms-wordmark { height:10px; width:auto; filter:invert(1); opacity:.94; }
.bms-rule { width:1px; height:15px; background:var(--line); flex-shrink:0; }
.bms-title {
  font-size:10.5px; font-weight:600; letter-spacing:.15em; text-transform:uppercase;
  color:var(--text); white-space:nowrap;
}
.bms-powered { font-size:9.5px; color:var(--dim); white-space:nowrap; letter-spacing:.04em; }

.bms-top-right { display:flex; align-items:center; gap:8px; margin-left:auto; min-width:0; }

/* ── Controls ────────────────────────────────────────────────────────────── */
.bms-input {
  background:var(--surface-2); border:1px solid var(--line); color:var(--text);
  border-radius:8px; padding:8px 11px; font-size:12px; outline:none; min-width:0;
  font-family:'IBM Plex Mono',monospace;
}
.bms-input::placeholder { color:var(--dim); }
.bms-input:focus { border-color:#F59E0B77; }
.bms-url { width:clamp(170px, 24vw, 320px); }

.bms-btn {
  border-radius:8px; padding:8px 13px; font-size:12px; font-weight:500; cursor:pointer;
  border:1px solid transparent; white-space:nowrap; transition:background .12s, border-color .12s;
}
.bms-btn:disabled { opacity:.38; cursor:default; }
.bms-btn-amber { background:#F59E0B1A; border-color:#F59E0B55; color:var(--accent); }
.bms-btn-amber:hover:not(:disabled) { background:#F59E0B2E; }
.bms-btn-green { background:#10B9811A; border-color:#10B98155; color:var(--green); width:100%; }
.bms-btn-green:hover:not(:disabled) { background:#10B9812E; }
.bms-btn-ghost { background:transparent; border-color:var(--line); color:var(--muted); }
.bms-btn-ghost:hover:not(:disabled) { color:var(--text); border-color:#33334A; }

.bms-icon {
  width:38px; height:38px; flex-shrink:0; border-radius:9px; cursor:pointer;
  background:var(--surface-2); border:1px solid var(--line); color:var(--muted);
  display:grid; place-items:center; transition:color .12s, border-color .12s, background .12s;
}
.bms-icon:hover:not(:disabled) { color:var(--text); border-color:#33334A; }
.bms-icon.on { color:var(--accent); border-color:#F59E0B55; background:#F59E0B14; }
.bms-icon:disabled { opacity:.38; cursor:default; }
.bms-icon svg { width:17px; height:17px; display:block; }

.bms-chip { font-size:10px; padding:4px 9px; border-radius:6px; font-weight:500; white-space:nowrap; }
.bms-chip-ok  { background:#10B98122; color:var(--green); border:1px solid #10B98140; }
.bms-chip-err { background:#EF444422; color:var(--red);   border:1px solid #EF444440; }
/* Asset names are long; the chip must never widen the bar past the viewport. */
.bms-chip-asset { max-width:min(34vw, 320px); overflow:hidden; text-overflow:ellipsis; }

.bms-loader-desktop { display:flex; align-items:center; gap:6px; min-width:0; }
.bms-only-mobile { display:none !important; }
.bms-loader-row {
  display:flex; gap:6px; flex-shrink:0; background:var(--surface);
  border-bottom:1px solid var(--line);
  padding:0 max(12px, env(safe-area-inset-left)) 10px max(12px, env(safe-area-inset-right));
}
.bms-loader-row .bms-input { flex:1; min-width:0; }

/* ── Stage ───────────────────────────────────────────────────────────────── */
.bms-body { flex:1; min-height:0; display:flex; }
.bms-main { flex:1; min-width:0; display:flex; flex-direction:column; }

.bms-stage {
  position:relative; flex:1; min-height:0; background:#000;
  display:grid; place-items:center; overflow:hidden;
}
/* No fixed aspect ratio: the video reports its own, so 16:9 and 9:16 both sit
   centred and correctly letter/pillarboxed. */
.bms-stage video {
  display:block; width:auto; height:auto; max-width:100%; max-height:100%; background:#000;
}
.bms-stage:fullscreen { width:100vw; height:100vh; }

.bms-empty {
  display:flex; flex-direction:column; align-items:center; gap:10px;
  padding:40px 24px; text-align:center;
}
.bms-empty-txt { font-size:10.5px; color:var(--muted); letter-spacing:.1em; text-transform:uppercase; }

.bms-ov { position:absolute; left:0; right:0; transition:opacity .22s ease; }
.bms-ov-top {
  top:0; padding:10px 12px; display:flex; align-items:center; gap:8px; pointer-events:none;
  background:linear-gradient(rgba(0,0,0,.6), transparent);
}
.bms-ov-bot {
  bottom:0; padding:30px 12px calc(12px + env(safe-area-inset-bottom));
  background:linear-gradient(transparent, rgba(0,0,0,.8));
}
.bms-hidden { opacity:0; pointer-events:none !important; }

.bms-tc { font-size:11px; color:rgba(232,232,242,.62); }
.bms-dims { font-size:9.5px; color:rgba(232,232,242,.38); border:1px solid rgba(255,255,255,.14); border-radius:5px; padding:2px 6px; }
.bms-live { margin-left:auto; display:flex; align-items:center; gap:5px; }
.bms-live-dot { width:6px; height:6px; border-radius:50%; background:var(--red); animation:bms-pulse .9s infinite; }
.bms-live-txt { font-size:9px; color:var(--red); letter-spacing:.14em; text-transform:uppercase; }

.bms-nowplaying {
  display:flex; align-items:center; gap:7px; margin-bottom:9px; min-width:0;
  font-size:11px; color:rgba(232,232,242,.66);
}
.bms-np-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* Scrubber */
.bms-scrub { width:100%; height:22px; cursor:pointer; display:block; touch-action:none; }
.bms-scrub-track { position:relative; height:4px; border-radius:2px; background:rgba(255,255,255,.18); margin-top:9px; }
.bms-scrub-fill { position:absolute; inset:0 auto 0 0; border-radius:2px; background:var(--accent); }
.bms-scrub-knob {
  position:absolute; top:50%; width:12px; height:12px; border-radius:50%; background:var(--accent);
  transform:translate(-50%,-50%); box-shadow:0 1px 4px rgba(0,0,0,.6);
}

.bms-transport { display:flex; align-items:center; gap:9px; margin-top:6px; }
.bms-play {
  width:46px; height:46px; flex-shrink:0; border-radius:50%; border:none; cursor:pointer;
  background:var(--accent); color:#08080D; display:grid; place-items:center; transition:transform .1s;
}
.bms-play:hover { background:#FBBF24; }
.bms-play:active { transform:scale(.95); }
.bms-play svg { width:19px; height:19px; display:block; }
.bms-ghosticon {
  width:38px; height:38px; flex-shrink:0; border-radius:9px; cursor:pointer; color:#D6D6E6;
  background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.1);
  display:grid; place-items:center;
}
.bms-ghosticon:hover { background:rgba(255,255,255,.16); }
.bms-ghosticon svg { width:17px; height:17px; display:block; }
.bms-time { font-size:11px; color:rgba(232,232,242,.7); white-space:nowrap; }
.bms-vol { display:flex; align-items:center; gap:7px; margin-left:auto; }
.bms-vol input[type=range] { width:82px; cursor:pointer; accent-color:var(--accent); }

/* Folder picker */
.bms-picker { position:absolute; inset:0; background:rgba(8,8,13,.96); display:flex; flex-direction:column; z-index:20; }
.bms-picker-head { padding:13px 15px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:10px; }
.bms-picker-list { flex:1; overflow-y:auto; padding:9px; }
.bms-picker-item {
  padding:10px; border-radius:9px; border:1px solid var(--line); margin-bottom:6px; cursor:pointer;
  display:flex; align-items:center; gap:11px; text-align:left;
  background:transparent; width:100%; color:inherit;
}
.bms-picker-item:hover { background:var(--surface-2); border-color:#33334A; }
.bms-picker-thumb { width:64px; height:36px; border-radius:5px; background:var(--surface-2); object-fit:cover; flex-shrink:0; }

/* ── Waveform dock ───────────────────────────────────────────────────────── */
.bms-dock { flex-shrink:0; background:var(--surface); border-top:1px solid var(--line); }
.bms-dock-head {
  height:34px; display:flex; align-items:center; gap:9px; padding:0 12px; cursor:pointer;
  background:none; border:none; width:100%; color:inherit;
}
.bms-dock-label { font-size:9.5px; letter-spacing:.13em; text-transform:uppercase; color:var(--muted); font-weight:600; }
.bms-dock-hint { font-size:9.5px; color:var(--dim); margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.bms-caret { width:13px; height:13px; color:var(--muted); transition:transform .2s; flex-shrink:0; }
.bms-caret.up { transform:rotate(180deg); }
.bms-dock-body { max-height:34vh; overflow-y:auto; border-top:1px solid var(--line); }

.bms-wrow {
  position:relative; padding:0 12px; cursor:pointer; overflow:hidden; user-select:none;
  border-bottom:1px solid #14141E; transition:background .12s;
}
.bms-wrow:hover { background:#12121B; }
.bms-wrow.active { background:#15151F; }
.bms-wrow-label {
  position:absolute; top:5px; left:16px; display:flex; align-items:center; gap:6px;
  z-index:2; pointer-events:none; max-width:60%;
}
.bms-wrow-name { font-size:10px; font-weight:500; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bms-wrow.active .bms-wrow-name { color:#BFBFD6; }
.bms-wrow-busy { font-size:8.5px; color:var(--dim); letter-spacing:.08em; text-transform:uppercase; }
.bms-dock-empty { padding:20px 14px; text-align:center; font-size:10.5px; color:var(--dim); }

/* ── Tracks drawer ───────────────────────────────────────────────────────── */
.bms-aside {
  flex-shrink:0; width:0; overflow:hidden; background:var(--surface);
  border-left:1px solid var(--line); display:flex; flex-direction:column;
  transition:width .22s ease; z-index:40;
}
.bms-aside.open { width:336px; }
.bms-aside-inner { width:336px; display:flex; flex-direction:column; height:100%; }
.bms-aside-head {
  display:flex; align-items:center; gap:9px; padding:0 12px; height:46px;
  border-bottom:1px solid var(--line); flex-shrink:0;
}
.bms-aside-title { font-size:9.5px; font-weight:600; letter-spacing:.13em; text-transform:uppercase; color:var(--muted); }
.bms-count { font-size:9.5px; color:var(--dim); }
.bms-aside-body { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; }
.bms-grabber { display:none; }
.bms-scrim { display:none; }

.bms-drop {
  margin:11px; border:1.5px dashed var(--line); border-radius:11px; padding:18px 12px;
  text-align:center; cursor:pointer; transition:border-color .15s, background .15s;
  background:none; width:calc(100% - 22px); color:inherit;
}
.bms-drop:hover, .bms-drop.over { border-color:var(--accent); background:#F59E0B0D; }
.bms-drop-1 { font-size:11.5px; color:var(--muted); }
.bms-drop-2 { font-size:9.5px; color:var(--dim); margin-top:4px; }

.bms-divider { font-size:9px; color:var(--dim); text-transform:uppercase; letter-spacing:.12em; padding:10px 13px 4px; font-weight:600; }
.bms-empty-panel { padding:22px 16px; text-align:center; font-size:11.5px; color:var(--dim); line-height:1.8; }

.bms-titem { padding:10px; margin:3px 9px; border-radius:10px; cursor:pointer; border:1px solid transparent; }
.bms-titem:hover { background:var(--surface-2); }
.bms-titem.on { background:var(--surface-2); border-color:var(--line); }
.bms-titem-row { display:flex; align-items:center; gap:9px; }
.bms-ticon { width:32px; height:32px; border-radius:7px; display:flex; align-items:flex-end; justify-content:center; gap:2px; padding-bottom:5px; flex-shrink:0; }
.bms-tname { font-size:12px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bms-tmeta { font-size:9.5px; color:var(--dim); margin-top:1px; }
.bms-badge { font-size:8.5px; padding:2px 6px; border-radius:4px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
.bms-bars { display:flex; align-items:flex-end; gap:2px; height:14px; flex-shrink:0; }
.bms-bar { width:2px; border-radius:1px; }
.bms-rm {
  background:none; border:none; color:#3A3A52; cursor:pointer; font-size:17px; line-height:1;
  padding:5px 7px; border-radius:6px; flex-shrink:0;
}
.bms-rm:hover { color:var(--red); background:#EF444414; }

.bms-io { display:flex; align-items:center; gap:5px; margin-top:8px; }
.bms-io-lbl { font-size:9px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; }
.bms-io-inp {
  background:var(--bg); border:1px solid var(--line); color:#9A9AB8; border-radius:6px;
  padding:5px; font-size:10.5px; width:52px; text-align:center; outline:none;
  font-family:'IBM Plex Mono',monospace;
}
.bms-io-inp:focus { border-color:#F59E0B55; color:var(--text); }

/* ── Export ──────────────────────────────────────────────────────────────── */
.bms-export {
  padding:11px; padding-bottom:max(11px, env(safe-area-inset-bottom));
  border-top:1px solid var(--line); flex-shrink:0;
}
.bms-prog { height:3px; background:var(--line); border-radius:2px; overflow:hidden; margin-top:9px; }
.bms-prog-bar { height:100%; background:var(--green); transition:width .2s; }
.bms-note { font-size:9.5px; color:var(--dim); margin-top:8px; line-height:1.65; }

.bms ::-webkit-scrollbar { width:4px; height:4px; }
.bms ::-webkit-scrollbar-thumb { background:#26263A; border-radius:2px; }

@keyframes bms-pulse { 0%,100%{opacity:1} 50%{opacity:.2} }
@keyframes bms-b0 { to{height:30%} }
@keyframes bms-b1 { to{height:88%} }
@keyframes bms-b2 { to{height:50%} }
@keyframes bms-b3 { to{height:95%} }

/* ── Narrow / mobile ─────────────────────────────────────────────────────── */
@media (max-width:880px) {
  .bms-url, .bms-loader-desktop { display:none !important; }
  .bms-only-mobile { display:grid !important; }
  .bms-powered { display:none; }

  /* Tracks become a bottom sheet rather than a side panel. */
  .bms-aside {
    position:fixed; left:0; right:0; bottom:0; top:auto; width:auto; border-left:none;
    border-top:1px solid var(--line); border-radius:18px 18px 0 0;
    height:min(74dvh, 620px); transform:translateY(101%); transition:transform .26s ease;
    box-shadow:0 -12px 40px rgba(0,0,0,.6);
  }
  .bms-aside.open { width:auto; transform:translateY(0); }
  .bms-aside-inner { width:100%; }
  .bms-grabber { display:block; width:36px; height:4px; border-radius:2px; background:#31314A; margin:9px auto 3px; flex-shrink:0; }
  .bms-scrim { display:block; position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:39; }
  .bms-dock-body { max-height:30vh; }
  .bms-dock-hint { display:none; }
}

@media (max-width:560px) {
  .bms-top { height:50px; gap:8px; }
  /* The loaded video is its own confirmation at this width. */
  .bms-chip-asset { display:none; }
  .bms-title { font-size:10px; letter-spacing:.1em; }
  .bms-vol input[type=range] { display:none; }
  .bms-transport { gap:7px; }
}

/* The full lockup fits at 360px (a very common Android width); only below it
   does the bar run out of room, so drop back to the mark alone there. */
@media (max-width:359px) {
  .bms-wordmark, .bms-rule { display:none; }
}

/* A landscape phone has almost no height to spare, so give it all to the video. */
@media (max-height:520px) and (orientation:landscape) {
  .bms-top { height:44px; }
  .bms-dock-body { max-height:26vh; }
}
`;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function MusicLayerV3() {

  // ── Auth
  //
  // The proxy authenticates with its own FRAMEIO_TOKEN and ignores whatever the
  // client sends, so there is nothing for the user to enter. This is a sentinel
  // that keeps the request signature intact rather than a real credential.
  const token = "server-auth";

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

  // ── Export
  const [exportState, setExportState] = useState(null); // { phase, progress }
  const [exportErr, setExportErr]     = useState("");

  // ── Shell / chrome
  const [drawerOpen, setDrawerOpen]     = useState(false);
  const [dockOpen, setDockOpen]         = useState(true);
  const [loaderOpen, setLoaderOpen]     = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(false);
  const [videoDims, setVideoDims]       = useState(null);

  // ── Refs
  const videoRef     = useRef(null);
  const audioRef     = useRef(null);
  const rafRef       = useRef(null);
  const startRef     = useRef(0);
  const posRef       = useRef(0);
  const waveStackRef = useRef(null);
  const stageRef     = useRef(null);
  const hideTimerRef = useRef(null);

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

  // ── Full screen
  //
  // The stage element goes full screen rather than the video, so the overlaid
  // transport stays usable. iOS Safari has no Element.requestFullscreen, so fall
  // back to the video's own native full-screen presentation there.
  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    if (stage?.requestFullscreen) {
      stage.requestFullscreen().catch(() => {});
    } else {
      videoRef.current?.webkitEnterFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // ── Auto-hide the overlays while playing, like any video player.
  // The timer is armed imperatively from real interactions rather than from an
  // effect, so nothing sets state during render.
  const wakeChrome = useCallback(() => {
    setChromeHidden(false);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (playingRef.current) setChromeHidden(true);
    }, 2600);
  }, []);

  useEffect(() => () => clearTimeout(hideTimerRef.current), []);

  // ── Scrubbing
  const scrubFrom = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(fraction * (durRef.current || 0));
  }, [seekTo]);

  // ── Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const inField = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
      if (inField) return;
      if (e.code === "Space") { e.preventDefault(); handlePlay(); wakeChrome(); }
      if (e.code === "KeyF")  { e.preventDefault(); toggleFullscreen(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePlay, toggleFullscreen, wakeChrome]);

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

  // ── Export the cut with the music arrangement mixed in
  const handleExport = useCallback(async () => {
    if (!currentAsset?.url || !tracks.length || exportState) return;
    setExportErr("");
    setPlaying(false);
    videoRef.current?.pause();
    audioRef.current?.pause();
    try {
      const blob = await exportWithMusic({
        videoUrl:      currentAsset.url,
        tracks,
        activeTrackId,
        volume:        vol,
        durationSec:   dur || videoRef.current?.duration,
        onPhase:       setExportState,
      });
      downloadBlob(blob, exportFileName(currentAsset.name));
    } catch (e) {
      setExportErr(e.message);
    }
    setExportState(null);
  }, [currentAsset, tracks, activeTrackId, vol, dur, exportState]);

  // ── Derived
  const pbAnim = useMemo(() => [
    { height:"60%", animation: playing ? "bms-b0 .28s ease infinite alternate" : "none" },
    { height:"30%", animation: playing ? "bms-b1 .42s ease infinite alternate" : "none" },
    { height:"80%", animation: playing ? "bms-b2 .35s ease infinite alternate" : "none" },
    { height:"45%", animation: playing ? "bms-b3 .5s ease infinite alternate"  : "none" },
  ], [playing]);

  // ─── Render ───────────────────────────────────────────────────────────────

  const scrubPct = effectiveDur ? Math.min(100, (pos / effectiveDur) * 100) : 0;
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <>
      <style>{CSS}</style>
      <audio ref={audioRef} />

      <div className="bms">

        {/* ── Top bar ── */}
        <header className="bms-top">
          <div className="bms-brand">
            <img className="bms-mark" src="/brand/brightworks-b.png" alt="" />
            <img className="bms-wordmark" src="/brand/brightworks-wordmark.png" alt="Brightworks" />
            <span className="bms-rule" />
            <span className="bms-title">Music Swapper</span>
            <span className="bms-powered">powered by Frame.io</span>
          </div>

          <div className="bms-top-right">
            {currentAsset && (
              <span className="bms-chip bms-chip-ok bms-chip-asset" title={currentAsset.name}>
                {currentAsset.name}
              </span>
            )}
            {resolveErr && <span className="bms-chip bms-chip-err">{resolveErr}</span>}

            <div className="bms-loader-desktop">
              <input
                className="bms-input bms-url"
                placeholder="Paste a Frame.io link…"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleResolve()}
              />
              <button
                className="bms-btn bms-btn-amber"
                onClick={handleResolve}
                disabled={resolving || !urlInput.trim()}
              >
                {resolving ? "Loading…" : "Load"}
              </button>
            </div>

            <button
              className={`bms-icon bms-only-mobile${loaderOpen ? " on" : ""}`}
              onClick={() => setLoaderOpen(o => !o)}
              aria-label="Load a Frame.io link"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
              </svg>
            </button>

            <button
              className={`bms-icon${drawerOpen ? " on" : ""}`}
              onClick={() => setDrawerOpen(o => !o)}
              aria-label="Music tracks"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
              </svg>
            </button>
          </div>
        </header>

        {/* Narrow screens get the link field on its own row, on demand. */}
        {loaderOpen && (
          <div className="bms-loader-row">
            <input
              className="bms-input"
              placeholder="Paste a Frame.io link…"
              value={urlInput}
              autoFocus
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleResolve()}
            />
            <button
              className="bms-btn bms-btn-amber"
              onClick={handleResolve}
              disabled={resolving || !urlInput.trim()}
            >
              {resolving ? "…" : "Load"}
            </button>
          </div>
        )}

        <div className="bms-body">
          <main className="bms-main">

            {/* ── Stage ── */}
            <div
              className="bms-stage"
              ref={stageRef}
              onPointerMove={wakeChrome}
              onTouchStart={wakeChrome}
            >
              {currentAsset?.url ? (
                <video
                  ref={videoRef}
                  playsInline
                  controls={false}
                  onLoadedMetadata={e => setVideoDims({
                    w: e.currentTarget.videoWidth,
                    h: e.currentTarget.videoHeight,
                  })}
                  onClick={handlePlay}
                />
              ) : (
                <div className="bms-empty">
                  <svg width="42" height="42" viewBox="0 0 24 24" fill="none"
                       stroke="#5A5A72" strokeWidth="1.3" strokeLinecap="round">
                    <rect x="2" y="4" width="20" height="16" rx="3" />
                    <path d="M10 9l6 3-6 3z" fill="#5A5A72" stroke="none" />
                  </svg>
                  <span className="bms-empty-txt">Paste a Frame.io link to begin</span>
                </div>
              )}

              {/* Folder picker */}
              {folderAssets && (
                <div className="bms-picker">
                  <div className="bms-picker-head">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{folderName}</div>
                      <div style={{ fontSize: 10.5, color: "#7A7A94", marginTop: 2 }}>
                        Choose a video
                      </div>
                    </div>
                    <button className="bms-icon" onClick={() => setFolderAssets(null)} aria-label="Close">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="bms-picker-list">
                    {folderAssets.map(a => (
                      <button key={a.id} className="bms-picker-item" onClick={() => selectFolderAsset(a)}>
                        {a.thumb
                          ? <img className="bms-picker-thumb" src={a.thumb} alt="" />
                          : <div className="bms-picker-thumb" />}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                          <div style={{ fontSize: 10, color: "#4E4E64", marginTop: 2 }}>
                            {a.url ? "Playable" : "No stream URL"}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Top overlay */}
              <div className={`bms-ov bms-ov-top${chromeHidden ? " bms-hidden" : ""}`}>
                <span className="bms-tc mono">{fmt(pos, DISPLAY_FPS)}</span>
                {videoDims && (
                  <span className="bms-dims mono">{videoDims.w}×{videoDims.h}</span>
                )}
                {playing && (
                  <span className="bms-live">
                    <span className="bms-live-dot" />
                    <span className="bms-live-txt">Live</span>
                  </span>
                )}
              </div>

              {/* Bottom overlay: scrubber + transport */}
              <div className={`bms-ov bms-ov-bot${chromeHidden ? " bms-hidden" : ""}`}>
                {activeTrack && (
                  <div className="bms-nowplaying">
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: activeTrack.color, flexShrink: 0 }} />
                    <span className="bms-np-name">{activeTrack.name}</span>
                  </div>
                )}

                <div
                  className="bms-scrub"
                  onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); scrubFrom(e); }}
                  onPointerMove={e => { if (e.buttons === 1) scrubFrom(e); }}
                  role="slider"
                  aria-label="Seek"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(effectiveDur) || 0}
                  aria-valuenow={Math.round(pos)}
                  tabIndex={0}
                >
                  <div className="bms-scrub-track">
                    <div className="bms-scrub-fill" style={{ width: `${scrubPct}%` }} />
                    <div className="bms-scrub-knob" style={{ left: `${scrubPct}%` }} />
                  </div>
                </div>

                <div className="bms-transport">
                  <button
                    className="bms-play"
                    onClick={() => { handlePlay(); wakeChrome(); }}
                    aria-label={playing ? "Pause" : "Play"}
                  >
                    {playing
                      ? <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                      : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>}
                  </button>

                  <button className="bms-ghosticon" onClick={handleStop} aria-label="Back to start">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M19 20L9 12l10-8z" /><path d="M5 5v14" />
                    </svg>
                  </button>

                  <span className="bms-time mono">
                    {fmt(pos, DISPLAY_FPS)} / {fmt(effectiveDur, DISPLAY_FPS)}
                  </span>

                  <div className="bms-vol">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round" style={{ color: "#9A9AB8" }}>
                      <path d="M11 5L6 9H3v6h3l5 4z" />
                      <path d="M16 9a4 4 0 0 1 0 6" />
                    </svg>
                    <input
                      type="range" min="0" max="1" step="0.01" value={vol}
                      onChange={e => setVol(parseFloat(e.target.value))}
                      aria-label="Music volume"
                    />
                  </div>

                  <button className="bms-ghosticon" onClick={toggleFullscreen}
                          aria-label={isFullscreen ? "Exit full screen" : "Full screen"}>
                    {isFullscreen
                      ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
                        </svg>
                      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
                        </svg>}
                  </button>
                </div>
              </div>
            </div>

            {/* ── Waveform dock ── */}
            <div className="bms-dock">
              <button className="bms-dock-head" onClick={() => setDockOpen(o => !o)}>
                <svg className={`bms-caret${dockOpen ? " up" : ""}`} viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
                <span className="bms-dock-label">Waveforms</span>
                <span className="bms-count">{tracks.length || ""}</span>
                <span className="bms-dock-hint">Click to seek · Space to play · F for full screen</span>
              </button>

              {dockOpen && (
                <div className="bms-dock-body" ref={waveStackRef}>
                  {tracks.length === 0 ? (
                    <div className="bms-dock-empty">Add music tracks to see their waveforms</div>
                  ) : (
                    tracks.map(t => {
                      const isActive = t.id === activeTrackId;
                      const rowH = isActive ? 64 : 46;
                      return (
                        <div
                          key={t.id}
                          className={`bms-wrow${isActive ? " active" : ""}`}
                          style={{ height: rowH }}
                          onClick={e => handleWaveformClick(e, t.id)}
                        >
                          <div className="bms-wrow-label">
                            <span style={{ width: 5, height: 5, borderRadius: "50%", background: t.color, flexShrink: 0 }} />
                            <span className="bms-wrow-name">{t.name}</span>
                            {t.analysing && <span className="bms-wrow-busy">Analysing…</span>}
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
              )}
            </div>
          </main>

          {/* ── Tracks drawer ── */}
          <aside className={`bms-aside${drawerOpen ? " open" : ""}`} aria-hidden={!drawerOpen}>
            <div className="bms-aside-inner">
              <div className="bms-grabber" />

              <div className="bms-aside-head">
                <span className="bms-aside-title">Music tracks</span>
                <span className="bms-count">{tracks.length || ""}</span>
                <button className="bms-icon" style={{ marginLeft: "auto" }} onClick={closeDrawer} aria-label="Close">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="bms-aside-body">
                <button
                  className={`bms-drop${dragOver ? " over" : ""}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
                  onClick={() => {
                    const i = document.createElement("input");
                    i.type = "file"; i.accept = "audio/*"; i.multiple = true;
                    i.onchange = e => handleFiles(e.target.files);
                    i.click();
                  }}
                >
                  <div className="bms-drop-1">Drop audio · or tap to browse</div>
                  <div className="bms-drop-2">MP3 · WAV · AAC · FLAC · OGG</div>
                </button>

                {tracks.length === 0 ? (
                  <div className="bms-empty-panel">
                    No tracks yet.<br />Add music to build your arrangement.
                  </div>
                ) : (
                  <>
                    <div className="bms-divider">Arrangement</div>
                    {tracks.map(t => {
                      const isOn = t.id === activeTrackId;
                      return (
                        <div key={t.id} className={`bms-titem${isOn ? " on" : ""}`} onClick={() => selectTrack(t.id)}>
                          <div className="bms-titem-row">
                            <div className="bms-ticon" style={{ background: `${t.color}1C`, border: `1px solid ${t.color}2E` }}>
                              {[.4, .85, .5, 1, .65].map((h, i) => (
                                <span key={i} style={{ width: 2, height: `${h * 100}%`, background: t.color, borderRadius: 1, opacity: isOn ? 1 : .35 }} />
                              ))}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="bms-tname" style={{ color: isOn ? "#E8E8F2" : "#8A8AA6" }}>{t.name}</div>
                              <div className="bms-tmeta">
                                {t.size}{t.audioDuration ? ` · ${fmt(t.audioDuration, DISPLAY_FPS)}` : ""}
                              </div>
                            </div>
                            {isOn && playing && (
                              <div className="bms-bars">
                                {pbAnim.map((s, i) => <span key={i} className="bms-bar" style={{ ...s, background: t.color }} />)}
                              </div>
                            )}
                            {isOn && !playing && (
                              <span className="bms-badge" style={{ background: `${t.color}1C`, color: t.color }}>active</span>
                            )}
                            <button className="bms-rm" onClick={e => removeTrack(t.id, e)} aria-label={`Remove ${t.name}`}>×</button>
                          </div>

                          <div className="bms-io">
                            <span className="bms-io-lbl">in</span>
                            <input className="bms-io-inp" placeholder="0s" inputMode="decimal"
                              value={t.inPoint != null ? t.inPoint : ""}
                              onChange={e => updateTrackIO(t.id, "inPoint", e.target.value)}
                              onClick={e => e.stopPropagation()} />
                            <span style={{ color: "#3A3A52" }}>→</span>
                            <span className="bms-io-lbl">out</span>
                            <input className="bms-io-inp" placeholder="end" inputMode="decimal"
                              value={t.outPoint != null ? t.outPoint : ""}
                              onChange={e => updateTrackIO(t.id, "outPoint", e.target.value)}
                              onClick={e => e.stopPropagation()} />
                            <span className="bms-io-lbl">sec</span>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>

              <div className="bms-export">
                <button
                  className="bms-btn bms-btn-green"
                  onClick={handleExport}
                  disabled={!currentAsset || tracks.length === 0 || !!exportState}
                >
                  {exportState ? `${exportState.phase}…` : "↓ Export MP4 with music"}
                </button>

                {exportState && (
                  <div className="bms-prog">
                    <div className="bms-prog-bar" style={{ width: `${Math.round((exportState.progress || 0) * 100)}%` }} />
                  </div>
                )}

                {exportErr && (
                  <div className="bms-chip bms-chip-err" style={{ display: "block", marginTop: 9 }}>{exportErr}</div>
                )}

                {!exportState && !exportErr && currentAsset && tracks.length > 0 && (
                  <div className="bms-note">
                    Video is copied, not re-encoded — same resolution and quality.
                    Music is mixed under the original audio.
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>

        {drawerOpen && <div className="bms-scrim" onClick={closeDrawer} />}
      </div>
    </>
  );
}
