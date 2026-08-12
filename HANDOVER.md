# Brightworks Music Swapper — Handover

_Last updated: 10 August 2026. Repo: `officialpumpkin/Frame-io-music-swapper`. Current work
is on branch `spotting`, not yet merged — `main` @ `bc661b5` is what production serves._

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
npm test        # proxy allowlist
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

**A stale closure froze the playhead for months.** The `timeupdate` handler was gated on
`playing` captured from the render where the asset loaded — the effect is keyed on the
asset URL, so that value was always `false` and `posRef` never advanced during playback.
The transport clock sat at `00:00:00` through an entire 60-second play-through. It broke
everything downstream that asks where the cut is: clips were placed at 0 instead of at the
playhead, arrow-key seeks started from 0, the scrubber never moved, and the routing pass
keyed on `pos` never fired, so music never re-cued at a clip boundary. Read `playingRef`
inside handlers registered by asset-keyed effects. **`react-hooks/exhaustive-deps` had been
warning about exactly this and it was carried as a known-benign warning — it wasn't.**

**`posRef` is only as fresh as `timeupdate`,** which fires about four times a second.
Anything that has to land on the frame — placing a clip, swapping songs mid-play — reads
`timelineNow()`, which asks the video element directly. Using `posRef` put swaps up to
0.27s out; measured 0.037s after.

**Testing in this environment.** Browser automation runs in a backgrounded tab, so video
never loads metadata, CSS transitions stall mid-interpolation, media requests never
progress, and **`requestAnimationFrame` does not fire at all** — a one-second rAF counter
times out after 45s. Anything driven by rAF (music-only playback, the smooth playhead)
therefore looks frozen for reasons that have nothing to do with the code. Assert on the
mapping instead: set the playhead, read the rendered position, check the arithmetic. None of that indicates a real bug. Rendering the app in an iframe gives working
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

**Swapping songs is the point of the tool, so it is one keystroke.** `1`–`9` put a
different track under the cut. The clip keeps its **position in the cut**, but what plays
inside it comes from the new track's own `srcIn`/`srcOut` — every song has a different
section that suits the same stretch of picture, which is why marks are per track. Carrying
the previous track's `sourceIn` across was a bug: pressing `2` played song two from song
one's in point. A track with no marks keeps the clip's existing length rather than
ballooning to the whole song. It works mid-playback — picture never stops,
and the music element is re-cued immediately rather than waiting for the routing pass.
Clicking another waveform while the cut is rolling swaps rather than auditioning, on the
grounds that you asked to hear the alternative *against the edit*. The swap is guarded on
the clip's own track rather than the active one, so picking a song you happen to be
auditioning still places it. The transport also stops auto-hiding once clips exist — it is
a working surface at that point, and hiding it takes the lane and the chips away
mid-audition.

**Colour is the track identity, not text.** The name used to appear six times — over
the video, inside the clip, in the hint line, on an A/B chip row, in the source header and
in the drawer. It now appears once, in the drawer. A clip, its waveform and its drawer row
share a per-track colour, and that carries the identity instead. The A/B chip row went with
it, so `1`–`9` is only discoverable from the number badges on the drawer rows and the dock
hint — if you add another way to swap songs, keep one of those visible. Transient feedback
("Starts at…", "Marker at…") reuses the dock hint line rather than adding a row.

**Markers are cue points in the cut, and clips snap to them.** `M` drops one at the
playhead and `M` again on top of it removes it; `Shift+M` clears them all. They draw on the
clip lane and on the play bar, so they exist before any music is placed. Dragging a clip
body or either edge snaps to a marker within 7 *pixels* — a pixel tolerance, not a time
one, so it feels the same on a 30-second cut and a five-minute one. This is the point of
markers: lining a hit to a frame stops being a matter of nudging by eye.

**The source monitor shows two playheads.** White is where auditioning is up to; amber is
where the *picture* is, mapped into the song via `sourceIn + (pos - start)`, and it appears
only when the video playhead is over a clip of that track. The other track rows get the
same amber tick, so a clip playing under picture is visible even while auditioning a
different song. Verified: clip at 5s with a 30s in-point, playhead at 20s → 30% of a 150s
track; at 40s → 43.33%.

**Don't put backticks in the CSS.** The whole stylesheet is a JS template literal, so a
backtick in a comment ends the string and the app fails to parse. Cost a confusing
blank-page debug.

**`.bms-mark` is the Brightworks logo.** Marker classes are `.bms-cue` / `.bms-cue-pip`
for exactly this reason — the first attempt collided and restyled the logo to 9px wide.
Check for a class before adding one; the stylesheet is one long string with no scoping.

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

