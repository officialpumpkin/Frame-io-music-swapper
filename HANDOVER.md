# Brightworks Music Swapper — Handover

_Last updated: 18 August 2026. Repo: `officialpumpkin/Frame-io-music-swapper`, branch
`main` @ `630eb99` — merged and serving production. `spotting` is merged and can be deleted._

**Start here:** everything below is written down. What is *not* yet known is in
_Needs testing_ at the end — one of those is blocking.

## What it is

A browser tool for spotting music against a Frame.io cut. Paste a Frame.io link → the
video loads → drop in candidate music tracks → play them against the picture → export an
MP4 with the chosen music mixed under the original audio.

**Live:** https://frame-io-music-swapper.vercel.app (public — see _Security_ below)
**Session builder:** https://frame-io-music-swapper.vercel.app/admin

## Run it

```bash
npm install
npm run dev      # UI only: /api/* 404s locally, so no Frame.io and no export
                 # App at /, session builder at /admin.html
npm run build
npm run lint
npm test        # proxy allowlist, bug-report endpoint, session codec
```

There is no local API. The serverless functions only exist when deployed, so anything
touching Frame.io must be tested on a Vercel deployment. `git push` to `main`
auto-deploys production; pushing any other branch produces a preview URL (preview URLs
are Vercel-login-gated, production is not).

## Layout of the code

| Path | What it does |
|---|---|
| `src/MusicLayerV3.jsx` | The spotting app — playback, waveforms, UI, and the `CSS` template string |
| `src/frameio.js` | Frame.io V4 access layer, shared by the app and the admin page |
| `src/session.js` | Encodes/decodes the session a generated link carries |
| `src/AdminPage.jsx` · `src/adminStyles.js` | The session builder at `/admin` |
| `index.html` · `admin.html` | The two page entries; see `vite.config.js` |
| `src/exportMix.js` | MP4 export: fetch source, render music offline, mux with ffmpeg.wasm |
| `api/frameio/[...path].js` | Proxy → `https://api.frame.io/v4/*`, injects `FRAMEIO_TOKEN` |
| `api/expand.js` | Expands `f.io/xxx` shortlinks (HEAD + follow redirect) |
| `api/bug.js` | Takes a report from the app's bug sheet and opens a GitHub issue |
| `src/bugLog.js` | Rolling capture of console errors, uncaught throws and app breadcrumbs |
| `vercel.json` | Rewrites: nested `/api/frameio/*` to the catch-all, and `/admin` to `admin.html` |
| `vercel.bkk` | Andy's backup of the original config. Not used. Leave it alone. |
| `public/brand/` | Brightworks logo artwork (black on transparent; inverted in CSS for the dark UI) |

Environment: `FRAMEIO_TOKEN` is set in Vercel. It is not in the repo and is not needed
for `npm run dev`. `BUG_GITHUB_TOKEN` is needed for bug reporting only — see below.

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

**On an iPhone the video has its own transport, and the app has to listen to it.**
`Element.requestFullscreen` does not exist on iPhone, so `toggleFullscreen` falls back to
`videoRef.current.webkitEnterFullscreen()` — Apple's native player, with its own scrub
bar and play button. The app's clock used to follow the video *only when the app was the
one moving it*: `timeupdate` returned early unless `playingRef.current` was true, and the
rAF loop only ran during playback. So every seek made in the native player was invisible,
`pos` went stale, and everything derived from it froze — the scrubber, the clip lane head,
and the amber picture-playhead on the waveform. It reads exactly like a rendering bug and
is not one. `timeupdate` is now ungated, `seeked` re-cues the music through `cueMusicTo`,
and `play` / `pause` on the element drive the app's `playing` state. **Anything that reads
the video's clock must assume something other than the app moved it.**

**Testing in this environment.** Browser automation runs in a backgrounded tab, so video
never loads metadata, CSS transitions stall mid-interpolation, media requests never
progress, and **`requestAnimationFrame` does not fire at all** — a one-second rAF counter
times out after 45s. Anything driven by rAF (music-only playback, the smooth playhead)
therefore looks frozen for reasons that have nothing to do with the code. Assert on the
mapping instead: set the playhead, read the rendered position, check the arithmetic. None of that indicates a real bug. Rendering the app in an iframe gives working
media queries; iframes cannot reproduce the mobile URL-bar discrepancy because `dvh` and
`vh` are identical there.

## Keyboard

