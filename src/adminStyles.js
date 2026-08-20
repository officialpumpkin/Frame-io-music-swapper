// src/adminStyles.js
//
// The admin page's stylesheet, kept in its own module so it is not a third
// concern inside AdminPage.jsx.
//
// Same trap as the app's CSS: this is a template literal, so a backtick
// anywhere in it — including in a comment — ends the string and the page fails
// to parse as a blank screen. Do not put one here.

export const ADMIN_CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=swap');

.adm {
  --bg:#08080D; --surface:#11111A; --surface-2:#181822; --line:#20202D;
  --text:#E8E8F2; --muted:#7A7A94; --dim:#4E4E64;
  --accent:#F59E0B; --green:#10B981; --red:#EF4444;

  min-height:100dvh; background:var(--bg); color:var(--text);
  font-family:'Inter',system-ui,-apple-system,sans-serif; font-size:13px;
  -webkit-tap-highlight-color:transparent;
}
.adm *, .adm *::before, .adm *::after { box-sizing:border-box; margin:0; padding:0; }
.adm button, .adm input { font-family:inherit; }
.adm .mono { font-family:'IBM Plex Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }

.adm-top {
  display:flex; align-items:center; gap:9px; height:54px;
  padding:0 max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left));
  background:var(--surface); border-bottom:1px solid var(--line);
  position:sticky; top:0; z-index:10;
}
/* Brand artwork ships black-on-transparent, so it is inverted for the dark UI. */
.adm-mark { width:21px; height:21px; filter:invert(1); opacity:.94; }
.adm-wordmark { height:10px; width:auto; filter:invert(1); opacity:.94; }
.adm-rule { width:1px; height:15px; background:var(--line); }
.adm-title {
  font-size:10.5px; font-weight:600; letter-spacing:.13em; text-transform:uppercase;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.adm-toapp { margin-left:auto; font-size:11px; color:var(--muted); text-decoration:none; white-space:nowrap; }
.adm-toapp:hover { color:var(--accent); }

.adm-main {
  max-width:720px; margin:0 auto; padding:20px 16px 60px;
  display:flex; flex-direction:column; gap:14px;
}

.adm-card {
  background:var(--surface); border:1px solid var(--line); border-radius:13px; padding:16px;
}
.adm-step {
  font-size:9.5px; font-weight:600; letter-spacing:.13em; text-transform:uppercase;
  color:var(--muted); display:flex; align-items:baseline; gap:10px; margin-bottom:10px;
}
.adm-count { margin-left:auto; font-size:9.5px; color:var(--dim); letter-spacing:.04em; text-transform:none; }
.adm-lede { font-size:11.5px; color:var(--dim); line-height:1.7; margin-bottom:12px; }

.adm-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.adm-input {
  flex:1; min-width:200px; background:var(--surface-2); border:1px solid var(--line);
  color:var(--text); border-radius:8px; padding:10px 12px; font-size:12px; outline:none;
  font-family:'IBM Plex Mono',monospace;
}
.adm-input::placeholder { color:var(--dim); }
.adm-input:focus { border-color:#F59E0B77; }

.adm-btn {
  border-radius:8px; padding:10px 15px; font-size:12px; font-weight:500; cursor:pointer;
  border:1px solid transparent; white-space:nowrap; text-decoration:none; display:inline-block;
  transition:background .12s, border-color .12s;
}
.adm-btn:disabled { opacity:.38; cursor:default; }
.adm-btn-amber { background:#F59E0B1A; border-color:#F59E0B55; color:var(--accent); }
.adm-btn-amber:hover:not(:disabled) { background:#F59E0B2E; }
.adm-btn-green { background:#10B9811A; border-color:#10B98155; color:var(--green); }
.adm-btn-green:hover:not(:disabled) { background:#10B9812E; }
.adm-btn-ghost { background:transparent; border-color:var(--line); color:var(--muted); }
.adm-btn-ghost:hover { color:var(--text); border-color:#33334A; }

.adm-err {
  margin-top:11px; padding:9px 11px; border-radius:8px; font-size:11px; line-height:1.6;
  background:#EF444418; border:1px solid #EF444440; color:#FCA5A5;
}
.adm-empty { font-size:11.5px; color:var(--dim); line-height:1.7; padding:4px 0; }

.adm-list { display:flex; flex-direction:column; gap:5px; }
.adm-item {
  display:flex; align-items:center; gap:10px; padding:10px 11px; cursor:pointer;
  border:1px solid var(--line); border-radius:9px; background:var(--surface-2);
  transition:border-color .12s, background .12s;
}
.adm-item:hover { border-color:#33334A; }
.adm-item.on { border-color:#F59E0B55; background:#F59E0B0F; }
/* Big enough to hit with a thumb; editors do this on laptops but not only. */
.adm-item input { width:16px; height:16px; accent-color:var(--accent); cursor:pointer; flex-shrink:0; }
.adm-key {
  width:16px; font-size:9.5px; color:var(--accent); text-align:center; flex-shrink:0;
}
.adm-item-name {
  flex:1; min-width:0; font-size:12px; color:#BFBFD6;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.adm-item.on .adm-item-name { color:var(--text); }
.adm-item-meta { font-size:9.5px; color:var(--dim); flex-shrink:0; }

.adm-out { border-color:#10B98133; }
.adm-link {
  background:var(--bg); border:1px solid var(--line); border-radius:9px;
  padding:11px; font-size:10.5px; line-height:1.6; color:#9A9AB8;
  word-break:break-all; margin-bottom:11px; user-select:all;
}
.adm-note { font-size:10px; color:var(--dim); line-height:1.75; margin-top:11px; }

.adm ::-webkit-scrollbar { width:4px; height:4px; }
.adm ::-webkit-scrollbar-thumb { background:#26263A; border-radius:2px; }

@media (max-width:560px) {
  .adm-wordmark, .adm-rule { display:none; }
  .adm-main { padding:14px 12px 50px; }
  .adm-card { padding:14px; }
  .adm-btn { flex:1; text-align:center; }
}
`;
