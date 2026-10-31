import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  loadAllProjectStates,
  saveProjectProps,
  type ProjectStateItem,
} from "./projects";
import {
  applyCppColorsToVscode,
  applyKeybindingsToVscode,
  loadCppColors,
  loadKeybindings,
  loadVisualEffect,
  loadVisualEffectOpacity,
  saveCppColors,
  saveKeybindings,
  saveVisualEffect,
  saveVisualEffectOpacity,
} from "./store";
import { applyVisualEffect } from "./visualEffects";
import {
  detectCompilers,
  getCachedCompilers,
  refreshCompilerCacheInBackground,
} from "./compilerDetect";
import {
  CPP_COLOR_DEFS,
  DEFAULT_KEYBINDINGS,
  DEFAULT_PROJECT,
  KEYBINDING_DEFS,
  ProjectProperties,
  DEFAULT_VISUAL_EFFECT_OPACITY,
  VISUAL_EFFECT_DEFS,
  VisualEffectId,
  VisualEffectOpacityMap,
} from "./types";

const VIEWLET_KEY = "workbench.sidebar.activeviewletid";
const SIDEBAR_HIDDEN_KEY = "workbench.sidebar.hidden";

interface SidebarSnapshot {
  viewlet?: string;
  hidden?: boolean;
}

function sidebarStateFiles(storageUri: vscode.Uri | undefined): string[] {
  if (!storageUri) {
    return [];
  }
  const dir = path.dirname(storageUri.fsPath);
  return [path.join(dir, "state.vscdb-wal"), path.join(dir, "state.vscdb")];
}

function textAfter(buf: Buffer, at: number): string | undefined {
  let end = at;
  const limit = Math.min(buf.length, at + 80);
  while (end < limit) {
    const c = buf[end];
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 45 ||
      c === 46 ||
      c === 95;
    if (!ok) {
      break;
    }
    end++;
  }
  if (end === at) {
    return undefined;
  }
  return buf.subarray(at, end).toString("utf8");
}

function readSnapshotFromFile(file: string): SidebarSnapshot | undefined {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  const viewletKey = Buffer.from(VIEWLET_KEY);
  const hiddenKey = Buffer.from(SIDEBAR_HIDDEN_KEY);
  let viewlet: string | undefined;
  let hidden: boolean | undefined;
  let from = 0;
  while (from < buf.length) {
    const idx = buf.indexOf(viewletKey, from);
    if (idx < 0) {
      break;
    }
    const token = textAfter(buf, idx + viewletKey.length);
    if (token && token.length >= 3) {
      viewlet = token;
    }
    from = idx + viewletKey.length;
  }
  from = 0;
  while (from < buf.length) {
    const idx = buf.indexOf(hiddenKey, from);
    if (idx < 0) {
      break;
    }
    const token = textAfter(buf, idx + hiddenKey.length);
    if (token === "true" || token === "false") {
      hidden = token === "true";
    }
    from = idx + hiddenKey.length;
  }
  if (!viewlet && hidden === undefined) {
    return undefined;
  }
  return { viewlet, hidden };
}

const snapshotCache = new Map<string, { mtime: number; snap?: SidebarSnapshot }>();

function readSidebarSnapshot(storageUri: vscode.Uri | undefined): SidebarSnapshot | undefined {
  let best: { mtime: number; snap: SidebarSnapshot } | undefined;
  for (const file of sidebarStateFiles(storageUri)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const cached = snapshotCache.get(file);
    const snap = cached && cached.mtime === mtime ? cached.snap : readSnapshotFromFile(file);
    if (!cached || cached.mtime !== mtime) {
      snapshotCache.set(file, { mtime, snap });
    }
    if (!snap) {
      continue;
    }
    if (!best || mtime >= best.mtime) {
      best = { mtime, snap };
    }
  }
  return best?.snap;
}

