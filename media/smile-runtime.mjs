import electron from "electron";

const app = globalThis.smile_visual_plugin || {};

function applyWindow(window) {
  if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed())) {
    return;
  }
  if (!window.__smileBgLocked) {
    window.__smileBgLocked = true;
    const original = window.setBackgroundColor.bind(window);
    window.setBackgroundColor = () => original("#00000000");
  }
  try {
    window.setBackgroundColor("#00000000");
  } catch {
    // ignore
  }
  try {
    if (typeof window.setBackgroundMaterial === "function") {
      window.setBackgroundMaterial(app.material || "acrylic");
    }
  } catch {
    // ignore
  }
  try {
    if (process.platform === "darwin" && typeof window.setVibrancy === "function") {
      window.setVibrancy("under-window");
    }
  } catch {
    // ignore
  }

  window.webContents.on("dom-ready", () => {
    const currentURL = window.webContents.getURL();
    const isAuxiliary = currentURL === "about:blank" || currentURL === "";
    if (
      !(
        isAuxiliary ||
        currentURL.includes("workbench.html") ||
        currentURL.includes("workbench.esm.html")
      )
    ) {
      return;
    }
    try {
      window.setBackgroundColor("#00000000");
    } catch {
      // ignore
    }
    injectHTML(window);
  });
}

function injectHTML(window) {
  const css = typeof app.css === "string" ? app.css : "";
  window.webContents.executeJavaScript(`(function(){
    try {
      let policy = { createHTML: function(v){ return v; } };
      try {
        if (window.trustedTypes) {
          policy = window.trustedTypes.createPolicy("SmileVisual", { createHTML: function(v){ return v; } });
        }
      } catch (e) {}
      const createElement = function(tag) {
        return Document.prototype.createElement.call(document, tag);
      };
      document.getElementById("smile-visual-style-host")?.remove();
      const host = createElement("div");
      host.id = "smile-visual-style-host";
      host.innerHTML = policy.createHTML(${JSON.stringify(`<style id="smile-visual-style">${css}</style>`)});
      (document.body || document.documentElement).appendChild(host);
    } catch (err) {
      console.error("smile visual inject", err);
    }
  })();`);
}

electron.app.on("browser-window-created", (_, window) => {
  applyWindow(window);
});

function applyExisting() {
  electron.BrowserWindow.getAllWindows().forEach(applyWindow);
}

if (electron.app.isReady()) {
  applyExisting();
} else {
  electron.app.once("ready", applyExisting);
}
