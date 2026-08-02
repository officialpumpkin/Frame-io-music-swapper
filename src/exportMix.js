// Export the Frame.io video with the current music arrangement mixed in.
//
// The video stream is copied, never re-encoded, so the exported file keeps the
// source resolution, frame rate and image quality exactly. Only audio is
// encoded. Everything runs in the browser: Vercel functions cap responses at
// ~4.5 MB, so a ~95 MB render could never be returned from the server side.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

// ─── Source video ─────────────────────────────────────────────────────────────

async function fetchWithProgress(url, onProgress) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Could not reach the video. Its download link may have expired — reload the asset and try again.");
  }
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? "Frame.io rejected the video download — the signed link has expired. Reload the asset and try again."
        : `Could not download the source video (${res.status}).`
    );
  }

  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress?.(received / total);
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Read what the container itself says about the file: whether there is original
// audio to mix under (so an asset without any doesn't fail inside ffmpeg on an
// unmapped [0:a] stream), and the exact duration.
//
// Taking duration from the file rather than the <video> element means an export
// works whether or not the player has finished loading metadata, and guarantees
// the rendered music is exactly as long as the picture.
export function readMp4Info(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxType = (o) => String.fromCharCode(bytes[o], bytes[o+1], bytes[o+2], bytes[o+3]);
  const CONTAINERS = ["moov", "trak", "mdia", "minf", "stbl"];
  const info = { hasAudio: false, durationSec: 0 };

  const walk = (start, end, depth) => {
    let o = start;
    while (o + 8 <= end && depth < 8) {
      let size   = dv.getUint32(o);
      const type = boxType(o + 4);
      let header = 8;
      if (size === 1) {
        if (o + 16 > end) break;
        size = Number(dv.getBigUint64(o + 8));
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header) break;

      const inner = o + header;
      const innerEnd = Math.min(o + size, end);

      // hdlr: 4 bytes version/flags, 4 bytes pre_defined, then handler_type.
      if (type === "hdlr" && inner + 12 <= end && boxType(inner + 8) === "soun") {
        info.hasAudio = true;
      }
      // mvhd: version/flags, then creation/modification, timescale, duration.
      if (type === "mvhd" && inner + 4 <= end) {
        const version = bytes[inner];
        const base = inner + 4 + (version === 1 ? 16 : 8);
        if (version === 1 && base + 12 <= end) {
          const ts = dv.getUint32(base);
          const d  = Number(dv.getBigUint64(base + 4));
          if (ts) info.durationSec = d / ts;
        } else if (base + 8 <= end) {
          const ts = dv.getUint32(base);
          const d  = dv.getUint32(base + 4);
          if (ts) info.durationSec = d / ts;
        }
      }
      if (CONTAINERS.includes(type)) walk(inner, innerEnd, depth + 1);
      o += size;
    }
  };

  walk(0, bytes.length, 0);
  return info;
}

// ─── Music arrangement → PCM ──────────────────────────────────────────────────

// Render the arrangement offline, mirroring how playback routes tracks: when any
// in/out points are set the tracks play across their own spans, otherwise the
// selected track plays from the top.
export async function renderMusicMix({ tracks, activeTrackId, durationSec, volume = 1, sampleRate = 48000 }) {
  const usable = tracks.filter(t => t.url);
  if (!usable.length) throw new Error("Add at least one music track before exporting.");
  if (!durationSec || !isFinite(durationSec) || durationSec <= 0) {
    throw new Error("The video duration isn't known yet — let it load, then export.");
  }

  const hasArrangement = usable.some(t => t.inPoint != null || t.outPoint != null);
  const scheduled = hasArrangement
    ? usable.map(t => ({
        track: t,
        start: Math.max(0, t.inPoint ?? 0),
        end:   Math.min(t.outPoint ?? durationSec, durationSec),
      }))
    : [{
        track: usable.find(t => t.id === activeTrackId) || usable[0],
        start: 0,
        end:   durationSec,
      }];

  const ctx = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);

  for (const s of scheduled) {
    if (s.end <= s.start) continue;
    const bytes = await fetch(s.track.url).then(r => r.arrayBuffer());
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(bytes);
    } catch {
      throw new Error(`Could not decode "${s.track.name}". Try a different audio file.`);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(master);
    const offset = Math.max(0, s.track.audioOffset ?? 0);
    src.start(s.start, offset, s.end - s.start);
  }

  return ctx.startRendering();
}

export function audioBufferToWav(buffer) {
  const channels      = Math.min(2, buffer.numberOfChannels);
  const frames        = buffer.length;
  const blockAlign    = channels * 2;
  const dataSize      = frames * blockAlign;
  const out           = new ArrayBuffer(44 + dataSize);
  const view          = new DataView(out);
  const ascii = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                              // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const clamped = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(out);
}

// ─── Mux ──────────────────────────────────────────────────────────────────────

export function exportFileName(sourceName) {
  const base = String(sourceName || "export").replace(/\.[^.]+$/, "");
  return `${base}_with_music.mp4`;
}

export async function exportWithMusic({
  videoUrl,
  tracks,
  activeTrackId,
  volume = 1,
  durationSec,
  onPhase = () => {},
}) {
  onPhase({ phase: "Downloading video", progress: 0 });
  const videoBytes = await fetchWithProgress(videoUrl, p =>
    onPhase({ phase: "Downloading video", progress: p })
  );

  // The container is the authority on length; the player may not have loaded.
  const info = readMp4Info(videoBytes);
  const length = info.durationSec || durationSec;

  onPhase({ phase: "Rendering music", progress: 0 });
  const mix = await renderMusicMix({ tracks, activeTrackId, durationSec: length, volume });
  const wavBytes = audioBufferToWav(mix);

  onPhase({ phase: "Loading encoder", progress: 0 });
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({ coreURL, wasmURL });

  ffmpeg.on("progress", ({ progress }) => {
    if (progress >= 0 && progress <= 1) onPhase({ phase: "Mixing", progress });
  });

  onPhase({ phase: "Mixing", progress: 0 });
  await ffmpeg.writeFile("source.mp4", videoBytes);
  await ffmpeg.writeFile("music.wav", wavBytes);

  // normalize=0 keeps both inputs at their own level; amix otherwise divides
  // every input's gain by the number of inputs and quietens the original audio.
  const mixArgs = info.hasAudio
    ? [
        "-i", "source.mp4", "-i", "music.wav",
        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[aout]",
        "-map", "0:v:0", "-map", "[aout]",
      ]
    : [
        "-i", "source.mp4", "-i", "music.wav",
        "-map", "0:v:0", "-map", "1:a:0",
      ];

  await ffmpeg.exec([
    ...mixArgs,
    "-c:v", "copy",            // never re-encode the picture
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-shortest",
    "output.mp4",
  ]);

  const data = await ffmpeg.readFile("output.mp4");
  ffmpeg.terminate();

  if (!data || data.length === 0) throw new Error("The mix produced an empty file.");
  onPhase({ phase: "Done", progress: 1 });
  return new Blob([data.buffer ?? data], { type: "video/mp4" });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
