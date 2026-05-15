import { useState, useRef, useEffect, useCallback, useMemo } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────

const PREMIERE_COLORS = [
  { id: "red",    hex: "#EF4444", prCode: 0, label: "Red"    },
  { id: "orange", hex: "#F97316", prCode: 1, label: "Orange" },
  { id: "yellow", hex: "#EAB308", prCode: 2, label: "Yellow" },
  { id: "green",  hex: "#10B981", prCode: 3, label: "Green"  },
  { id: "teal",   hex: "#14B8A6", prCode: 4, label: "Teal"   },
  { id: "blue",   hex: "#3B82F6", prCode: 5, label: "Blue"   },
  { id: "purple", hex: "#8B5CF6", prCode: 6, label: "Purple" },
  { id: "pink",   hex: "#EC4899", prCode: 7, label: "Pink"   },
];

const TRACK_PALETTE = [
  "#F59E0B","#EF4444","#10B981","#6366F1",
  "#EC4899","#14B8A6","#F97316","#A78BFA",
  "#FB923C","#34D399","#60A5FA","#F472B6",
];

const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

// ─── Frame.io API Layer ───────────────────────────────────────────────────────

// Relative URL works in both local dev (Vite proxy) and on Vercel (serverless function)
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

const FIO = {
  me:             (t)          => apiRequest(t, "GET",  "/me"),
  asset:          (t, id)      => apiRequest(t, "GET",  `/assets/${id}`),
  children:       (t, id)      => apiRequest(t, "GET",  `/assets/${id}/children?type=file&page=1&page_size=40`),
  reviewLink:     (t, id)      => apiRequest(t, "GET",  `/review_links/${id}`),
  getComments:    (t, assetId) => apiRequest(t, "GET",  `/assets/${assetId}/comments`),
  postComment:    (t, assetId, text, timestamp) =>
    apiRequest(t, "POST", `/assets/${assetId}/comments`, { text, timestamp }),
};

// Parse any Frame.io URL and return { type, id }
function parseFrameioURL(url) {
  const u = url.trim();
  const reviewMatch  = u.match(/\/reviews\/([a-f0-9-]{36})/i);
  if (reviewMatch) return { type: "review_link", id: reviewMatch[1] };
  const presentMatch = u.match(/\/presentations\/([a-f0-9-]{36})/i);
  if (presentMatch) return { type: "review_link", id: presentMatch[1] };
  const uuid = u.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (uuid) return { type: "asset", id: uuid[1] };
  return null;
}

// Resolve any URL → { type: 'video'|'folder', asset?, assets?, folderName? }
async function resolveURL(token, url) {
  const parsed = parseFrameioURL(url);
  if (!parsed) throw new Error("Couldn't find a Frame.io asset ID in that URL.");

  if (parsed.type === "review_link") {
    const link = await FIO.reviewLink(token, parsed.id);
    const items = link.items || link.assets || [];
    const videos = items.filter(a => a.type === "file");
    if (videos.length === 1) return { type: "video", asset: videos[0] };
    if (videos.length > 1)  return { type: "folder", assets: videos, folderName: link.name || "Review Link" };
    throw new Error("This review link contains no video assets.");
  }

  const asset = await FIO.asset(token, parsed.id);
  if (asset.type === "file") return { type: "video", asset };

  // Folder / project
  const children = await FIO.children(token, parsed.id);
  const videos = children.filter(a => a.type === "file" && /video/i.test(a.media_type || ""));
  if (videos.length === 0) throw new Error("No video files found in this folder.");
  if (videos.length === 1) return { type: "video", asset: videos[0] };
  return { type: "folder", assets: videos, folderName: asset.name };
}

