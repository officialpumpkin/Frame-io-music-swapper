// src/main.jsx
import React    from "react";
import ReactDOM from "react-dom/client";
import MusicLayerV3 from "./MusicLayerV3.jsx";
import { installBugLog } from "./bugLog.js";

// Before render, so a failure during startup is already in the buffer by the
// time a tester opens the report sheet.
installBugLog();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MusicLayerV3 />
  </React.StrictMode>
);
