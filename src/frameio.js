// src/frameio.js
//
// The Frame.io V4 access layer, shared by the spotting app and the admin page
// that generates its links. It lived inside MusicLayerV3.jsx until the admin
// page needed the same calls; duplicating it would have meant two places to
// get the V4 response shapes wrong.


const API_BASE = "/api/frameio";

export async function apiRequest(token, method, path, body) {
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

// One page of children. The admin page reports when a folder fills it rather
// than silently listing half of one.
export const FOLDER_PAGE_SIZE = 40;

// media_links variants must be named individually — a bare `include=media_links`
// returns nothing. `original` is the only one a <video> element can play
// natively; `efficient` and `high_quality` are both HLS manifests.
const MEDIA_INCLUDE =
  "include=media_links.original,media_links.efficient,media_links.thumbnail";

// These are the only calls the proxy will forward — see api/frameio/[...path].js.
// Adding one here without widening the allowlist there will 404.
export const FIO = {
  accounts:    (t)                              => apiRequest(t, "GET",  "/accounts").then(unwrap),
  // V4: assets → files, account_id required in every path
  asset:       (t, acct, id)                    => apiRequest(t, "GET",  `/accounts/${acct}/files/${id}?${MEDIA_INCLUDE}`).then(unwrap),
  children:    (t, acct, id)                    => apiRequest(t, "GET",  `/accounts/${acct}/files/${id}/children?type=file&page=1&page_size=${FOLDER_PAGE_SIZE}&${MEDIA_INCLUDE}`).then(unwrap),
};

// Parse any Frame.io URL and return { type, id }
export function parseFrameioURL(url) {
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

// f.io shortlinks carry no asset ID, so they have to be expanded before
// anything can be parsed out of them. Shared, because every entry point that
// takes a pasted link needs it — an editor pastes whatever Frame.io's share
// button gave them, and that is usually a shortlink.
export async function expandShortlink(url) {
  let finalUrl = url.trim();
  if (!/f\.io\//i.test(finalUrl)) return finalUrl;
  if (!finalUrl.startsWith("http")) finalUrl = `https://${finalUrl}`;
  const expandRes = await fetch(`/api/expand?url=${encodeURIComponent(finalUrl)}`);
  if (!expandRes.ok) throw new Error("Could not expand shortlink.");
  const expandData = await expandRes.json();
  return expandData.expandedUrl || finalUrl;
}

// Resolve any URL → { type: 'video'|'folder', asset?, assets?, folderName? }
export async function resolveURL(token, accountId, url) {
  const finalUrl = await expandShortlink(url);

  const parsed = parseFrameioURL(finalUrl);
  if (!parsed) throw new Error("Couldn't find a Frame.io asset ID in that URL.");

  if (parsed.type === "review_link") {
    // V4 replaced review links with shares, so the ID in a /reviews/ or
    // /presentations/ URL names no file the API can fetch. This never resolved;
    // say what to paste instead of surfacing an upstream 404.
    throw new Error("That's a review or presentation link. Open it in Frame.io, click the video, and paste the link from that page.");
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
export function videoURL(asset) {
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

// ─── Folder listing for the admin page ────────────────────────────────────────

// Frame.io reports media_type like "video/mp4" or "audio/mpeg", but not always —
// some assets come back with it empty, so the file extension is the fallback.
const AUDIO_EXT = /\.(mp3|wav|aac|flac|ogg|m4a|aif|aiff)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|mxf|avi|mkv|webm)$/i;

export const isFile  = (a) => a?.type === "file" || a?.item_type === "file";
export const isAudio = (a) => isFile(a) && (/audio/i.test(a.media_type || "") || AUDIO_EXT.test(a.name || ""));
export const isVideo = (a) => isFile(a) && (/video/i.test(a.media_type || "") || VIDEO_EXT.test(a.name || ""));

// Everything in one folder, split by kind. The spotting app only ever wanted the
// videos, which is why resolveURL above discards the rest — the admin page needs
// both halves, because the whole point is picking a cut and the music beside it.
export async function listFolder(token, accountId, folderId) {
  const res      = await FIO.children(token, accountId, folderId);
  const children = Array.isArray(res) ? res : (res.data || []);
  return {
    videos: children.filter(isVideo),
    audio:  children.filter(isAudio),
    all:    children,
    // FIO.children asks for one page of 40. A folder bigger than that comes
    // back short, and a builder that quietly ignored half a folder would be
    // worse than one that says so — the editor would send a link missing
    // tracks they thought they had chosen.
    truncated: children.length >= FOLDER_PAGE_SIZE,
  };
}

// Resolve a pasted link to the folder it names, or to the folder containing the
// file it names. An editor may paste either — the folder they are working in, or
// the cut itself — and both should behave the same.
export async function resolveFolder(token, accountId, url) {
  const parsed = parseFrameioURL(await expandShortlink(url));
  if (!parsed) throw new Error("Couldn't find a Frame.io asset ID in that URL.");
  if (parsed.type === "review_link") {
    throw new Error("That's a review or presentation link. Open it in Frame.io, click into the folder, and paste the link from that page.");
  }

  const asset = await FIO.asset(token, accountId, parsed.id);
  if (!isFile(asset)) {
    // A folder or project: list it directly.
    return { id: parsed.id, name: asset.name || "Folder", ...(await listFolder(token, accountId, parsed.id)) };
  }

  // A file. Its parent is what we want, and V4 names it parent_id.
  const parentId = asset.parent_id || asset.parent?.id;
  if (!parentId) {
    // No parent we can read — offer the single file on its own.
    return { id: null, name: asset.name || "", videos: isVideo(asset) ? [asset] : [], audio: isAudio(asset) ? [asset] : [], all: [asset] };
  }
  const parent = await FIO.asset(token, accountId, parentId).catch(() => null);
  return {
    id: parentId,
    name: parent?.name || "Folder",
    ...(await listFolder(token, accountId, parentId)),
  };
}

// Audio assets expose the same media_links shape as video, so the same picker
// serves both. The name is historical — it predates the app loading audio from
// Frame.io at all.
export const mediaURL = videoURL;