The transport carries no song chips, so these are the only way to do several of these
things. The dock header line lists the main ones.

| Key | Does |
|---|---|
| `Space` | Play / pause the cut |
| `1`–`9` | Put that track under the picture (works mid-playback) |
| `I` / `O` | Mark in / out on the song in the source monitor |
| `Enter` | Place the marked region as a clip at the playhead |
| `M` | Drop a marker at the playhead; `M` again on it removes it |
| `Shift+M` | Clear all markers |
| `←` `→` | Nudge the selected clip a frame, or the playhead if none; `Shift` = one second |
| `Delete` | Remove the selected clip |
| `A` | Play / stop the source monitor |
| `F` | Fullscreen |

## How it got here

Earlier work, in rough order: Frame.io V4 integration (four stacked bugs — the two Vercel
routing issues above, plus the `data` envelope and `media_links` shape); the old marker UI
removed (Mark button, Markers tab, colour picker, Premiere XML export, Frame.io comment
sync — 473 lines, recoverable at `622a792`); in-browser MP4 export; the video-centric
redesign and rebrand; then the source/record spotting model below.

Most recently: the proxy allowlist (see _Security_), the source/record model, per-track
in/out, cue markers with snapping, and a strip-back of on-screen text so the page is about
the video.

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

## Generated sessions, and the admin page

An editor should not be walking a client through pasting a Frame.io link. `/admin` is a
session builder: paste the Frame.io folder holding the cut and its candidate tracks, pick
the cut, tick the music, copy the link. Whoever opens that link gets the cut loaded and
the tracks already in the drawer, with no Load press.

**Everything is in the link, and nothing is stored.** `src/session.js` encodes
`{folder, video, tracks}` as base64url in the URL *fragment*. No datastore to provision,
nothing to expire, nothing to prune, and it keeps the model the proxy already set: the
link is the credential and names only assets that were already behind the allowlist. A
fragment never reaches the server, so the IDs stay out of request logs. The cost is a long
URL — the right way round for sessions made constantly and kept briefly.

**The folder ID in the link is an optimisation, not decoration.** With it the app lists
the folder once and picks the chosen IDs out of the result, so a five-track session costs
one request instead of six.

**Track order in the link is the order in the app, and `1`–`9` selects by position.** The
admin page appends on tick rather than sorting into folder order, so what the editor ticks
first is what `1` plays. Re-sorting anywhere in that chain would silently remap every
shortcut.

**Frame.io tracks are fetched to a blob and played from an object URL.** Signed links
expire, and a session left open over a lunch break would otherwise lose its music halfway
through. It also costs nothing: `analyseAudio` already accepts anything with
`.arrayBuffer()`, so the waveform, playback and export all read the same local copy.

**Local drag-and-drop still works and must keep working.** A generated session is a
starting point, not a lock — whoever opens the link can drop their own music in beside
what the editor chose. Both paths build the same track objects.

`decodeSession` returns `null` for anything unreadable rather than throwing. A mail client
wrapping a long URL is the expected failure, not a rare one, and it should leave the
ordinary paste box on screen rather than a blank page. `npm test` covers the round trip,
the three shapes that get pasted, junk IDs, and truncation.

**The folder listing asks for one page of 40** (`FOLDER_PAGE_SIZE`). A folder that fills
it says so on the admin page — a builder that quietly listed half a folder would send
links missing tracks the editor thought they had chosen.

The admin page is not access-controlled, and deliberately: it can only build links to
assets in Brightworks' own Frame.io account, which the allowlist already governs, so
reaching it grants nothing the paste box on the main page did not already grant. If that
changes — if it ever writes anything — it needs a gate.

## Levels

**Two stages, and they answer different questions.** The transport's speaker button opens
a popover holding the *master* music level — everything at once, against picture. Each
track then carries its own trim (`track.gain`, 0–1, default 1) on its row in the tracks
drawer. What an element actually plays at is `levelFor()`: master × that track's trim.

The per-track stage exists because candidates are never mastered to the same loudness, and
the entire point of the tool is judging them against the same picture. Without it, "which
of these works better" is partly a question about which was mastered louder. It is per
track for the same reason in and out marks are.

`renderMusicMix` applies the trim as a gain node per source, feeding the master gain. **A
level that is only applied on playback is a bug** — the export would quietly ignore the
balance the arrangement was built with.

