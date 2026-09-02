import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import AuthRoot from "./Auth";
import "./styles.css";
import "./enhancements.css";
import "./identity.css";
import "./file-sharing.css";
import "./themes/forskin/forskin.css";
import { ForskinThemeProvider } from "./themes/forskin";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ForskinThemeProvider>
      <BrowserRouter>
        <AuthRoot>
          <App />
        </AuthRoot>
      </BrowserRouter>
    </ForskinThemeProvider>
  </React.StrictMode>,
);