Playback was verified with real media against `https://f.io/xBPEGDdI` (J26022 Carrera,
60.04s), measuring `currentTime` on the media elements at the event rather than after a
tool round-trip — the round-trip alone is ~10s and will otherwise read as an offset:

| | expected | measured |
|---|---|---|
| Click a waveform at 25% of a 115.7s track | 28.93s | 28.974s (video stayed paused at 0) |
| Music enters at a clip starting 9.22s in, in-point 40.0s | 40.24s | 40.236s |
| Sync 13s into that clip | 53.28s | 53.24s |
| Swap songs mid-playback | 58.693s | 58.656s (video never paused) |
| Drag a 110s clip across a 60.04s cut | +9.22s | +9.22s |

## Open items

**Security — the proxy is now an allowlist. Production still isn't.** The token is
account-wide and cannot be narrowed: Frame.io V4 ignores the resource scopes you tick when
minting a developer token (per Frame.io staff, those are V2-legacy only), and scoping by
user would mean provisioning a Frame.io user per job. So containment lives in
`api/frameio/[...path].js`, which forwards GET on two shapes only —
`accounts/<account>/files/<uuid>` and `…/children` — under this deployment's own account.
`/accounts` is answered locally from a cached ID so the listing is never proxied. With no
listing, no search and no enumeration, reaching the proxy grants no more than the link the
client already had. `npm test` asserts each refusal never reaches Frame.io.

The wildcard `Access-Control-Allow-Origin` is gone too; it let any page on the internet
script the proxy through a visitor's browser. Set `ALLOWED_ORIGIN` only if the front end
moves off this origin. `api/expand.js` was a server-side request forgery — it fetched any
URL given to it — and is now allowlisted to Frame.io hosts over https, both on the request
and on the redirect it lands on.

**This is on `spotting`. `main` — which is what production serves — still has the open
proxy**, so until this merges, `https://frame-io-music-swapper.vercel.app` will accept any
V4 path and any method with Brightworks' token.

Still open, and now cheaper to judge: a shared passcode (one env var, entered once in the
UI) would stop casual access by URL, but a client-side secret leaks the moment a client
forwards the link. The allowlist holds regardless, which is why it came first.

**Custom domain** — e.g. `music.brightworks.com.au`, so clients never see Vercel. Andy adds
the DNS record; the Vercel side is quick.

**Unconfirmed: portrait mobile fix.** `bc661b5` addresses the cut-off panels but was only
verified structurally — the symptom can't be reproduced outside a real phone. Needs a
check in portrait that the waveform dock and the sheet's Export button are reachable. If
still clipped, the fallback is driving layout from the `visualViewport` API.

**Unresolved: an export that reports no error and produces no file.** Reported against a
real cut — the button showed "Downloading video…", returned to idle, and nothing landed in
Downloads. Not reproduced yet. Two silent paths have been closed rather than diagnosed:
`setExportErr(e.message)` rendered nothing when the thrown value had no `message` (the chip
is falsy-guarded, so the failure was invisible), and `downloadBlob`'s scripted `a.click()`
is dropped silently by some browsers and most automated ones, which looks identical to
"the export did nothing". The finished file is now also offered as a real `<a download>`
link that persists until the next export. **If this recurs, the first question is whether
the error chip is now showing something** — that distinguishes a thrown failure from a
blocked download.

**Untested against a real render: multi-clip export.** The scheduling is covered by unit
tests (see below) but only a single whole-track export has been rendered through ffmpeg
end-to-end and inspected.

**A bare share link cannot be resolved, and this is Frame.io's gap, not ours.** `f.io`
shortlinks expand to `next.frame.io/share/{shareId}/` with no `/view/` segment, so the only
UUID in the URL is the *share* ID. Asking for it as a file gets `Entity with ID … not
found` — verified identical on the locked-down proxy and on production's unrestricted one,
so it is not a side effect of the allowlist. V4 offers
`/accounts/{id}/shares/{share_id}` for the share entity but has **no endpoint that lists
the files inside a share**; V2's `/review_links/{id}/items/shared` was never replaced.
Paste a link that names the file — open the share, click the video, copy that URL. The
failure currently surfaces in the UI as a bare `404`, which is worth improving.

**Minor:** `README.md` is still the stock Vite template. `npm audit` flags dev-only deps
(vite/babel/postcss). Branch `fix/frameio-proxy-path` is merged but not deleted.

`npm run lint` is clean — 0 errors, 0 warnings. Keep it that way. The playhead bug above
sat in plain sight as an exhaustive-deps warning while the warning count was treated as
background noise.