Every place that assigns `.volume` goes through `levelFor` — there are eleven of them, and
one missed site means a track jumps back to full whenever that path re-cues. The
volume-sync effect depends on `tracks`, so dragging a trim is audible while the slider is
moving rather than at the next cue boundary.

**The master slider used to be inline in the transport, and on a phone it did not exist.**
`@media (max-width:560px)` set `.bms-vol input[type=range] { display:none }`, and the
speaker beside it was a decorative `<svg>` — not a button. So the row rendered, looked like
a control, and had nothing pressable on it. It is a popover now, which also gives the
slider a 26px touch target instead of the default ~16. **If you ever add a rule matching
`.bms-vol input[type=range]`, remember it now matches the popover's slider too** — that is
the same rule that caused the original bug.

## How testers report bugs

There is a bug icon in the top bar next to the tracks button. It opens a sheet asking
for one line of summary, what they were doing, what happened instead, and optionally
their name (remembered in `localStorage`, so it is typed once). Sending POSTs to
`/api/bug`, which opens a GitHub issue on this repo labelled `bug`.

**The report carries the state, which is the whole point.** A tester describing a
failure from memory an hour later is the situation this replaces. Attached
automatically: the asset and its ID, video dimensions and duration, the playhead and
whether it was rolling, volume, every track with its marks and whether it was still
analysing, every clip with its `start` / `sourceIn` / `duration`, marker positions,
export state and error, viewport size, DPR and orientation, and the user agent. Each of
those has been the answer to "what was it doing?" for a bug already in this document.

**`src/bugLog.js` captures what the console saw**, and it is imported by `main.jsx`
before render deliberately — a failure while ffmpeg or the video is loading happens long
before anyone thinks to open the sheet, and those are the ones worth having. It patches
`console.error` / `console.warn` (calling through, never swallowing) and listens for
`error` and `unhandledrejection`, since a rejected promise reaches `console.error` in no
browser. The buffer is a bounded ring — 80 entries, 400 chars each — so a page left open
all afternoon cannot grow it without limit.

`note()` leaves deliberate breadcrumbs, and `handleExport` is instrumented with them:
started, each phase transition, blob size, download fired, or the thrown message. **This
is aimed squarely at the export that fails silently** — the breadcrumbs say whether it
died fetching, rendering, muxing, or after the blob already existed. Phase transitions
are logged, not every progress tick, or one export fills the buffer and pushes out the
errors that came before it.

Everything sent is shown to the tester first, behind "What gets sent with this" — the
report carries their music file names and the captured console, and they are entitled to
read that before it leaves the machine.

**Setting it up.** `api/bug.js` needs `BUG_GITHUB_TOKEN` in Vercel: a fine-grained
personal access token scoped to *this repository only*, with **Issues: Read and write**
and nothing else. `BUG_GITHUB_REPO` defaults to `officialpumpkin/Frame-io-music-swapper`
and only needs setting if that changes. Without the token the endpoint answers `503` and
the sheet tells the tester reporting is not switched on, rather than showing them a
failure they cannot act on.

**It is unauthenticated, and that is a deliberate trade.** Testers are people we handed a
link to; making them hold a credential defeats the purpose. So the containment is POST
only, JSON only, a 64 KB body cap and per-field caps, same-origin required whenever the
browser declares an origin, and a per-instance rate limit — that last one bounds one warm
serverless instance rather than the endpoint as a whole, and is documented as such in the
file. None of it is authentication. The worst case is someone spamming issues on one repo,
and the fix is to revoke `BUG_GITHUB_TOKEN`, which disables this endpoint and nothing
else. That is exactly why the token is scoped to issues on one repo rather than reusing
anything broader.

Reporter text always goes into the issue inside a fence, and the fence is grown longer
than the longest backtick run in the content — otherwise a report containing ``` closes
the block early and restructures the issue around itself. That also keeps an `@mention`
from notifying a real person. Titles are collapsed to a single line so a newline-stuffed
summary cannot forge issue structure. `npm test` asserts all of this, plus that nothing
reaches GitHub on any refusal path.

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

**Merged and live.** Verified server-side against production, where CORS offers no
protection: `/projects`, `/workspaces`, `/me`, `/comments` → 404 and never forwarded;
`DELETE`/`POST` → 405; another account's ID → 403; the SSRF probe → 400; `/accounts` → the
ID alone. Before the merge, an unauthenticated `/api/frameio/accounts` returned real
account data.

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

## Needs testing

Nothing here is known-broken except the first item. Everything else is code that behaves
correctly under measurement but has never been watched working by a human.

Test link: `https://f.io/a-tEaQ7K` (J26022 Carrera, 1920×1080, 60.04s). It resolves because
it carries a `/view/` segment — see the share-link note above.