// Pick best available playback URL from an asset
function videoURL(asset) {
  const t = asset.transcodes || {};
  return t.h264_1080 || t.h264_720 || t.h264_540 || t.h264_360 || asset.original || null;
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

// Decode audio file — returns real waveform AND duration so we don't rely
// on the audio element's async metadata event (which can be 0 in StrictMode)
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

// Spotify-style symmetric SVG waveform
// Bars grow from the centre outward, rounded ends, played portion illuminated
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
function esc(s) {
  return String(s||"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ─── Premiere FCP7 XML ────────────────────────────────────────────────────────

function buildXML(markers, projectName, fps) {
  const tb = Math.round(fps);
  const rows = [...markers].sort((a,b) => a.time - b.time).map(m => {
    const frame  = Math.round(m.time * fps);
    const color  = PREMIERE_COLORS.find(c => c.id === m.colorId) || PREMIERE_COLORS[0];
    const track  = m.trackName ? `Track: "${esc(m.trackName)}"` : "No track";
    const note   = m.note ? ` — ${esc(m.note)}` : "";
    const comment = `${track}${note}`;
    return `      <marker>
        <name>${esc(m.label || "Marker")}</name>
        <comment>${comment}</comment>
        <in>${frame}</in>
        <out>-1</out>
        <color>${color.prCode}</color>
      </marker>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence>
    <name>${esc(projectName || "Client Markers")}</name>
    <rate><timebase>${tb}</timebase><ntsc>FALSE</ntsc></rate>
    <timecode>
      <rate><timebase>${tb}</timebase><ntsc>FALSE</ntsc></rate>
      <string>00:00:00:00</string><frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video><format><samplecharacteristics>
        <width>1920</width><height>1080</height>
      </samplecharacteristics></format></video>
    </media>
    <markers>
${rows}
    </markers>
  </sequence>
</xmeml>`;
}

function downloadXML(xml, name) {
  const blob = new Blob([xml], { type: "application/xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

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
.ml3-btn-green { background:#10B98118; border-color:#10B98155; color:#10B981; }
.ml3-btn-green:hover { background:#10B98128; }
.ml3-btn-green:disabled { opacity:.35; cursor:default; }
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

/* Marker strip */
.ml3-marker-row { height:18px; position:relative; background:#0A0A12; cursor:crosshair; overflow:visible; border-bottom:1px solid #16161F; }

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

/* Marker lines */
.ml3-wmarker-line { position:absolute; top:0; bottom:0; width:1px; opacity:.5; pointer-events:none; z-index:3; transform:translateX(-50%); }

/* Delete confirmation banner */
.ml3-delete-confirm { position:absolute; top:4px; left:50%; transform:translateX(-50%); background:#16161F; border:1px solid #EF444455; border-radius:8px; padding:8px 12px; display:flex; align-items:center; gap:10px; z-index:50; white-space:nowrap; box-shadow:0 4px 20px rgba(0,0,0,.6); }
.ml3-dc-text { font-size:11px; color:#DCDCEE; }
.ml3-dc-remove { background:#EF444420; border:1px solid #EF444455; color:#EF4444; border-radius:5px; padding:3px 10px; font-size:11px; cursor:pointer; font-weight:500; transition:all .1s; }
.ml3-dc-remove:hover { background:#EF444435; }
.ml3-dc-cancel { background:none; border:1px solid #252535; color:#9090A8; border-radius:5px; padding:3px 10px; font-size:11px; cursor:pointer; transition:all .1s; }
.ml3-dc-cancel:hover { color:#DCDCEE; border-color:#353550; }
.ml3-dc-suppress { display:flex; align-items:center; gap:5px; font-size:10px; color:#6E6E88; cursor:pointer; border-left:1px solid #252535; padding-left:10px; }
.ml3-dc-suppress input { cursor:pointer; accent-color:#F59E0B; }

/* Marker flags */
.ml3-mflag { position:absolute; top:0; bottom:0; width:2px; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; cursor:pointer; z-index:5; }
.ml3-mflag:hover .ml3-mtip { opacity:1; }
.ml3-mflag-diamond { width:7px; height:7px; transform:rotate(45deg) translateX(-2.5px); border-radius:1px; margin-top:2px; flex-shrink:0; }
.ml3-mflag-line { width:1.5px; flex:1; border-radius:1px; opacity:.5; }
.ml3-mtip { position:absolute; top:22px; background:#16161F; border:1px solid #2A2A3C; border-radius:5px; padding:4px 8px; white-space:nowrap; font-size:9.5px; color:#A0A0BC; opacity:0; transition:opacity .1s; z-index:30; pointer-events:none; max-width:180px; overflow:hidden; text-overflow:ellipsis; }

/* Transport */
.ml3-transport { padding:9px 13px; border-bottom:1px solid #1E1E2C; display:flex; align-items:center; gap:7px; flex-shrink:0; }
.ml3-play-btn { background:#F59E0B; border:none; color:#0C0C13; border-radius:7px; padding:7px 16px; cursor:pointer; font-weight:700; font-size:12px; letter-spacing:.04em; transition:all .1s; white-space:nowrap; }
.ml3-play-btn:hover { background:#FBBF24; }
.ml3-play-btn:active { transform:scale(.97); }
.ml3-stop-btn { background:none; border:1px solid #22222F; color:#707090; border-radius:5px; padding:4px 9px; cursor:pointer; font-size:11px; transition:all .1s; }
.ml3-stop-btn:hover { border-color:#353550; color:#A0A0BC; }
.ml3-mark-btn { background:none; border:1px solid #22222F; color:#9090A8; border-radius:5px; padding:4px 11px; cursor:pointer; font-size:11px; font-weight:500; transition:all .1s; letter-spacing:.02em; }
.ml3-mark-btn:hover { border-color:#F59E0B55; color:#F59E0B; }
.ml3-mark-btn:disabled { opacity:.3; cursor:default; }
.ml3-vol { display:flex; align-items:center; gap:6px; margin-left:auto; }
.ml3-vol input[type=range] { width:64px; cursor:pointer; }

/* Right panel */
.ml3-right { display:flex; flex-direction:column; overflow:hidden; }
.ml3-tabs { display:flex; border-bottom:1px solid #1E1E2C; flex-shrink:0; }
.ml3-tab { flex:1; padding:9px 6px; text-align:center; font-size:9.5px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; cursor:pointer; color:#606078; border:none; background:none; border-bottom:2px solid transparent; transition:color .1s; }
.ml3-tab.on { color:#F59E0B; border-bottom-color:#F59E0B; }
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

/* Markers */
.ml3-mitem { padding:8px 10px; margin:3px 7px; border-radius:7px; border:1px solid #1E1E2C; background:#10101A; transition:border-color .1s; }
.ml3-mitem:hover { border-color:#2A2A3C; }
.ml3-mitem.on { border-color:var(--mc); background:rgba(var(--mc-rgb),.06); }
.ml3-mhead { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
.ml3-mlabel { background:transparent; border:none; color:#DCDCEE; font-size:12px; font-weight:500; outline:none; flex:1; min-width:0; font-family:'Inter',sans-serif; }
.ml3-mlabel::placeholder { color:#454560; }
.ml3-mnote { background:#0C0C13; border:1px solid #1E1E2C; color:#9090A8; border-radius:4px; padding:4px 7px; font-size:10.5px; width:100%; outline:none; resize:none; font-family:'Inter',sans-serif; line-height:1.5; }
.ml3-mnote:focus { border-color:#2A2A3C; color:#DCDCEE; }
.ml3-cpick { display:flex; gap:3px; align-items:center; margin-top:4px; }
.ml3-cdot { width:11px; height:11px; border-radius:2px; cursor:pointer; transition:transform .1s; }
.ml3-cdot:hover, .ml3-cdot.on { transform:scale(1.35); outline:1.5px solid rgba(255,255,255,.3); outline-offset:1px; }
.ml3-track-chip { display:inline-flex; align-items:center; gap:4px; font-size:9px; border-radius:3px; padding:2px 5px; font-weight:500; max-width:120px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; flex-shrink:0; }
.ml3-seek-btn { background:none; border:1px solid #1E1E2C; color:#6E6E88; border-radius:4px; padding:2px 6px; font-size:9px; cursor:pointer; font-family:'IBM Plex Mono',monospace; transition:all .1s; }
.ml3-seek-btn:hover { border-color:#2A2A3C; color:#A0A0BC; }
.ml3-fio-badge { font-size:9px; color:#F59E0B; background:#F59E0B18; border:1px solid #F59E0B35; border-radius:3px; padding:1px 5px; flex-shrink:0; }
.ml3-export-zone { padding:8px 9px; border-top:1px solid #1E1E2C; flex-shrink:0; }
.ml3-fps-sel { background:#13131C; border:1px solid #1E1E2C; color:#9090A8; border-radius:4px; padding:3px 6px; font-size:10px; cursor:pointer; outline:none; }
.ml3-proj-inp { background:#13131C; border:1px solid #1E1E2C; color:#9090A8; border-radius:5px; padding:5px 8px; font-size:11px; flex:1; outline:none; }
.ml3-proj-inp:focus { border-color:#F59E0B55; color:#DCDCEE; }

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
  const [token, setToken]         = useState("server-auth");
  const [tokenInput, setTokenInput] = useState("");
  const [connStatus, setConnStatus] = useState("ok"); 
  const [connMsg, setConnMsg]     = useState("Secured by Vercel");  

  // ── Asset / video state
  const [urlInput, setUrlInput]   = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState("");
  const [currentAsset, setCurrentAsset] = useState(null);  // { id, name, url }
  const [folderAssets, setFolderAssets] = useState(null);   // [{id,name,thumb,url}]
  const [folderName, setFolderName] = useState("");

  // ── Playback
  const [playing, setPlaying]     = useState(false);
  const [pos, setPos]             = useState(0);
  const [dur, setDur]             = useState(0);
  const [vol, setVol]             = useState(0.8);

  // ── Music tracks
  const [tracks, setTracks]       = useState([]);
  const [activeTrackId, setActiveTrackId] = useState(null);
  const [dragOver, setDragOver]   = useState(false);

  // ── Markers
  const [markers, setMarkers]     = useState([]);
  const [selectedMId, setSelectedMId] = useState(null);
  const [newMarkerColor, setNewMarkerColor] = useState("red");
  const [projectName, setProjectName] = useState("Client Review");
  const [exportFPS, setExportFPS] = useState(25);

  // ── Frame.io comment sync
  const [syncing, setSyncing]     = useState(false);
  const [syncMsg, setSyncMsg]     = useState("");

  // ── Marker delete confirmation
  const [deleteConfirm, setDeleteConfirm]             = useState(null); // { id, label }
  const [suppressDeleteWarning, setSuppressDeleteWarning] = useState(false);

  // ── UI
  const [tab, setTab]             = useState("tracks");

  // ── Refs
  const videoRef         = useRef(null);
  const audioRef         = useRef(null);
  const rafRef           = useRef(null);
  const startRef         = useRef(0);
  const posRef           = useRef(0);
  const waveStackRef     = useRef(null);
  const markerRowRef     = useRef(null);

  // Mirror refs — always hold the latest state value so callbacks
  // can read them without being in any dependency array (avoids stale closures)
  const tracksRef        = useRef(tracks);
  const activeTrackIdRef = useRef(activeTrackId);
  const playingRef       = useRef(playing);
  const volRef           = useRef(vol);
  const durRef           = useRef(dur);

  useEffect(() => { tracksRef.current        = tracks;        }, [tracks]);
  useEffect(() => { activeTrackIdRef.current = activeTrackId; }, [activeTrackId]);
  useEffect(() => { playingRef.current       = playing;       }, [playing]);
  useEffect(() => { volRef.current           = vol;           }, [vol]);

  const activeTrack = tracks.find(t => t.id === activeTrackId) || null;

  // effectiveDur: video duration if video loaded, otherwise active track's own duration
  const effectiveDur = currentAsset ? dur : (activeTrack?.audioDuration || dur || 0);
  useEffect(() => { durRef.current = effectiveDur; }, [effectiveDur]);

  // ─── Connect token ───────────────────────────────────────────────────────
  const connectToken = useCallback(async () => {
    if (!tokenInput.trim()) return;
    setConnStatus("connecting");
    try {
      const me = await FIO.me(tokenInput.trim());
      setToken(tokenInput.trim());
      setConnStatus("ok");
      setConnMsg(me.email || me.name || "Connected");
    } catch (e) {
      setConnStatus("error");
      setConnMsg(e.message);
    }
  }, [tokenInput]);

  // ─── Resolve Frame.io URL ────────────────────────────────────────────────
  const handleResolve = useCallback(async () => {
    if (!urlInput.trim() || !token) return;
    setResolving(true);
    setResolveErr("");
    setFolderAssets(null);
    try {
      const result = await resolveURL(token, urlInput.trim());
      if (result.type === "video") {
        const url = videoURL(result.asset);
        if (!url) throw new Error("No playable URL found for this asset.");
        setCurrentAsset({ id: result.asset.id, name: result.asset.name, url });
        if (!projectName || projectName === "Client Review") setProjectName(result.asset.name);
      } else {
        setFolderName(result.folderName);
        setFolderAssets(result.assets.map(a => ({
          id: a.id, name: a.name,
          thumb: a.transcodes?.thumbnail_small || a.thumb || null,
          url: videoURL(a),
        })));
      }
    } catch (e) {
      setResolveErr(e.message);
    }
    setResolving(false);
  }, [urlInput, token, projectName]);

  const selectFolderAsset = useCallback((a) => {
    setCurrentAsset(a);
    setFolderAssets(null);
    if (!projectName || projectName === "Client Review") setProjectName(a.name);
  }, [projectName]);

  // ─── Video events ────────────────────────────────────────────────────────
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

  // ─── Music track routing ─────────────────────────────────────────────────
  const trackForTime = useCallback((time, list) => {
    for (const t of list) {
      const inP  = t.inPoint  ?? 0;
      const outP = t.outPoint ?? Infinity;
      if (time >= inP && time < outP) return t;
    }
    return null;
  }, []);

  // ─── Playback ────────────────────────────────────────────────────────────
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
        audioRef.current.volume  = vol;
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

  // RAF loop for music-only mode (no video loaded)
  useEffect(() => {
    if (currentAsset) return; // video element handles time
    if (playing) {
      startRef.current = performance.now();
      posRef.current   = pos;
      const tick = () => {
        const next = posRef.current + (performance.now() - startRef.current) / 1000;
        const maxDur = durRef.current || 300; // reads from ref — always current active track's duration
        if (next >= maxDur) { setPos(maxDur); setPlaying(false); return; }
        setPos(next);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else cancelAnimationFrame(rafRef.current);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, currentAsset]); // removed dur dep — reads from ref now

  // Volume sync
  useEffect(() => { if (audioRef.current) audioRef.current.volume = vol; }, [vol]);

  // Auto-route music — only applies when tracks have explicit in/out regions set.
  // Without defined regions every track covers 0→∞, so trackForTime always returns
  // the first track and fights manual selection. Guard against that here.
  useEffect(() => {
    if (!playing || tracks.length === 0) return;
    const hasArrangement = tracks.some(t => t.inPoint != null || t.outPoint != null);
    if (!hasArrangement) return; // trust manual selection when no arrangement is defined
    const track = trackForTime(pos, tracks);
    if (!track) { audioRef.current?.pause(); return; }
    const a = audioRef.current;
    if (!a) return;
    if (a.src !== track.url) {
      a.src = track.url;
      a.volume = vol;
      a.currentTime = Math.max(0, pos - (track.inPoint ?? 0) + (track.audioOffset ?? 0));
      a.play().catch(() => {});
      setActiveTrackId(track.id);
    }
  }, [Math.floor(pos * 4), playing]);

  // ─── Seek ────────────────────────────────────────────────────────────────
  // seekTo ONLY seeks position — it never switches tracks.
  // Track switching is exclusively selectTrack's job.
  // The old version called trackForTime() which always returned Track 1
  // when no in/out points are set, causing the "always plays Track 1" bug.
  const seekTo = useCallback((t) => {
    const activeT  = tracksRef.current.find(x => x.id === activeTrackIdRef.current);
    const trackDur = activeT?.audioDuration || durRef.current || 300;
    const s = Math.max(0, Math.min(t, trackDur));
    setPos(s);
    posRef.current   = s;
    startRef.current = performance.now();

    const v = videoRef.current;
    if (v) v.currentTime = s;

    // Seek within whichever track is currently active — never switch
    if (activeT && audioRef.current) {
      audioRef.current.volume      = volRef.current;
      audioRef.current.currentTime = Math.max(0, s - (activeT.inPoint ?? 0));
      if (playingRef.current) audioRef.current.play().catch(() => {});
    }
  }, []); // completely stable — all values read from refs

  // ─── Add marker at playhead (M key or button) ────────────────────────────
  const addMarkerAtPlayhead = useCallback(() => {
    if (!activeTrack) return;
    const trackDur  = activeTrack.audioDuration || dur || 1;
    const fraction  = trackDur > 0 ? pos / trackDur : 0;
    const id = uid();
    setMarkers(prev => [...prev, {
      id,
      time:       pos,
      fraction,
      colorId:    newMarkerColor,
      label:      "",
      note:       "",
      trackId:    activeTrack.id,
      trackName:  activeTrack.name,
      trackColor: activeTrack.color,
      fioCommentId: null,
    }]);
    setSelectedMId(id);
    setTab("markers");
  }, [pos, dur, activeTrack, newMarkerColor]);

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const inField = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
      if (e.code === "Space" && !inField) {
        e.preventDefault();
        handlePlay();
      }
      if (e.code === "KeyM" && !inField) {
        e.preventDefault();
        addMarkerAtPlayhead();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePlay, addMarkerAtPlayhead]);

  // ─── Add marker ──────────────────────────────────────────────────────────
  const handleMarkerRow = useCallback((e) => {
    const rect = markerRowRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time     = fraction * (effectiveDur || 0);
    const id       = uid();
    const at       = activeTrack;
    setMarkers(prev => [...prev, {
      id, time, fraction,
      colorId:    newMarkerColor,
      label:      "", note:       "",
      trackId:    at?.id    || null,
      trackName:  at?.name  || null,
      trackColor: at?.color || null,
      fioCommentId: null,
    }]);
    setSelectedMId(id);
    setTab("markers");
  }, [effectiveDur, newMarkerColor, activeTrack]);

  // ─── Track file handling ─────────────────────────────────────────────────
  const handleFiles = useCallback((files) => {
    const valid = Array.from(files).filter(f =>
      f.type.startsWith("audio/") || /\.(mp3|wav|aac|flac|ogg|m4a)$/i.test(f.name)
    );
    if (!valid.length) return;

    // Add tracks immediately with flat placeholder so UI responds instantly
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

    // Audio element setup — outside setTracks to avoid StrictMode double-invoke
    if (isFirstBatch) {
      setActiveTrackId(newTracks[0].id);
      if (audioRef.current) {
        audioRef.current.src    = newTracks[0].url;
        audioRef.current.volume = vol;
      }
    }

    // Decode each file: get real waveform AND duration from the same decode pass
    valid.forEach(async (f, i) => {
      const id = newTracks[i].id;
      const { wave, duration } = await analyseAudio(f);
      setTracks(prev => prev.map(t => t.id === id
        ? { ...t, wave, analysing: false, audioDuration: duration }
        : t
      ));
      // Set global dur as fallback only — effectiveDur derives from active track
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
    // Read current values from refs — always fresh, no stale closure
    const currentActiveId = activeTrackIdRef.current;
    const currentTracks   = tracksRef.current;
    const currentPos      = posRef.current;

    if (id === currentActiveId && overridePos === null) return;

    const newTrack = currentTracks.find(x => x.id === id);
    if (!newTrack) return;

    // Save current position to the outgoing track
    setTracks(prev => prev.map(t =>
      t.id === currentActiveId ? { ...t, savedPos: currentPos } : t
    ));

    const restorePos = overridePos !== null ? overridePos : (newTrack.savedPos ?? 0);

    setActiveTrackId(id);
    setPos(restorePos);
    posRef.current   = restorePos;
    startRef.current = performance.now();

    if (audioRef.current) {
      audioRef.current.src          = newTrack.url;
      audioRef.current.volume       = volRef.current;
      audioRef.current.currentTime  = Math.max(0, restorePos - (newTrack.inPoint ?? 0));
      if (playingRef.current) audioRef.current.play().catch(() => {});
    }
  }, []); // stable — reads all mutable values from refs

  // ─── Waveform click — seek to clicked position, switch track if needed ───
  const handleWaveformClick = useCallback((e, trackId) => {
    const rect     = e.currentTarget.getBoundingClientRect();
    const PAD      = 13;
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left - PAD) / (rect.width - PAD * 2)));

    // Use the CLICKED track's own duration — not the global dur
    const clickedTrack = tracksRef.current.find(t => t.id === trackId);
    const trackDur     = clickedTrack?.audioDuration || durRef.current || 0;
    const newPos       = fraction * trackDur;

    if (trackId !== activeTrackIdRef.current) {
      selectTrack(trackId, newPos);
    } else {
      seekTo(newPos);
    }
  }, [selectTrack, seekTo]); // both stable — no stale closure possible

  // ─── Marker updates ──────────────────────────────────────────────────────
  const updateMarker = (id, f, v) => setMarkers(prev => prev.map(m => m.id === id ? { ...m, [f]: v } : m));
  const removeMarker = (id) => { setMarkers(prev => prev.filter(m => m.id !== id)); setSelectedMId(null); };

  // ─── Frame.io comment sync ───────────────────────────────────────────────
  const syncToFrameio = useCallback(async () => {
    if (!token || !currentAsset?.id) return;
    setSyncing(true); setSyncMsg("");
    try {
      const unsynced = markers.filter(m => !m.fioCommentId);
      for (const m of unsynced) {
        const trackLine = m.trackName ? `🎵 Track: "${m.trackName}"` : "🎵 No track selected";
        const labelLine = m.label ? `\n${m.label}` : "";
        const noteLine  = m.note  ? `\n${m.note}`  : "";
        const text = `${trackLine}${labelLine}${noteLine}\n\n— via Music Layer`;
        const res = await FIO.postComment(token, currentAsset.id, text, Math.round(m.time));
        setMarkers(prev => prev.map(x => x.id === m.id ? { ...x, fioCommentId: res.id } : x));
      }
      setSyncMsg(`${unsynced.length} comment${unsynced.length !== 1 ? "s" : ""} posted to Frame.io`);
    } catch (e) {
      setSyncMsg(`Error: ${e.message}`);
    }
    setSyncing(false);
  }, [token, currentAsset, markers]);

  const loadFromFrameio = useCallback(async () => {
    if (!token || !currentAsset?.id) return;
    setSyncing(true); setSyncMsg("");
    try {
      const comments = await FIO.getComments(token, currentAsset.id);
      const imported = comments
        .filter(c => typeof c.timestamp === "number")
        .map(c => ({
          id: uid(), time: c.timestamp,
          colorId: "blue", label: c.author?.name || "Frame.io",
          note: c.text?.replace(/— via Music Layer$/, "").trim() || "",
          trackId: null, trackName: null, trackColor: null,
          fioCommentId: c.id,
        }));
      setMarkers(prev => {
        const existingFioIds = new Set(prev.map(m => m.fioCommentId).filter(Boolean));
        const newOnes = imported.filter(m => !existingFioIds.has(m.fioCommentId));
        return [...prev, ...newOnes];
      });
      setSyncMsg(`${imported.length} comment${imported.length !== 1 ? "s" : ""} loaded from Frame.io`);
    } catch (e) {
      setSyncMsg(`Error: ${e.message}`);
    }
    setSyncing(false);
  }, [token, currentAsset, markers]);

  // ─── XML export ──────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    if (!markers.length) return;
    const xml = buildXML(markers, projectName, exportFPS);
    const slug = projectName.replace(/\s+/g,"_").replace(/[^a-z0-9_-]/gi,"");
    downloadXML(xml, `${slug}_markers.xml`);
  }, [markers, projectName, exportFPS]);

  // ─── Derived ─────────────────────────────────────────────────────────────
  const pct = effectiveDur ? (pos / effectiveDur) * 100 : 0;

  const pbAnim = useMemo(() => [
    { height:"60%", animation: playing ? "ml3-b0 .28s ease infinite alternate" : "none" },
    { height:"30%", animation: playing ? "ml3-b1 .42s ease infinite alternate" : "none" },
    { height:"80%", animation: playing ? "ml3-b2 .35s ease infinite alternate" : "none" },
    { height:"45%", animation: playing ? "ml3-b3 .5s ease infinite alternate"  : "none" },
  ], [playing]);

  const unsyncedCount = markers.filter(m => !m.fioCommentId).length;

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
              <button className="ml3-btn ml3-btn-ghost" style={{ fontSize:10 }} onClick={() => { setToken(""); setConnStatus("idle"); setConnMsg(""); }}>
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
            {currentAsset && <span className="ml3-status ml3-status-ok" style={{ maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>✓ {currentAsset.name}</span>}
          </div>
        </div>

        {/* ── Body ── */}
        <div className="ml3-body">

          {/* ── Left ── */}
          <div className="ml3-left">

            {/* Video */}
            <div className="ml3-video-wrap">
              {currentAsset?.url ? (
                <video
                  ref={videoRef}
                  controls={false}
                  playsInline
                  style={{ aspectRatio:"16/9" }}
                />
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

              <div className="ml3-tc mono">{fmt(pos, exportFPS)}</div>
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
                Click to seek · Shift+click waveform to add marker · Shift+click marker to remove · Space = play · M = mark
              </div>

              {/* Marker strip — thin row, click to add, flags show here */}
              <div className="ml3-marker-row" ref={markerRowRef} onClick={handleMarkerRow}>
                {markers.map(m => {
                  const c = PREMIERE_COLORS.find(x => x.id === m.colorId) || PREMIERE_COLORS[0];
                  return (
                    <div
                      key={m.id}
                      className="ml3-mflag"
                      style={{ left: `${(m.fraction ?? 0) * 100}%` }}
                      onClick={e => { e.stopPropagation(); setSelectedMId(m.id); setTab("markers"); seekTo(m.time); }}
                    >
                      <div className="ml3-mflag-diamond" style={{ background: c.hex }} />
                      <div className="ml3-mflag-line"    style={{ background: c.hex }} />
                      {(m.label || m.trackName) && (
                        <div className="ml3-mtip">{m.label || m.trackName}</div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Delete confirmation banner */}
              {deleteConfirm && (
                <div className="ml3-delete-confirm">
                  <span className="ml3-dc-text">
                    Remove "{deleteConfirm.label || "marker"}"?
                  </span>
                  <button className="ml3-dc-remove" onClick={() => {
                    removeMarker(deleteConfirm.id);
                    setDeleteConfirm(null);
                  }}>Remove</button>
                  <button className="ml3-dc-cancel" onClick={() => setDeleteConfirm(null)}>
                    Cancel
                  </button>
                  <label className="ml3-dc-suppress">
                    <input
                      type="checkbox"
                      onChange={e => setSuppressDeleteWarning(e.target.checked)}
                    />
                    Don't ask again
                  </label>
                </div>
              )}

              {/* Track waveform rows */}
              {tracks.length === 0 ? (
                <div className="ml3-wrow-empty">Upload tracks in the panel → to see waveforms here</div>
              ) : (
                tracks.map(t => {
                  const isActive = t.id === activeTrackId;
                  const rowH     = isActive ? 68 : 50;
                  const PAD      = 13; // matches padding:0 13px in CSS

                  return (
                    <div
                      key={t.id}
                      className={`ml3-wrow${isActive ? " active" : ""}`}
                      style={{ height: rowH }}
                      onClick={e => {
                        if (e.shiftKey) {
                          const rect     = e.currentTarget.getBoundingClientRect();
                          const fraction = Math.max(0, Math.min(1,
                            (e.clientX - rect.left - PAD) / (rect.width - PAD * 2)
                          ));
                          // Check if clicking near an existing marker (within 1.5%)
                          const SNAP = 0.015;
                          const near = markers.find(m => Math.abs((m.fraction ?? 0) - fraction) < SNAP);
                          if (near) {
                            if (suppressDeleteWarning) {
                              removeMarker(near.id);
                            } else {
                              setDeleteConfirm(near);
                            }
                            return;
                          }
                          // Otherwise add new marker
                          const time = fraction * (t.audioDuration || dur || 0);
                          const id   = uid();
                          setMarkers(prev => [...prev, {
                            id, time, fraction,
                            colorId:    newMarkerColor,
                            label:      "", note:       "",
                            trackId:    t.id,
                            trackName:  t.name,
                            trackColor: t.color,
                            fioCommentId: null,
                          }]);
                          setSelectedMId(id);
                          setTab("markers");
                        } else {
                          handleWaveformClick(e, t.id);
                        }
                      }}
                    >
                      {/* Track label */}
                      <div className="ml3-wrow-label">
                        <div style={{ width:5, height:5, borderRadius:"50%", background:t.color, flexShrink:0 }} />
                        <span className="ml3-wrow-name">{t.name}</span>
                        {t.analysing && <span className="ml3-wrow-analysing">Analysing…</span>}
                      </div>

                      {/* Waveform SVG — only active track shows playback progress */}
                      <WaveformSVG
                        waveform={t.wave}
                        progress={isActive && t.audioDuration ? pos / t.audioDuration : 0}
                        color={t.color}
                        height={rowH}
                        dimmed={!isActive}
                      />

                      {/* Marker lines — only this track's markers, calc() accounts for row padding */}
                      {markers.filter(m => m.trackId === t.id).map(m => {
                        const c = PREMIERE_COLORS.find(x => x.id === m.colorId) || PREMIERE_COLORS[0];
                        const f = m.fraction ?? 0;
                        return (
                          <div
                            key={m.id}
                            className="ml3-wmarker-line"
                            style={{
                              left: `calc(${PAD}px + ${f} * (100% - ${PAD * 2}px))`,
                              background: c.hex,
                            }}
                          />
                        );
                      })}
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
              <button
                className="ml3-mark-btn"
                onClick={addMarkerAtPlayhead}
                disabled={!activeTrack}
                title="Add marker at playhead (M)"
              >
                ◆ Mark
              </button>
              <span className="mono" style={{ fontSize:10, color:"#606078" }}>{fmt(pos,exportFPS)} / {fmt(effectiveDur,exportFPS)}</span>
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
            <div className="ml3-tabs">
              <button className={`ml3-tab${tab==="tracks" ? " on" : ""}`} onClick={() => setTab("tracks")}>
                Tracks{tracks.length ? ` (${tracks.length})` : ""}
              </button>
              <button className={`ml3-tab${tab==="markers" ? " on" : ""}`} onClick={() => setTab("markers")}>
                Markers{markers.length ? ` (${markers.length})` : ""}
              </button>
            </div>

            {/* ── Tracks tab ── */}
            {tab === "tracks" && (
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
                                <div style={{ fontSize:9.5, color:"#606078" }}>{t.size}{t.audioDuration ? ` · ${fmt(t.audioDuration, exportFPS)}` : ""}</div>
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
            )}

            {/* ── Markers tab ── */}
            {tab === "markers" && (
              <div className="ml3-tab-body" style={{ display:"flex", flexDirection:"column" }}>
                {/* New marker colour */}
                <div style={{ padding:"8px 10px", borderBottom:"1px solid #131325" }}>
                  <div style={{ fontSize:9, color:"#606078", textTransform:"uppercase", letterSpacing:".1em", marginBottom:5 }}>New marker colour</div>
                  <div className="ml3-cpick">
                    {PREMIERE_COLORS.map(c => (
                      <div key={c.id} className={`ml3-cdot${newMarkerColor===c.id?" on":""}`}
                        style={{ background:c.hex }} title={c.label}
                        onClick={() => setNewMarkerColor(c.id)} />
                    ))}
                    <span style={{ fontSize:9, color:"#606078", marginLeft:"auto" }}>Click timeline row to place</span>
                  </div>
                </div>

                {/* Marker list */}
                <div style={{ flex:1, padding:"6px 0" }}>
                  {markers.length === 0
                    ? <div className="ml3-empty">No markers yet.<br/>Click the dashed row above the scrubber to add one.</div>
                    : [...markers].sort((a,b) => a.time - b.time).map(m => {
                        const c = PREMIERE_COLORS.find(x => x.id === m.colorId) || PREMIERE_COLORS[0];
                        const isOn = m.id === selectedMId;
                        return (
                          <div key={m.id} className={`ml3-mitem${isOn ? " on" : ""}`}
                            style={{ "--mc": c.hex, "--mc-rgb": c.hex.slice(1).match(/../g)?.map(x=>parseInt(x,16)).join(",") || "0,0,0" }}
                            onClick={() => setSelectedMId(isOn ? null : m.id)}
                          >
                            <div className="ml3-mhead">
                              <div style={{ width:8, height:8, borderRadius:2, background:c.hex, flexShrink:0, transform:"rotate(45deg)" }} />
                              <span className="ml3-seek-btn mono" onClick={e => { e.stopPropagation(); seekTo(m.time); }}>{fmt(m.time, exportFPS)}</span>
                              <input className="ml3-mlabel" placeholder="Label…"
                                value={m.label}
                                onChange={e => updateMarker(m.id, "label", e.target.value)}
                                onClick={e => { e.stopPropagation(); setSelectedMId(m.id); }}
                              />
                              {m.fioCommentId && <span className="ml3-fio-badge">Frame.io</span>}
                              <button className="ml3-rm" style={{ fontSize:13 }} onClick={e => { e.stopPropagation(); removeMarker(m.id); }}>×</button>
                            </div>

                            {/* Track chip — always visible */}
                            {m.trackName && (
                              <div style={{ marginBottom:4 }}>
                                <span className="ml3-track-chip" style={{ background:`${m.trackColor || "#888"}18`, color: m.trackColor || "#888", border:`1px solid ${m.trackColor || "#888"}30` }}>
                                  <span style={{ fontSize:8 }}>♪</span> {m.trackName}
                                </span>
                              </div>
                            )}

                            {isOn && (
                              <>
                                <textarea className="ml3-mnote" rows={2}
                                  placeholder="Note for the editor…"
                                  value={m.note}
                                  onChange={e => updateMarker(m.id, "note", e.target.value)}
                                />
                                <div className="ml3-cpick" style={{ marginTop:5 }}>
                                  {PREMIERE_COLORS.map(x => (
                                    <div key={x.id} className={`ml3-cdot${m.colorId===x.id?" on":""}`}
                                      style={{ background:x.hex }} title={x.label}
                                      onClick={() => updateMarker(m.id, "colorId", x.id)} />
                                  ))}
                                  <span style={{ fontSize:9, color:"#606078", marginLeft:"auto" }}>{c.label}</span>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })
                  }
                </div>

                {/* Frame.io sync + XML export */}
                <div className="ml3-export-zone">
                  {/* Frame.io sync row */}
                  {token && currentAsset && (
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8, paddingBottom:8, borderBottom:"1px solid #131325" }}>
                      <button className="ml3-btn ml3-btn-amber"
                        style={{ fontSize:10, padding:"4px 9px" }}
                        onClick={syncToFrameio}
                        disabled={syncing || unsyncedCount === 0}
                      >
                        {syncing ? "Syncing…" : `↑ Post ${unsyncedCount} to Frame.io`}
                      </button>
                      <button className="ml3-btn ml3-btn-ghost"
                        style={{ fontSize:10, padding:"4px 9px" }}
                        onClick={loadFromFrameio}
                        disabled={syncing}
                      >↓ Load comments</button>
                      {syncMsg && <span style={{ fontSize:9, color:"#10B981" }}>{syncMsg}</span>}
                    </div>
                  )}

                  {/* Export row */}
                  <div style={{ display:"flex", gap:6, marginBottom:6 }}>
                    <input className="ml3-proj-inp" placeholder="Project name…"
                      value={projectName} onChange={e => setProjectName(e.target.value)} />
                    <select className="ml3-fps-sel" value={exportFPS}
                      onChange={e => setExportFPS(Number(e.target.value))}>
                      {FPS_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <button className="ml3-btn ml3-btn-green"
                    style={{ width:"100%", justifyContent:"center", display:"flex" }}
                    onClick={handleExport}
                    disabled={markers.length === 0}
                  >
                    ↓ Export Premiere XML ({markers.length} marker{markers.length !== 1 ? "s" : ""})
                  </button>
                  {markers.length > 0 && (
                    <div style={{ fontSize:9, color:"#606078", marginTop:5, lineHeight:1.6 }}>
                      Each marker includes the track name in the comment field · FCP7 XML · File → Import in Premiere Pro
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}