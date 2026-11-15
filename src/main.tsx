import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { chatsReady } from "./store/chatStorage";
import "./store/chats";
import { ApprovalPopup } from "./components/ApprovalPopup";
import { QuickPanel } from "./components/QuickPanel";
import { Notch } from "./components/Notch";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/app.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
const helper = { approve: <ApprovalPopup />, panel: <QuickPanel />, notch: <Notch /> }[getCurrentWindow().label];
const render = (view: React.ReactNode) => root.render(<React.StrictMode>{view}</React.StrictMode>);

if (helper) {
  render(helper);
} else {
  // The main window starts only once the chat list has loaded, so nothing (terminal sessions,
  // memory pruning, the notch) ever runs against an empty list by mistake. If loading somehow
  // never answers, E.V still opens after 10 s, with saving kept off (see chatStorage.ts).
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    render(<App />);
  };
  void chatsReady.then(show);
  setTimeout(show, 10_000);
}
