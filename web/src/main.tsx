import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerSw } from "./push";
import { initTheme } from "./theme";
import "@fontsource-variable/onest";
import "./styles.css";

initTheme();
void registerSw();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
