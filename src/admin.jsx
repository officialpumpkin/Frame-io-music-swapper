// src/admin.jsx
import React    from "react";
import ReactDOM from "react-dom/client";
import AdminPage from "./AdminPage.jsx";
import { installBugLog } from "./bugLog.js";

// The builder can fail in the same ways the app can — a folder that will not
// resolve, a proxy refusal — so it gets the same capture.
installBugLog();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AdminPage />
  </React.StrictMode>
);