**1. Export — blocking, and the reason to start here.** Load the cut, place a clip, export.
Three possible outcomes and they mean different things:
- A green download link appears → it worked; the earlier report was the harness swallowing
  a programmatic download.
- A red error chip appears → that text is the root cause. It could not appear before.
- Neither, the button just returns to idle → something fails before any error path.

That third case is no longer a dead end: `handleExport` now leaves breadcrumbs through
every phase, so open the bug sheet, expand "What gets sent with this", and read the
captured log. The last `export:` line reached says where it stopped. **File it with the
button** — that is what the button is for, and it beats describing it afterwards.

**2. Levels, master and per track.** The old inline slider is gone — see _Levels_. On a
phone it was genuinely dead, not mis-tested: hidden by a media query next to an icon that
was not a button. Check the speaker opens the popover and the fader moves both `<audio>`
elements; then set one track to ~40% and another to 100% and swap between them under the
same picture. **Then export and confirm the trim survived the render** — that path has no
unit test, because `exportMix.js` imports Vite-only `?url` specifiers and cannot be loaded
in Node. Extracting `renderMusicMix` into its own module would fix that and is worth doing
once the export bug is settled.

**3. Out-trim handle.** The delete button used to cover 7 of the out handle's 9 pixels.
Drag the right edge of a clip from its vertical midpoint, desktop and phone.

**4. The amber picture-playhead, animating.** Its position is verified arithmetically (clip
at 5s, in-point 30s, playhead 20s → 30% of a 150s track; at 40s → 43.33%) but never watched
moving — `requestAnimationFrame` does not fire in this environment at all. Play a cut with
a clip placed and check it tracks smoothly rather than stepping.

**Reported frozen on a phone, and fixed** — see the iPhone note in _Gotchas_. Re-test by
navigating from the native fullscreen player: the indicator must follow the native scrub
bar, and the music must land in the right place when playback resumes rather than
continuing from where it was.

**5. Markers and snapping against a real cut.** `M` on a hit, then drag a clip near it.
Snapping is verified synthetically (aimed 40.35s → landed 40.00; aimed 70s → no snap).

**6. Per-track in/out on a swap, by ear.** Mark a different section on each of three songs,
place one, then press `1`/`2`/`3`. Each should enter at its own in point. Verified by
number, not by listening.

**7. Multi-clip export through ffmpeg.** Scheduling is unit-tested; only a single
whole-track export has been rendered and inspected.

**8. Portrait on a real phone.** See the note above — the waveform dock and the sheet's
Export button must be reachable. The bug sheet is a bottom sheet at this width for the
same reason and wants the same check: the Send button must clear the keyboard.

**10. The admin page and a generated link, end to end.** Nothing here has been run against
real Frame.io. The unknowns worth watching, in order of how likely they are to bite:

- **Does Frame.io serve audio the same way it serves video?** `mediaURL` reads
  `media_links.original.inline_url`, which is right for video. If audio assets do not
  expose it, tracks arrive named "(unavailable)" and the fix is in `videoURL`.
- **Does fetching an audio file cross-origin work?** Export already fetches the video this
  way, so it should — but if the tracks fail while the cut loads fine, that is the cause,
  and the bug sheet's captured log will name it.
- **Does `parent_id` come back on a file?** It is what makes pasting a link to the *cut*
  find its folder. Without it that path degrades to the single file and no music, which is
  handled but not what the editor expected.
- **Are audio files matched at all?** `isAudio` tests `media_type` and falls back to the
  extension, so an unusual container could be missed.

Check too that the numbers beside the ticked tracks match what `1`–`9` play in the app,
and that a client can still drop their own music in on top of a generated session.

**9. The bug button itself, end to end.** Untested against a deployment — it is lint-clean,
builds, and its endpoint is unit-tested against a stubbed GitHub, but no real issue has
been filed yet. Needs `BUG_GITHUB_TOKEN` set in Vercel first (see _How testers report
bugs_). Send one report and check the issue arrives with the diagnostics block intact.
Until the token is set the sheet will say reporting is not switched on, which is the
expected answer and not a bug.

Also worth re-running the outside review: the last one was against a build with the A/B
chip row and the old swap behaviour, both since changed.
