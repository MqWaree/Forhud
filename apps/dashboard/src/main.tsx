import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import AuthRoot from "./Auth";
import "./styles.css";
import "./enhancements.css";
import "./identity.css";
import "./file-sharing.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthRoot>
        <App />
      </AuthRoot>
    </BrowserRouter>
  </React.StrictMode>,
);
