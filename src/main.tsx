import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ApprovalPopup } from "./components/ApprovalPopup";
import { QuickPanel } from "./components/QuickPanel";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {getCurrentWindow().label === "approve" ? <ApprovalPopup /> : getCurrentWindow().label === "panel" ? <QuickPanel /> : <App />}
  </React.StrictMode>,
);
