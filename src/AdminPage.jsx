// src/AdminPage.jsx
//
// Where a Brightworks editor builds a spotting session: paste the Frame.io
// folder, pick the cut, tick the music, copy the link.
//
// The link is the whole product of this page. Everything else here exists to
// make sure the editor sees what the recipient will get before they send it —
// the failure this replaces is a link that opens onto the wrong cut, or onto
// music that never made it into the folder.

import { useState, useCallback, useMemo } from "react";
import { FIO, resolveFolder, FOLDER_PAGE_SIZE } from "./frameio.js";
import { sessionURL } from "./session.js";
import { ADMIN_CSS } from "./adminStyles.js";

// The proxy authenticates with its own token and ignores whatever the client
// sends; this keeps the request signature intact. Same sentinel as the app.
const TOKEN = "server-auth";

const sizeOf = (a) => {
  const bytes = Number(a.file_size || a.filesize || 0);
  if (!bytes) return "";
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
};

export default function AdminPage() {
  const [urlInput, setUrlInput] = useState("");
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState("");
  const [folder, setFolder]     = useState(null);   // { id, name, videos, audio }

  const [videoId, setVideoId]   = useState(null);
  const [chosen, setChosen]     = useState([]);     // track ids, in chosen order
  const [copied, setCopied]     = useState(false);

  const link = useMemo(() => {
    if (!videoId) return "";
    try {
      return sessionURL(window.location.origin, {
        folderId: folder?.id || null,
        videoId,
        trackIds: chosen,
      });
    } catch {
      return "";
    }
  }, [folder, videoId, chosen]);

  const load = useCallback(async () => {
    if (!urlInput.trim()) return;
    setLoading(true);
    setErr("");
    setFolder(null);
    setVideoId(null);
    setChosen([]);
    setCopied(false);
    try {
      // V4 requires the account in every path. The proxy answers /accounts from
      // a cached ID without ever forwarding the real listing.
      const accts = await FIO.accounts(TOKEN);
      const list  = Array.isArray(accts) ? accts : (accts.data || []);
      const acct  = list[0]?.id;
      if (!acct) throw new Error("Could not determine the Frame.io account.");

      const found = await resolveFolder(TOKEN, acct, urlInput.trim());
      setFolder(found);
      // The common case is one cut and its music in a folder, so preselect
      // everything. An editor removing two ticks beats an editor wondering why
      // the link they just built has no music in it.
      if (found.videos.length === 1) setVideoId(found.videos[0].id);
      setChosen(found.audio.map(a => a.id));
      if (!found.videos.length) {
        setErr("No video in that folder. Paste the folder holding the cut, or the cut itself.");
      }
    } catch (e) {
      setErr(e.message || String(e));
    }
    setLoading(false);
  }, [urlInput]);

  const toggleTrack = useCallback((id) => {
    setCopied(false);
    // Appended rather than sorted into folder order: the order here becomes the
    // order in the app, which is what 1-9 selects by.
    setChosen(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }, []);

  const copy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The link
      // is on screen and selectable, so say so rather than failing silently.
      setErr("Couldn't reach the clipboard — select the link below and copy it.");
    }
  }, [link]);

  return (
    <>
      <style>{ADMIN_CSS}</style>
      <div className="adm">
        <header className="adm-top">
          <img className="adm-mark" src="/brand/brightworks-b.png" alt="" />
          <img className="adm-wordmark" src="/brand/brightworks-wordmark.png" alt="Brightworks" />
          <span className="adm-rule" />
          <span className="adm-title">Music Swapper · Session builder</span>
          <a className="adm-toapp" href="/">Open the app →</a>
        </header>

        <main className="adm-main">
          <section className="adm-card">
            <div className="adm-step">Step 1 — the Frame.io folder</div>
            <p className="adm-lede">
              Put the cut and the candidate tracks in one Frame.io folder, then paste a
              link to that folder. A link to the cut itself works too — its folder is
              read instead.
            </p>
            <div className="adm-row">
              <input
                className="adm-input"
                placeholder="https://f.io/… or a Frame.io folder link"
                value={urlInput}
                autoFocus
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && load()}
              />
              <button className="adm-btn adm-btn-amber" onClick={load} disabled={loading || !urlInput.trim()}>
                {loading ? "Reading…" : "Read folder"}
              </button>
            </div>
            {err && <div className="adm-err">{err}</div>}
          </section>

          {folder && (
            <>
              <section className="adm-card">
                <div className="adm-step">Step 2 — the cut</div>
                {folder.videos.length === 0 ? (
                  <div className="adm-empty">No video files in {folder.name}.</div>
                ) : (
                  <div className="adm-list">
                    {folder.videos.map(v => (
                      <label key={v.id} className={`adm-item${videoId === v.id ? " on" : ""}`}>
                        <input
                          type="radio" name="cut" checked={videoId === v.id}
                          onChange={() => { setVideoId(v.id); setCopied(false); }}
                        />
                        <span className="adm-item-name">{v.name}</span>
                        <span className="adm-item-meta">{sizeOf(v)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </section>

              <section className="adm-card">
                <div className="adm-step">
                  Step 3 — the music
                  <span className="adm-count">{chosen.length} of {folder.audio.length} chosen</span>
                </div>
                {folder.truncated && (
                  <div className="adm-err">
                    That folder filled a page, so this list may be incomplete — Frame.io was
                    asked for the first {FOLDER_PAGE_SIZE} items. If a track you expected
                    is missing, put the session in a folder of its own.
                  </div>
                )}
                {folder.audio.length === 0 ? (
                  <div className="adm-empty">
                    No audio in {folder.name}. You can still send the link — whoever opens
                    it can drop their own tracks in.
                  </div>
                ) : (
                  <div className="adm-list">
                    {folder.audio.map(a => {
                      const at = chosen.indexOf(a.id);
                      return (
                        <label key={a.id} className={`adm-item${at !== -1 ? " on" : ""}`}>
                          <input type="checkbox" checked={at !== -1} onChange={() => toggleTrack(a.id)} />
                          {/* The number is the keyboard shortcut it will answer
                              to in the app, which is why order is preserved. */}
                          <span className="adm-key mono">{at !== -1 && at < 9 ? at + 1 : ""}</span>
                          <span className="adm-item-name">{a.name}</span>
                          <span className="adm-item-meta">{sizeOf(a)}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="adm-card adm-out">
                <div className="adm-step">Step 4 — the link</div>
                {link ? (
                  <>
                    <div className="adm-link mono">{link}</div>
                    <div className="adm-row">
                      <button className="adm-btn adm-btn-green" onClick={copy}>
                        {copied ? "Copied" : "Copy link"}
                      </button>
                      <a className="adm-btn adm-btn-ghost" href={link} target="_blank" rel="noreferrer">
                        Open it yourself
                      </a>
                    </div>
                    <p className="adm-note">
                      It loads on its own — no pasting, no Load button. Everything the
                      session needs is in the link, so there is nothing stored here and
                      nothing to expire. Whoever opens it can still add their own music
                      on top of what you chose.
                    </p>
                  </>
                ) : (
                  <div className="adm-empty">Pick the cut above and the link appears here.</div>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </>
  );
}