export class SmileSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "smile-cpp.sidebar";
  public static readonly panelType = "smile-cpp.panel";
  private panel?: vscode.WebviewPanel;
  private sidebarView?: vscode.WebviewView;
  private pendingTab?: string;
  private opening = false;
  private projects: ProjectStateItem[] = [];
  private storageUri?: vscode.Uri;
  private previousViewlet?: string;
  private sidebarWasHidden = false;
  private viewletTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly extensionUri: vscode.Uri) {}

  startTrackingSidebar(storageUri: vscode.Uri | undefined): void {
    this.storageUri = storageUri;
    this.captureViewlet();
    const tick = () => {
      this.captureViewlet();
      this.viewletTimer = setTimeout(tick, 800);
    };
    this.viewletTimer = setTimeout(tick, 800);
  }

  stopTrackingSidebar(): void {
    if (this.viewletTimer) {
      clearTimeout(this.viewletTimer);
      this.viewletTimer = undefined;
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.sidebarView = webviewView;
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = `<!DOCTYPE html><html><body style="background:var(--vscode-sideBar-background,#1a1d22)"></body></html>`;
    webviewView.onDidDispose(() => {
      if (this.sidebarView === webviewView) {
        this.sidebarView = undefined;
      }
    });
    const openWhenShown = () => {
      if (webviewView.visible) {
        void this.openFromSidebar();
      }
    };
    webviewView.onDidChangeVisibility(openWhenShown);
    openWhenShown();
  }

  private ignoreSidebarOpen = false;

  private captureViewlet(): void {
    if (this.sidebarView?.visible) {
      return;
    }
    const snap = readSidebarSnapshot(this.storageUri);
    if (!snap) {
      return;
    }
    if (snap.viewlet && snap.viewlet !== "smile-cpp" && !snap.viewlet.startsWith("smile-cpp.")) {
      this.previousViewlet = snap.viewlet;
    }
    if (snap.hidden !== undefined) {
      this.sidebarWasHidden = snap.hidden;
    }
  }

  private async restorePreviousSidebar(): Promise<void> {
    const id = this.previousViewlet;
    if (!id) {
      return;
    }
    try {
      await vscode.commands.executeCommand(id, { preserveFocus: true });
    } catch {
      // 恢复不到原来的侧边栏时保持现状，不能把其他侧边栏关掉
    }
  }

  private async openFromSidebar(): Promise<void> {
    if (this.ignoreSidebarOpen) {
      return;
    }
    this.ignoreSidebarOpen = true;
    try {
      await this.openWindow();
      if (this.sidebarWasHidden) {
        try {
          await vscode.commands.executeCommand("workbench.action.closeSidebar");
        } catch {
          // 侧边栏本来就是收起的
        }
      } else {
        await this.restorePreviousSidebar();
      }
      this.panel?.reveal(undefined, false);
    } finally {
      setTimeout(() => {
        this.ignoreSidebarOpen = false;
      }, 500);
    }
  }

  async openWindow(tab?: string): Promise<void> {
    if (this.opening) {
      if (tab) {
        this.pendingTab = tab;
      }
      return;
    }
    if (tab) {
      this.pendingTab = tab;
    }
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (tab) {
        void this.panel.webview.postMessage({ type: "switchTab", tab });
      }
      return;
    }
    this.opening = true;
    try {
      const panel = vscode.window.createWebviewPanel(
        SmileSidebarProvider.panelType,
        "Smile",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        }
      );
      this.attachPanel(panel, false);
      await this.floatPanel(panel);
      const payload = await this.loadViewState();
      try {
        panel.webview.html = this.getHtml(panel.webview, payload);
      } catch {
        // 窗口在移动过程中被关掉
      }
    } finally {
      this.opening = false;
    }
  }

  attachPanel(panel: vscode.WebviewPanel, restored: boolean): void {
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.png");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    const messages = panel.webview.onDidReceiveMessage((message) => {
      void this.onMessage(message, panel.webview);
    });
    panel.onDidDispose(() => {
      messages.dispose();
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    if (restored) {
      void this.loadViewState().then((payload) => {
        if (this.panel === panel) {
          panel.webview.html = this.getHtml(panel.webview, payload);
        }
      });
    }
  }

  private async floatPanel(panel: vscode.WebviewPanel): Promise<void> {
    panel.reveal(vscode.ViewColumn.Beside, false);
    for (let i = 0; i < 8 && this.panel === panel && !panel.active; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      panel.reveal(vscode.ViewColumn.Beside, false);
    }
    if (this.panel !== panel || !panel.active) {
      return;
    }
    try {
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    } catch {
      // 编辑器不支持独立窗口时，面板留在编辑区，仍可拖成浮动窗口
    }
  }

  private async onMessage(message: { type?: string; [key: string]: unknown }, webview: vscode.Webview): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.postState();
          if (this.pendingTab) {
            const tab = this.pendingTab;
            this.pendingTab = undefined;
            void webview.postMessage({ type: "switchTab", tab });
          }
          break;
        case "saveProject": {
            const id = String(message.projectId || "");
            const project = this.projects.find((p) => p.id === id);
            if (!project) {
              throw new Error("未找到对应项目");
            }
            const info = saveProjectProps(project, message.payload as ProjectProperties);
            vscode.window.showInformationMessage(info);
            this.panel?.dispose();
            break;
          }
          case "resetProject": {
            const id = String(message.projectId || "");
            const project = this.projects.find((p) => p.id === id);
            if (!project) {
              throw new Error("未找到对应项目");
            }
            saveProjectProps(project, structuredClone(DEFAULT_PROJECT));
            await this.postState();
            break;
          }
          case "saveKeybindings": {
            const keys = message.payload as Record<string, string>;
            await saveKeybindings(keys);
            await applyKeybindingsToVscode(keys);
            vscode.window.showInformationMessage("键盘设置已写入用户 keybindings.json");
            this.panel?.dispose();
            break;
          }
          case "saveColors": {
            const payload = message.payload as {
              colors: typeof CPP_COLOR_DEFS;
              visualEffect?: VisualEffectId;
              opacities?: VisualEffectOpacityMap;
            };
            const colors = payload.colors;
            const effect = payload.visualEffect ?? "none";
            const opacities = payload.opacities ?? loadVisualEffectOpacity();
            await saveCppColors(colors);
            await applyCppColorsToVscode(colors);
            await saveVisualEffect(effect);
            await saveVisualEffectOpacity(opacities);
            await applyVisualEffect(effect, { reload: true, opacity: opacities });
            if (effect === "none") {
              vscode.window.showInformationMessage("C++ 颜色已写入当前主题配置");
            }
            await this.postState();
            break;
          }
          case "resetKeybindings":
            await saveKeybindings({ ...DEFAULT_KEYBINDINGS });
            await applyKeybindingsToVscode({ ...DEFAULT_KEYBINDINGS });
            await this.postState();
            break;
          case "resetColors":
            await saveCppColors(structuredClone(CPP_COLOR_DEFS));
            await applyCppColorsToVscode(structuredClone(CPP_COLOR_DEFS));
            await this.postState();
            break;
          case "pickFolder": {
            const uris = await vscode.window.showOpenDialog({
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
              openLabel: "选择路径",
            });
            if (uris?.[0]) {
              void webview.postMessage({
                type: "pathPicked",
                field: message.field,
                path: uris[0].fsPath,
              });
            }
            break;
          }
          case "pickFile": {
            const uris = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: false,
              openLabel: "选择文件",
            });
            if (uris?.[0]) {
              void webview.postMessage({
                type: "pathPicked",
                field: message.field,
                path: uris[0].fsPath,
              });
            }
            break;
          }
          case "detectCompilers": {
            const all = detectCompilers(true);
            if (!all.length) {
              vscode.window.showWarningMessage(
                "未找到 g++ 或 clang++。请安装 MinGW-w64 或 LLVM，或手动指定编译器路径。"
              );
            }
            void webview.postMessage({
              type: "compilersDetected",
              projectId: message.projectId,
              compilers: all,
            });
            break;
          }
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Smile: ${text}`);
    }
  }

  refresh(): void {
    void this.postState();
  }

  private async loadViewState(): Promise<Record<string, unknown>> {
    this.projects = await loadAllProjectStates();
    return {
      projects: this.projects,
      keybindings: loadKeybindings(),
      keybindingDefs: KEYBINDING_DEFS,
      colors: loadCppColors(),
      visualEffect: loadVisualEffect(),
      visualEffectOpacity: loadVisualEffectOpacity(),
      visualEffects: VISUAL_EFFECT_DEFS,
      compilers: getCachedCompilers(),
      hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length),
    };
  }

  private async postState(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const payload = await this.loadViewState();
    void this.panel.webview.postMessage({ type: "state", ...payload });
    void refreshCompilerCacheInBackground(this.panel);
  }

  private getHtml(webview: vscode.Webview, payload?: Record<string, unknown>): string {
    const embedded = JSON.stringify(payload ?? {}).replace(/</g, "\\u003c");
    const nonce = getNonce();
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "smile-logo.png")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Smile</title>
<style>
:root {
  --bg: #141414;
  --fg: #ececec;
  --muted: #8f8f8f;
  --line: #2a2a2a;
  --card: transparent;
  --header: #141414;
  --input-bg: #222222;
  --input-fg: #ececec;
  --input-border: #2e2e2e;
  --hover: #2a2a2a;
  --ink: #141414;
  --dropdown-bg: #222222;
  --dropdown-fg: #ececec;
  --dropdown-border: #2e2e2e;
  --dropdown-list-bg: #1c1c1c;
  --border: #2a2a2a;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden;
  background: var(--bg); color: var(--fg);
  font-family: var(--vscode-font-family, "Segoe UI", sans-serif); font-size: 13px;
}
.app {
  display: flex; flex-direction: column;
  height: 100%; width: 100%; min-width: 0; min-height: 0;
}
.top {
  flex: 0 0 auto;
  display: flex; align-items: flex-end; gap: 28px;
  padding: 0 22px;
  background: var(--header);
}
.brand {
  display: flex; flex-direction: row; align-items: center; gap: 10px;
  padding: 12px 0 10px; background: transparent; border: none;
}
.logo { width: 28px; height: 28px; object-fit: contain; display: block; }
.brand h1 {
  margin: 0; font-size: 16px; font-weight: 700; letter-spacing: 0.08em; color: #fff; line-height: 1.1;
}
.brand-sub { margin: 2px 0 0; color: var(--muted); font-size: 11px; letter-spacing: 0.02em; }
.tabs {
  display: flex; align-items: flex-end; gap: 2px;
  background: transparent; border: none; padding: 0;
}
.tab {
  appearance: none; border: none; border-bottom: 2px solid transparent;
  background: transparent; color: var(--muted);
  padding: 12px 14px 10px; cursor: pointer; font: inherit; font-size: 13px;
  border-radius: 0;
}
.tab:hover { color: var(--fg); }
.tab.active { color: #fff; border-bottom-color: #fff; font-weight: 650; }
.body {
  flex: 1 1 auto; min-height: 0; min-width: 0;
  display: flex; flex-direction: column; overflow: hidden; padding: 0;
}
.page { display: none; }
.page.active {
  display: flex; flex-direction: column;
  flex: 1 1 auto; min-height: 0; min-width: 0;
}
.page-scroll {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 18px 22px 22px;
}
.page-inner { width: min(880px, 100%); margin: 0 auto; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.editor { display: flex; flex-direction: column; gap: 22px; }
.secbar {
  display: flex; flex-wrap: wrap; gap: 0;
  margin: 0 0 10px;
  border-bottom: 1px solid var(--border);
}
.secbar button {
  appearance: none; border: none; border-bottom: 2px solid transparent;
  background: transparent; color: var(--muted);
  padding: 7px 10px; margin-bottom: -1px;
  cursor: pointer; font: inherit; font-size: 11px;
}
.secbar button:hover { color: var(--fg); }
.secbar button.active {
  color: var(--fg); font-weight: 650;
  border-bottom-color: #fff;
}
.card {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0 0 4px;
}
.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.group-title {
  margin: 0; padding: 0; border: none;
  color: var(--fg); font-size: 18px; font-weight: 700; letter-spacing: 0.02em;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
  margin-top: 12px;
}
.span-2 { grid-column: 1 / -1; }
.field { margin: 0; min-width: 0; }
.field > label {
  display: block; margin-bottom: 6px; color: var(--muted); font-size: 12px;
}
.field-action { display: flex; align-items: flex-end; }
.field-action .btn { height: 32px; }
.row { display: flex; gap: 8px; align-items: center; }
.row > input[type="text"] { flex: 1 1 auto; min-width: 0; }
input[type="text"], textarea, .cselect-btn {
  width: 100%; background: var(--input-bg); color: var(--input-fg);
  border: 1px solid var(--input-border); border-radius: 6px;
  padding: 0 10px; outline: none; font: inherit; font-size: 13px;
}
input[type="text"], .cselect-btn { height: 32px; }
textarea { min-height: 76px; padding: 8px 10px; resize: vertical; line-height: 1.45; }
input:focus, textarea:focus, .cselect-btn:focus {
  border-color: #6a6a6a;
  box-shadow: none;
}
input[type="color"] { padding: 2px; height: 28px; width: 36px; border-radius: 6px; background: var(--input-bg); border: 1px solid var(--input-border); }
@media (max-width: 680px) {
  .form-grid, .cols-3 { grid-template-columns: 1fr; }
  .span-2 { grid-column: auto; }
  .top { flex-direction: column; align-items: flex-start; gap: 0; }
}

.cselect { position: relative; width: 100%; }
.cselect-btn {
  text-align: left; appearance: none; cursor: pointer;
  background: var(--dropdown-bg); color: var(--dropdown-fg);
  border: 1px solid var(--dropdown-border);
  padding-right: 28px; position: relative;
}
.cselect-btn::after {
  content: ""; position: absolute; right: 8px; top: 50%;
  border: 4px solid transparent; border-top-color: var(--dropdown-fg);
  transform: translateY(-15%);
}
.cselect-btn:focus { outline: none; }
.cselect-menu {
  display: none; position: fixed; z-index: 1000;
  max-height: 180px; overflow: auto;
  background: var(--vscode-editorWidget-background, #252526); color: var(--dropdown-fg);
  border: 1px solid var(--dropdown-border); border-radius: 3px;
  box-shadow: 0 8px 20px rgba(0,0,0,.45);
}
.cselect.open .cselect-menu { display: block; }
.cselect-option {
  padding: 6px 7px; cursor: pointer; color: var(--dropdown-fg);
  background: var(--dropdown-list-bg);
}
.cselect-option:hover, .cselect-option.active {
  background: #333; color: #fff;
}

.btn {
  appearance: none; border: 1px solid transparent; border-radius: 6px; cursor: pointer;
  height: 32px; padding: 0 14px; background: #2a2a2a; color: var(--fg); font: inherit; font-size: 13px;
}
.btn:hover { background: #333; }
.btn.secondary { background: transparent; border-color: #3a3a3a; color: var(--fg); }
.btn.secondary:hover { background: #222; }
.btn.ghost {
  height: 32px; padding: 0 10px; background: transparent; border-color: #3a3a3a; color: var(--fg); flex: 0 0 auto;
}
.btn.ghost:hover { background: #222; color: #fff; }
.btn.primary-amber { background: #ececec; color: var(--ink); font-weight: 650; border-color: transparent; }
.btn.primary-amber:hover { background: #fff; }
.actions {
  flex: 0 0 auto; margin: 0; padding: 14px 22px 16px;
  border: none; background: transparent;
}
.actions-inner { display: flex; gap: 8px; align-items: center; justify-content: center; }
.btn:disabled { opacity: 0.45; cursor: default; }
.hint { margin: 6px 0 0; color: var(--muted); line-height: 1.5; font-size: 12px; }
.warn {
  padding: 8px 0; margin-bottom: 8px;
  border: none; background: transparent; color: var(--muted);
}
#kb-list { margin-top: 12px; border: none; background: transparent; }
.kb-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 148px; gap: 16px;
  align-items: center; margin: 0; padding: 8px 0;
  border: none;
}
.kb-row:hover { background: transparent; }
.kb-capture {
  appearance: none; border: 1px solid var(--line); border-radius: 6px;
  background: var(--input-bg); color: var(--input-fg);
  padding: 0 8px; font: inherit; font-size: 12px; cursor: pointer; text-align: center;
  height: 32px;
}
.kb-capture:hover { border-color: #6a6a6a; }
.kb-capture.recording {
  border-color: #ececec; color: #fff;
  box-shadow: none;
}
.color-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.color-group {
  border: none;
  border-radius: 0;
  background: transparent;
  overflow: hidden;
}
.color-group > summary.color-cat {
  margin: 0; padding: 6px 0;
  font-weight: 650; font-size: 13px; color: var(--fg);
  background: transparent;
  border: none;
  cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px;
}
.color-group > summary.color-cat::-webkit-details-marker { display: none; }
.color-group > summary.color-cat::before {
  content: ""; width: 5px; height: 5px; flex: 0 0 5px;
  border-right: 1.5px solid color-mix(in srgb, var(--fg) 55%, transparent);
  border-bottom: 1.5px solid color-mix(in srgb, var(--fg) 55%, transparent);
  transform: rotate(-45deg); margin: 0 2px 0 1px;
}
.color-group[open] > summary.color-cat::before {
  transform: rotate(45deg); margin-top: -2px;
}
.color-group[open] > summary.color-cat { color: var(--fg); }
.color-group-body { padding: 2px 0 10px 28px; }
.effect-options { display: flex; flex-direction: column; gap: 8px; margin: 12px 0 16px; }
.effect-row {
  display: grid; grid-template-columns: 16px 72px minmax(120px, 1fr) 40px;
  gap: 8px; align-items: center;
  padding: 6px 0; border: none; border-radius: 0;
  background: transparent;
}
.effect-row:hover { background: transparent; }
.effect-row label { display: flex; align-items: center; gap: 5px; cursor: pointer; color: var(--fg); }
.effect-row input[type="radio"] { margin: 0; }
.effect-row input[type="range"] { width: 100%; accent-color: #c8c8c8; }
.effect-row .pct { color: var(--muted); font-size: 10px; text-align: right; }
.effect-row.none-row { grid-template-columns: 16px 1fr; }
.color-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto 40px 72px; gap: 6px;
  align-items: center; margin-bottom: 8px;
}
.color-label {
  font-weight: 450; color: #8a8a8a; cursor: default;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.color-label:hover { color: #b5b5b5; }
.checks { display: flex; gap: 6px; color: var(--muted); font-size: 11px; white-space: nowrap; }
.checks label { display: flex; gap: 3px; align-items: center; }
.sub { color: var(--muted); font-size: 10px; word-break: break-all; }
.hidden { display: none !important; }
.modal-mask {
  display: none; position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,.5); align-items: center; justify-content: center;
}
.modal-mask.show { display: flex; }
.modal-card {
  width: min(420px, calc(100% - 24px));
  background: #151b24; border: 1px solid var(--border);
  border-radius: 6px; padding: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.55);
}
.modal-card h3 { margin: 0 0 8px; }
.cfg-table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 11px; }
.cfg-table th, .cfg-table td {
  border: 1px solid var(--border); padding: 5px 6px; text-align: left;
}
.cfg-table th { color: var(--muted); }
.cfg-form { display: grid; grid-template-columns: 1fr; gap: 6px; margin-top: 8px; }
.project-card { margin-bottom: 8px; }
.project-card .form-grid { margin-top: 0; }
#project-editor { display: flex; flex-direction: column; gap: 22px; }
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <div class="brand">
      <img class="logo" src="${logoUri}" alt="" />
      <div>
        <h1>Smile</h1>
        <p class="brand-sub">C / C++ 工程</p>
      </div>
    </div>
    <nav class="tabs">
      <button class="tab active" data-tab="project">项目</button>
      <button class="tab" data-tab="keyboard">键盘</button>
      <button class="tab" data-tab="colors">颜色</button>
    </nav>
  </header>
  <div class="body">
    <section class="page active" id="page-project">
      <div class="page-scroll">
        <div class="page-inner">
          <div id="warn" class="warn hidden">需要先打开工作区文件夹才能保存项目属性。</div>
          <div class="card project-card">
            <div class="form-grid">
              <div class="field">
                <label>当前项目</label>
                <div class="cselect" id="project-select"></div>
              </div>
            </div>
          </div>
          <div id="project-editor"></div>
        </div>
      </div>
      <div class="actions">
        <div class="page-inner actions-inner">
          <button class="btn primary-amber" id="save-project" disabled>保存</button>
          <button class="btn secondary" id="reset-project" disabled>恢复默认</button>
        </div>
      </div>
    </section>

    <section class="page" id="page-keyboard">
      <div class="page-scroll">
        <div class="page-inner">
          <section class="card">
            <h2 class="group-title">键盘</h2>
            <p class="hint">点右侧按键，再按下要设置的快捷键。保存后写入用户 keybindings.json。</p>
            <div id="kb-list"></div>
          </section>
        </div>
      </div>
      <div class="actions">
        <div class="page-inner actions-inner">
          <button class="btn primary-amber" id="save-keyboard">保存</button>
          <button class="btn secondary" id="reset-keyboard">恢复默认</button>
        </div>
      </div>
    </section>

    <section class="page" id="page-colors">
      <div class="page-scroll">
        <div class="page-inner stack">
          <section class="card">
            <h2 class="group-title">视觉效果</h2>
            <p class="hint">窗口亚克力叠一层黑色。菜单比主界面略不透明。选「无」或卸载会恢复原来的配色和菜单。重新应用后需要重启。</p>
            <div class="effect-options" id="effect-options"></div>
          </section>
          <section class="card">
            <h2 class="group-title">C++ 颜色</h2>
            <p class="hint">全局着色，保存后写入当前主题。</p>
            <div id="color-list"></div>
          </section>
        </div>
      </div>
      <div class="actions">
        <div class="page-inner actions-inner">
          <button class="btn primary-amber" id="save-colors">应用</button>
          <button class="btn secondary" id="reset-colors">恢复默认</button>
        </div>
      </div>
    </section>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = ${embedded};
if (!state.projects) state.projects = [];
if (!state.keybindings) state.keybindings = {};
if (!state.keybindingDefs) state.keybindingDefs = [];
if (!state.colors) state.colors = [];
if (!state.visualEffect) state.visualEffect = 'none';
if (!state.visualEffectOpacity) state.visualEffectOpacity = ${JSON.stringify(DEFAULT_VISUAL_EFFECT_OPACITY)};
if (!state.compilers) state.compilers = [];
if (!state.visualEffects) state.visualEffects = ${JSON.stringify(VISUAL_EFFECT_DEFS)};
let openColorCats = new Set(['常规']);
let openProjectId = null;

function $(id) { return document.getElementById(id); }
function getDeep(obj, path) {
  return path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
}
function setDeep(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
}
function pid(id, field) { return id + '::' + field; }

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + tab));
}
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function closeAllSelects(except) {
  document.querySelectorAll('.cselect.open').forEach(el => {
    if (el !== except) el.classList.remove('open');
  });
}

function mountSelect(el, options, value, onChange) {
  const opts = options.slice();
  el.innerHTML = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cselect-btn';
  btn.textContent = value || opts[0] || '';
  const menu = document.createElement('div');
  menu.className = 'cselect-menu';
  function rebuild() {
    menu.innerHTML = '';
    for (const opt of opts) {
      const item = document.createElement('div');
      item.className = 'cselect-option' + (opt === btn.textContent ? ' active' : '');
      item.textContent = opt;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.textContent = opt;
        el.classList.remove('open');
        el.dataset.value = opt;
        if (onChange) onChange(opt);
      });
      menu.appendChild(item);
    }
  }
  rebuild();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !el.classList.contains('open');
    closeAllSelects(el);
    el.classList.toggle('open', willOpen);
    if (willOpen) {
      const r = btn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.left = r.left + 'px';
      menu.style.top = (r.bottom + 2) + 'px';
      menu.style.width = r.width + 'px';
      menu.style.right = 'auto';
      menu.style.zIndex = '1000';
    }
  });
  el.appendChild(btn);
  el.appendChild(menu);
  el.dataset.value = value || opts[0] || '';
  el._setOptions = (next, selected) => {
    opts.splice(0, opts.length, ...next);
    btn.textContent = selected || next[0] || '';
    el.dataset.value = btn.textContent;
    rebuild();
  };
  el._setValue = (v) => {
    btn.textContent = v;
    el.dataset.value = v;
    rebuild();
  };
}

function editorHtml(id, kind) {
  const cmake = kind === 'cmake';
  return \`
  <div class="editor" data-project-id="\${id}" data-kind="\${kind || 'smile'}">
    <section class="card">
      <h2 class="group-title">工具链</h2>
      <div class="form-grid">
        <div class="field"><label>编译器</label>
          <div class="cselect" data-role="compiler"></div>
        </div>
        <div class="field field-action">
          <button class="btn secondary" data-detect-compiler="\${id}">重新检测</button>
        </div>
        <div class="field span-2"><label>路径</label><div class="row">
          <input type="text" id="\${pid(id,'compiler.path')}" placeholder="g++.exe、clang++.exe 或工具链根目录" />
          <button class="btn ghost" data-pick-file="\${pid(id,'compiler.path')}">文件</button>
          <button class="btn ghost" data-pick-folder="\${pid(id,'compiler.path')}">目录</button>
        </div></div>
        <div class="field"><label>语言标准</label>
          <div class="cselect" data-field="general.languageStandard" data-options='["C++14","C++17","C++20"]'></div>
        </div>
        <div class="field"><label>构建类型</label>
          <div class="cselect" data-field="configuration.config" data-options='["Debug","Release"]'></div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2 class="group-title">目标</h2>
      <div class="form-grid cols-3">
        <div class="field"><label>构建目录</label>
          <input type="text" id="\${pid(id,'general.outputDirectory')}" placeholder="build" />
        </div>
        <div class="field"><label>目标名</label>
          <input type="text" id="\${pid(id,'general.targetFileName')}" placeholder="留空则使用项目名" />
        </div>
        <div class="field \${cmake ? 'hidden' : ''}" data-folder-only>
          <label>产物</label>
          <div class="cselect" data-field="general.configurationType" data-options='["可执行文件","动态库","静态库"]'></div>
        </div>
      </div>
    </section>

    <section class="card \${cmake ? 'hidden' : ''}" data-folder-only>
      <h2 class="group-title">编译</h2>
      <div class="form-grid">
        <div class="field"><label>包含目录</label><textarea id="\${pid(id,'cpp.additionalIncludeDirectories')}"></textarea></div>
        <div class="field"><label>宏定义</label><textarea id="\${pid(id,'cpp.preprocessorDefinitions')}"></textarea></div>
        <div class="field"><label>库目录</label><textarea id="\${pid(id,'cpp.additionalLibraryDirectories')}"></textarea></div>
        <div class="field"><label>链接库</label><textarea id="\${pid(id,'cpp.additionalDependencies')}"></textarea></div>
      </div>
    </section>

    <section class="card">
      <h2 class="group-title">运行</h2>
      <div class="form-grid">
        <div class="field span-2"><label>程序</label><div class="row">
          <input type="text" id="\${pid(id,'debug.command')}" placeholder="留空则运行构建产物" />
          <button class="btn ghost" data-pick-file="\${pid(id,'debug.command')}">浏览</button>
        </div></div>
        <div class="field"><label>参数</label>
          <input type="text" id="\${pid(id,'debug.commandArguments')}" />
        </div>
        <div class="field"><label>工作目录</label><div class="row">
          <input type="text" id="\${pid(id,'debug.workingDirectory')}" placeholder="留空则使用工程目录" />
          <button class="btn ghost" data-pick-folder="\${pid(id,'debug.workingDirectory')}">浏览</button>
        </div></div>
      </div>
    </section>
  </div>\`;
}

const EDITOR_TEXT_FIELDS = [
  'compiler.path','general.outputDirectory','general.targetFileName',
  'debug.command','debug.commandArguments','debug.workingDirectory',
  'cpp.additionalIncludeDirectories','cpp.additionalLibraryDirectories',
  'cpp.additionalDependencies','cpp.preprocessorDefinitions'
];

function mountCompilerSelect(root, id) {
  const el = root.querySelector('[data-role="compiler"]');
  if (!el) return;
  const list = state.compilers || [];
  const labels = list.length ? list.map(c => c.label) : ['（未检测到，请重新检测或手动指定）'];
  const pathEl = $(pid(id, 'compiler.path'));
  const currentPath = pathEl?.value || '';
  const current = list.find(c => c.path === currentPath || c.command === currentPath);
  if (pathEl && !currentPath && list[0]) pathEl.value = list[0].path;
  const selected = current?.label || labels[0];
  root.dataset.compilerName = (current || list[0])?.name || root.dataset.compilerName || 'GCC';
  mountSelect(el, labels, selected, (label) => {
    const hit = list.find(c => c.label === label);
    if (!hit) return;
    const input = $(pid(id, 'compiler.path'));
    if (input) input.value = hit.path;
    root.dataset.compilerName = hit.name;
  });
}

function bindEditor(root, project) {
  const id = project.id;
  const props = project.props;
  root.dataset.compilerName = props.compiler?.name || 'GCC';
  for (const field of EDITOR_TEXT_FIELDS) {
    const el = $(pid(id, field));
    if (el) el.value = getDeep(props, field) ?? '';
  }
  root.querySelectorAll('.cselect[data-options]').forEach(el => {
    const options = JSON.parse(el.getAttribute('data-options'));
    const val = getDeep(props, el.dataset.field);
    mountSelect(el, options, options.includes(val) ? val : options[0]);
  });
  mountCompilerSelect(root, id);
  root.querySelector('[data-detect-compiler]')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'detectCompilers', projectId: id });
  });
  root.querySelectorAll('[data-pick-file]').forEach(btn => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'pickFile', field: btn.getAttribute('data-pick-file') }));
  });
  root.querySelectorAll('[data-pick-folder]').forEach(btn => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'pickFolder', field: btn.getAttribute('data-pick-folder') }));
  });
  const saveBtn = $('save-project');
  const resetBtn = $('reset-project');
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.onclick = () => {
      vscode.postMessage({ type: 'saveProject', projectId: id, payload: collectEditor(root, props) });
    };
  }
  if (resetBtn) {
    resetBtn.disabled = false;
    resetBtn.onclick = () => vscode.postMessage({ type: 'resetProject', projectId: id });
  }
}

function collectEditor(root, baseProps) {
  const project = JSON.parse(JSON.stringify(baseProps));
  const id = root.dataset.projectId || root.closest('[data-project-id]')?.dataset.projectId;
  for (const field of EDITOR_TEXT_FIELDS) {
    const el = $(pid(id, field));
    if (el) setDeep(project, field, el.value);
  }
  root.querySelectorAll('.cselect[data-field]').forEach(el => {
    setDeep(project, el.dataset.field, el.dataset.value || el.querySelector('.cselect-btn')?.textContent || '');
  });
  const pathVal = project.compiler?.path || '';
  if (/clang/i.test(pathVal)) project.compiler.name = 'Clang';
  else if (/g[+][+]|gcc|mingw/i.test(pathVal)) project.compiler.name = 'GCC';
  else project.compiler.name = root.dataset.compilerName === 'Clang' ? 'Clang' : 'GCC';
  project.configuration.platform = 'x64';
  project.configuration.configurations = [
    { name: 'Debug', platform: 'x64' },
    { name: 'Release', platform: 'x64' }
  ];
  if (project.configuration.config !== 'Release') project.configuration.config = 'Debug';
  if (!['可执行文件','动态库','静态库'].includes(project.general.configurationType)) {
    project.general.configurationType = '可执行文件';
  }
  if (!['C++14','C++17','C++20'].includes(project.general.languageStandard)) {
    project.general.languageStandard = 'C++17';
  }
  return project;
}

function showProjectEditor(project) {
  const host = $('project-editor');
  if (!project) {
    host.innerHTML = '';
    const saveBtn = $('save-project');
    const resetBtn = $('reset-project');
    if (saveBtn) saveBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    return;
  }
  openProjectId = project.id;
  host.innerHTML = editorHtml(project.id, project.kind);
  const root = host.querySelector('.editor');
  try {
    bindEditor(root, project);
  } catch (err) {
    host.innerHTML = '<p class="hint">项目编辑器加载失败: ' + (err && err.message ? err.message : String(err)) + '</p>';
  }
}

function renderProjects() {
  const selectEl = $('project-select');
  const host = $('project-editor');
  if (!state.projects || !state.projects.length) {
    if (selectEl) selectEl.innerHTML = '';
    host.innerHTML = '<p class="hint">未发现项目。打开含 CMakeLists.txt 或 C/C++ 源文件的文件夹后重试。</p>';
    const saveBtn = $('save-project');
    const resetBtn = $('reset-project');
    if (saveBtn) saveBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    return;
  }
  if (!openProjectId || !state.projects.some(p => p.id === openProjectId)) {
    openProjectId = state.projects[0].id;
  }
  const labels = state.projects.map(p => p.name + '  (' + p.sourceLabel + ')');
  const current = state.projects.find(p => p.id === openProjectId) || state.projects[0];
  const currentLabel = current.name + '  (' + current.sourceLabel + ')';
  selectEl.innerHTML = '';
  mountSelect(selectEl, labels, currentLabel, (label) => {
    const idx = labels.indexOf(label);
    const next = state.projects[idx];
    if (next) showProjectEditor(next);
  });
  showProjectEditor(current);
}

let recordingHandler = null;

function normalizeKeyEvent(e) {
  const map = {
    ' ': 'Space', Spacebar: 'Space',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Escape: 'Escape', Esc: 'Escape', Enter: 'Enter', Tab: 'Tab',
    Backspace: 'Backspace', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'Insert'
  };
  if (map[e.key]) return map[e.key];
  if (/^F[0-9]{1,2}$/i.test(e.key)) return e.key.toUpperCase();
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key;
}

function stopRecording() {
  if (recordingHandler) {
    window.removeEventListener('keydown', recordingHandler, true);
    recordingHandler = null;
  }
  document.querySelectorAll('.kb-capture.recording').forEach(el => {
    el.classList.remove('recording');
    if (el.dataset.key) el.textContent = el.dataset.key;
    else el.textContent = '点击设置';
  });
}

function renderKeybindings() {
  stopRecording();
  const root = $('kb-list');
  root.innerHTML = '';
  for (const def of state.keybindingDefs) {
    const row = document.createElement('div');
    row.className = 'kb-row';
    const key = state.keybindings[def.id] || '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kb-capture';
    btn.setAttribute('data-kb', def.id);
    btn.dataset.key = key;
    btn.textContent = key || '点击设置';
    btn.title = '点击后按下快捷键';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      stopRecording();
      btn.classList.add('recording');
      btn.textContent = '请按键…';
      recordingHandler = (e) => {
        if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Meta');
        parts.push(normalizeKeyEvent(e));
        const combo = parts.join('+');
        btn.dataset.key = combo;
        btn.textContent = combo;
        btn.classList.remove('recording');
        window.removeEventListener('keydown', recordingHandler, true);
        recordingHandler = null;
      };
      window.addEventListener('keydown', recordingHandler, true);
    });
    const label = document.createElement('div');
    label.innerHTML = '<strong>' + def.label + '</strong><div class="sub">' + def.command + '</div>';
    row.appendChild(label);
    row.appendChild(btn);
    root.appendChild(row);
  }
}

function collectKeybindings() {
  const map = {};
  document.querySelectorAll('[data-kb]').forEach(el => {
    map[el.getAttribute('data-kb')] = (el.dataset.key || el.textContent || '').trim();
  });
  return map;
}

function colorTooltip(c) {
  const parts = [];
  if (c.scope) parts.push(...(Array.isArray(c.scope) ? c.scope : [c.scope]));
  if (c.semantic) parts.push(...(Array.isArray(c.semantic) ? c.semantic : [c.semantic]));
  return parts.filter(Boolean).join(', ');
}

function renderEffects() {
  const root = $('effect-options');
  if (!root) return;
  root.innerHTML = '';
  const current = state.visualEffect || 'none';
  const opacity = state.visualEffectOpacity || {};
  for (const item of state.visualEffects || []) {
    const row = document.createElement('div');
    row.className = 'effect-row' + (item.id === 'none' ? ' none-row' : '');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'visual-effect';
    radio.value = item.id;
    radio.checked = item.id === current;
    const name = document.createElement('label');
    name.textContent = item.label;
    name.addEventListener('click', () => { radio.checked = true; });
    row.appendChild(radio);
    row.appendChild(name);
    if (item.id !== 'none') {
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '100';
      range.setAttribute('data-effect-opacity', item.id);
      range.value = String(opacity[item.id] ?? ${DEFAULT_VISUAL_EFFECT_OPACITY.acrylic});
      const pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = range.value + '%';
      range.addEventListener('input', () => {
        pct.textContent = range.value + '%';
        radio.checked = true;
      });
      row.appendChild(range);
      row.appendChild(pct);
    }
    root.appendChild(row);
  }
}

function collectVisualEffect() {
  const el = document.querySelector('input[name="visual-effect"]:checked');
  return el ? el.value : (state.visualEffect || 'none');
}

function collectVisualEffectOpacity() {
  const map = Object.assign({}, state.visualEffectOpacity || {});
  document.querySelectorAll('[data-effect-opacity]').forEach(el => {
    map[el.getAttribute('data-effect-opacity')] = Number(el.value);
  });
  return map;
}

function renderColors() {
  const root = $('color-list');
  root.className = 'color-list';
  root.innerHTML = '';
  let lastCat = '';
  let body = null;
  for (const c of state.colors) {
    if (c.category !== lastCat) {
      lastCat = c.category;
      const cat = lastCat;
      const group = document.createElement('details');
      group.className = 'color-group';
      group.open = openColorCats.has(cat);
      group.addEventListener('toggle', () => {
        if (group.open) openColorCats.add(cat);
        else openColorCats.delete(cat);
      });
      const h = document.createElement('summary');
      h.className = 'color-cat';
      h.textContent = lastCat;
      body = document.createElement('div');
      body.className = 'color-group-body';
      group.appendChild(h);
      group.appendChild(body);
      root.appendChild(group);
    }
    const row = document.createElement('div');
    row.className = 'color-row';
    const color = c.color || '#ffffff';
    const tip = colorTooltip(c);
    const label = document.createElement('div');
    label.className = 'color-label';
    label.textContent = c.label;
    if (tip) label.title = tip;
    const checks = document.createElement('div');
    checks.className = 'checks';
    checks.innerHTML =
      '<label><input type="checkbox" data-bold="' + c.id + '"' + (c.bold ? ' checked' : '') + '/>粗体</label>' +
      '<label><input type="checkbox" data-italic="' + c.id + '"' + (c.italic ? ' checked' : '') + '/>斜体</label>';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.setAttribute('data-color-id', c.id);
    picker.value = color;
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.setAttribute('data-color-hex', c.id);
    hex.value = color;
    row.appendChild(label);
    row.appendChild(checks);
    row.appendChild(picker);
    row.appendChild(hex);
    body.appendChild(row);
  }
  root.querySelectorAll('[data-color-id]').forEach(el => {
    el.addEventListener('input', () => {
      const hex = root.querySelector('[data-color-hex="' + el.getAttribute('data-color-id') + '"]');
      if (hex) hex.value = el.value;
    });
  });
  root.querySelectorAll('[data-color-hex]').forEach(el => {
    el.addEventListener('change', () => {
      const picker = root.querySelector('[data-color-id="' + el.getAttribute('data-color-hex') + '"]');
      if (picker && /^#[0-9a-fA-F]{6}$/.test(el.value)) picker.value = el.value;
    });
  });
}

function collectColors() {
  return state.colors.map(c => {
    const colorEl = document.querySelector('[data-color-hex="' + c.id + '"]');
    const boldEl = document.querySelector('[data-bold="' + c.id + '"]');
    const italicEl = document.querySelector('[data-italic="' + c.id + '"]');
    return {
      ...c,
      color: colorEl ? colorEl.value : c.color,
      bold: boldEl ? boldEl.checked : !!c.bold,
      italic: italicEl ? italicEl.checked : !!c.italic
    };
  });
}

function render() {
  $('warn').classList.toggle('hidden', state.hasWorkspace);
  renderProjects();
  renderKeybindings();
  renderEffects();
  renderColors();
}

$('save-keyboard').addEventListener('click', () => {
  vscode.postMessage({ type: 'saveKeybindings', payload: collectKeybindings() });
});
$('reset-keyboard').addEventListener('click', () => vscode.postMessage({ type: 'resetKeybindings' }));
$('save-colors').addEventListener('click', () => {
  vscode.postMessage({
    type: 'saveColors',
    payload: {
      colors: collectColors(),
      visualEffect: collectVisualEffect(),
      opacities: collectVisualEffectOpacity()
    }
  });
});
$('reset-colors').addEventListener('click', () => vscode.postMessage({ type: 'resetColors' }));

document.addEventListener('click', () => closeAllSelects());
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'state') {
    const effects = state.visualEffects;
    state = msg;
    if (!state.visualEffects) state.visualEffects = effects;
    if (!state.visualEffectOpacity) state.visualEffectOpacity = ${JSON.stringify(DEFAULT_VISUAL_EFFECT_OPACITY)};
    if (!openProjectId && state.projects && state.projects[0]) openProjectId = state.projects[0].id;
    try {
      render();
    } catch (err) {
      const host = $('project-editor');
      if (host) host.textContent = '界面加载失败: ' + (err && err.message ? err.message : String(err));
    }
  } else if (msg.type === 'pathPicked') {
    const el = $(msg.field);
    if (el) el.value = msg.path;
  } else if (msg.type === 'compilersDetected') {
    state.compilers = msg.compilers || [];
    const body = document.querySelector('#project-editor .editor');
    if (body) mountCompilerSelect(body, body.dataset.projectId);
  } else if (msg.type === 'switchTab') {
    switchTab(msg.tab);
  }
});

try {
  render();
} catch (err) {
  const host = $('project-editor');
  if (host) host.textContent = '界面加载失败: ' + (err && err.message ? err.message : String(err));
}
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
