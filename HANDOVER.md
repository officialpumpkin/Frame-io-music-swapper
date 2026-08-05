# Brightworks Music Swapper — Handover

_Last updated: 3 August 2026. Repo: `officialpumpkin/Frame-io-music-swapper`, branch `main` @ `bc661b5`._

## What it is

A browser tool for spotting music against a Frame.io cut. Paste a Frame.io link → the
video loads → drop in candidate music tracks → play them against the picture → export an
MP4 with the chosen music mixed under the original audio.

**Live:** https://frame-io-music-swapper.vercel.app (public — see _Security_ below)

## Run it

```bash
npm install
npm run dev      # UI only: /api/* 404s locally, so no Frame.io and no export
npm run build
npm run lint
```

There is no local API. The serverless functions only exist when deployed, so anything
touching Frame.io must be tested on a Vercel deployment. `git push` to `main`
auto-deploys production; pushing any other branch produces a preview URL (preview URLs
are Vercel-login-gated, production is not).

## Layout of the code

| Path | What it does |
|---|---|
| `src/MusicLayerV3.jsx` | The whole app — API layer, playback, waveforms, UI, and the `CSS` template string |
| `src/exportMix.js` | MP4 export: fetch source, render music offline, mux with ffmpeg.wasm |
| `api/frameio/[...path].js` | Proxy → `https://api.frame.io/v4/*`, injects `FRAMEIO_TOKEN` |
| `api/expand.js` | Expands `f.io/xxx` shortlinks (HEAD + follow redirect) |
| `vercel.json` | Rewrite that routes nested `/api/frameio/*` paths to the catch-all |
| `vercel.bkk` | Andy's backup of the original config. Not used. Leave it alone. |
| `public/brand/` | Brightworks logo artwork (black on transparent; inverted in CSS for the dark UI) |

Environment: `FRAMEIO_TOKEN` is set in Vercel. It is not in the repo and is not needed
for `npm run dev`.

## Gotchas — these cost real time, don't rediscover them

**Vercel catch-all params are named after the raw brackets.** For `[...path].js` the value
arrives as `req.query["...path"]` — dots included — *not* `req.query.path`. Reading the
wrong key silently produced a pathless upstream URL. The handler now derives the path
from `req.url` and treats `req.query` as a fallback.

**Nested API paths need the rewrite.** Without `vercel.json`, `/api/frameio/accounts`
worked but `/api/frameio/accounts/<id>/files/<id>` 404'd at the edge before any code ran.
The rewrite's source parameter must be *named* (`:path*`); an unnamed `(.*)` passes
nothing through, which is what broke it originally.

**Frame.io V4 response shapes.** Everything is wrapped in a `data` envelope. `media_links`
entries expose `download_url` / `inline_url`, never `url`. A bare `include=media_links`
returns nothing — name each variant. `efficient` and `high_quality` are **HLS manifests**
that `<video>` can't play outside Safari; `original.inline_url` is a direct MP4 and is
what playback and export both use.

**Vertical (9:16) video.** The stage must have explicit grid tracks
(`minmax(0,1fr)`). With auto tracks the row grows to the video's intrinsic height, so the
video's own `max-height:100%` resolves against the grown row and never binds — a portrait
cut gets cropped instead of pillarboxed. 16:9 hides this bug.

**Mobile viewport units.** `position:fixed; inset:0` and `vh` resolve against the *layout*
viewport (URL bar retracted), so in portrait the bottom of the app hides under browser
chrome. Use `height:100dvh` and anchor bottom-docked panels with `position:absolute`
inside the app box, not `fixed`.

**Testing in this environment.** Browser automation runs in a backgrounded tab, so video
never loads metadata, CSS transitions stall mid-interpolation, and media requests never
progress. None of that indicates a real bug. Rendering the app in an iframe gives working
media queries; iframes cannot reproduce the mobile URL-bar discrepancy because `dvh` and
`vh` are identical there.

## What changed this session

1. **Frame.io integration was completely dead** — four stacked bugs (the two Vercel routing
   issues above, plus the `data` envelope and `media_links` shape). Now working.
2. **Marker UI removed** — the Mark button, Markers tab, marker strip, colour picker,
   Premiere XML export and Frame.io comment sync all deleted (473 lines). Recoverable from
   history at `622a792` if wanted later.
3. **MP4 export added** — video stream-copied (`-c:v copy`, identical resolution/quality),
   music rendered via `OfflineAudioContext` and mixed under the original audio with
   `amix … normalize=0`. Runs in-browser via ffmpeg.wasm because Vercel caps serverless
   responses near 4.5 MB.
4. **Redesigned + rebranded** — video-centric cinema shell, floating auto-hiding transport,
   scrubber, fullscreen (`F`), collapsible waveform dock, tracks drawer that becomes a
   bottom sheet on mobile. Renamed to Brightworks Music Swapper — powered by Frame.io.
5. **Source/record spotting model** — see below.

## How music is placed against picture

Modelled on a source monitor and a record timeline, because the old single-playhead
design meant scrubbing a 3-minute song was silently scrubbing a 30-second cut.

