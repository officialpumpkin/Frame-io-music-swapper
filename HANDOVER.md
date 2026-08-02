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

**Untested: multi-track export.** Only a single track with no in/out points has been run
end-to-end. The arrangement path (multiple tracks with in/out points) is implemented and
mirrors the playback routing, but unexercised.

**`review_links` is not a V4 endpoint.** V4 replaced review links with shares. Your share
link works because it resolves via the trailing file ID, but a bare `/share/{id}` URL with
no `/view/` segment would fail.

**Minor:** `README.md` is still the stock Vite template. `npm run lint` has one
pre-existing error (`'process' is not defined` in the API file — it's Node, the lint config
just doesn't know). `npm audit` flags dev-only deps (vite/babel/postcss). Branch
`fix/frameio-proxy-path` is merged but not deleted.