**The dock is the source monitor.** The selected track plays on its own `<audio>` element
with its own playhead (`srcPos`), so auditioning never moves the video. Clicking a waveform
plays that track from the point clicked — a drag scrubs and plays from where you release.
`I` and `O` mark in and out on the song, and the marks are stored per track (`srcIn` /
`srcOut`) so switching tracks and coming back keeps your selection.

There are two transports, and confusing them is the easy mistake: the play button over the
video runs the *timeline*, the dock's "Play track" runs the *song*. The mark handles must
stop `pointerup` propagating, or setting an in point would start playback as a side effect.

**The lane under the play bar is the record timeline.** `Enter`, or "Add to timeline",
places the marked region as a clip at the video playhead. A clip is
`{ trackId, start, sourceIn, duration }` — where it sits in the cut, where in the song it
starts, and how long it runs. Drag the body to slide it, drag an edge to trim, or nudge
with `←` / `→` (one frame, or a second with shift). Trimming the head advances `sourceIn`
by the same amount, so music already lined up against picture stays lined up.

**A clip may be longer than the picture, and usually is.** Marking only an in point leaves
the out at the end of the song, so a 3-minute track against a 30-second cut makes a clip
six times the width of the cut. `start` is therefore clamped to the *cut*
(`0 … videoDur - 0.1`), never to `videoDur - clipDuration` — that older clamp collapsed to
`clamp(start, 0, 0)` and pinned every such clip at zero, unmovable by drag or arrow key.
Overhang is fine; `renderMusicMix` truncates at the end of the video.

**Swapping songs is the point of the tool, so it is one keystroke.** `1`–`9`, or the chips
on the transport, put a different track under the cut: the clip keeps its position, length
and `sourceIn`, and only `trackId` changes. It works mid-playback — picture never stops,
and the music element is re-cued immediately rather than waiting for the routing pass.
Clicking another waveform while the cut is rolling swaps rather than auditioning, on the
grounds that you asked to hear the alternative *against the edit*. The swap is guarded on
the clip's own track rather than the active one, so picking a song you happen to be
auditioning still places it. The transport also stops auto-hiding once clips exist — it is
a working surface at that point, and hiding it takes the lane and the chips away
mid-audition.

**Drag state is computed outside the `setClips` updater.** `pointerup` fires before React
flushes `pointermove`'s update, so reading `clipsRef` in `endClipDrag` reports the
pre-drag position. The drag record carries the computed clip instead. (Writing it from
inside the updater does not work either — same flush timing, and it is not StrictMode
safe.)

**With no clips placed, nothing changed** — the selected track runs from the top, which is
the path that was already working. `renderMusicMix` keeps that as its fallback.

Scheduling is unit-tested: `node scratchpad/schedule.test.mjs` stubs `OfflineAudioContext`
and asserts start time, source offset and duration for each clip, including truncation at
the end of the video and at the end of the song. That test is in the session scratchpad,
not the repo — worth moving in if this grows.

Verified against the real asset (`https://f.io/b0ztdShu` → J26024 Souvenaid, 1920×1080,
30.04s): export produced a valid 1920×1080 / 30.0s / avc1+mp4a file, with the music
measurably present (440 Hz at 0.1604 during, 0.0002 after it ends) and the original audio
still there (RMS 0.0752 after the music stops).

## Open items

**Security — decide before sharing the link.** The proxy authenticates with Brightworks'
own `FRAMEIO_TOKEN` and ignores whatever the client sends, and production is public. An
unauthenticated request to `/api/frameio/accounts` returns real account data — verified.
Anyone with the URL is effectively operating as Brightworks against the Frame.io account
and can pull originals. Options discussed:
- Shared passcode: one env var, checked in the proxy, entered once in the UI. No accounts
  for the client. ~30 min. **This was the leading option.**
- Restrict the proxy to a single Frame.io project.
- Vercel password protection (needs a Pro plan).

**Custom domain** — e.g. `music.brightworks.com.au`, so clients never see Vercel. Andy adds
the DNS record; the Vercel side is quick.

**Unconfirmed: portrait mobile fix.** `bc661b5` addresses the cut-off panels but was only
verified structurally — the symptom can't be reproduced outside a real phone. Needs a
check in portrait that the waveform dock and the sheet's Export button are reachable. If
still clipped, the fallback is driving layout from the `visualViewport` API.

**Untested against a real render: multi-clip export.** The scheduling is covered by unit
tests (see below) but only a single whole-track export has been rendered through ffmpeg
end-to-end and inspected.

**`review_links` is not a V4 endpoint.** V4 replaced review links with shares. Your share
link works because it resolves via the trailing file ID, but a bare `/share/{id}` URL with
no `/view/` segment would fail.

**Minor:** `README.md` is still the stock Vite template. `npm run lint` has one
pre-existing error (`'process' is not defined` in the API file — it's Node, the lint config
just doesn't know). `npm audit` flags dev-only deps (vite/babel/postcss). Branch
`fix/frameio-proxy-path` is merged but not deleted.
