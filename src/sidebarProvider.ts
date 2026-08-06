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
  saveCppColors,
  saveKeybindings,
} from "./store";
import {
  detectCompilers,
  filterCompilers,
  getCachedCompilers,
  refreshCompilerCacheInBackground,
} from "./compilerDetect";
import {
  COMPILER_NAMES,
  CPP_COLOR_DEFS,
  DEFAULT_KEYBINDINGS,
  DEFAULT_PROJECT,
  KEYBINDING_DEFS,
  ProjectProperties,
} from "./types";

export class SmileSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "smile.sidebar";
  private view?: vscode.WebviewView;
  private projects: ProjectStateItem[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case "ready":
            await this.postState();
            break;
          case "saveProject": {
            const id = String(message.projectId || "");
            const project = this.projects.find((p) => p.id === id);
            if (!project) {
              throw new Error("未找到对应项目");
            }
            const info = saveProjectProps(project, message.payload as ProjectProperties);
            vscode.window.showInformationMessage(info);
            await this.postState();
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
            await this.postState();
            break;
          }
          case "saveColors": {
            const colors = message.payload as typeof CPP_COLOR_DEFS;
            await saveCppColors(colors);
            await applyCppColorsToVscode(colors);
            vscode.window.showInformationMessage(
              "C++ 颜色已写入当前主题配置，并清理了重复的 Smile 规则"
            );
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
              webviewView.webview.postMessage({
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
              webviewView.webview.postMessage({
                type: "pathPicked",
                field: message.field,
                path: uris[0].fsPath,
              });
            }
            break;
          }
          case "detectCompilers": {
            const all = detectCompilers(true);
            const kind = String(message.compilerName || "");
            const list = kind ? filterCompilers(all, kind) : all;
            if (!list.length) {
              vscode.window.showWarningMessage(
                kind
                  ? `未找到已安装的 ${kind}，请手动指定路径或安装 MinGW64 / Visual Studio。`
                  : "未找到已安装的编译器，请手动指定路径。"
              );
              webviewView.webview.postMessage({
                type: "compilersDetected",
                projectId: message.projectId,
                compilers: all,
              });
              break;
            }
            const picked = await vscode.window.showQuickPick(
              list.map((c) => ({
                label: c.label,
                description: c.name,
                detail: c.command || c.path,
                c,
              })),
              {
                title: kind ? `选择 ${kind}` : "选择已安装的编译器",
                placeHolder: "自动搜索到的编译器",
                matchOnDescription: true,
                matchOnDetail: true,
              }
            );
            if (picked) {
              webviewView.webview.postMessage({
                type: "compilerPicked",
                projectId: message.projectId,
                name: picked.c.name,
                path: picked.c.path,
              });
            }
            webviewView.webview.postMessage({
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
    });
  }

  refresh(): void {
    void this.postState();
  }

  focusTab(tab: string): void {
    void vscode.commands.executeCommand("smile.sidebar.focus");
    this.view?.webview.postMessage({ type: "switchTab", tab });
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }
    this.projects = await loadAllProjectStates();
    // 不在启动路径上同步扫描编译器（where/vswhere/version 很慢）
    this.view.webview.postMessage({
      type: "state",
      projects: this.projects,
      keybindings: loadKeybindings(),
      keybindingDefs: KEYBINDING_DEFS,
      colors: loadCppColors(),
      compilers: getCachedCompilers(),
      compilerNames: [...COMPILER_NAMES],
      hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length),
    });
    // 空闲时后台刷新缓存，不阻塞 UI
    void refreshCompilerCacheInBackground(this.view);
  }

  private getHtml(webview: vscode.Webview): string {
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
  --bg: var(--vscode-sideBar-background, #1a1d22);
  --fg: var(--vscode-foreground, #d6dbe3);
  --muted: var(--vscode-descriptionForeground, #8b93a1);
  --border: color-mix(in srgb, #13527f 35%, var(--vscode-panel-border, #333) 65%);
  --input-bg: var(--vscode-input-background, #2a2f38);
  --input-fg: var(--vscode-input-foreground, #d6dbe3);
  --input-border: var(--vscode-input-border, #3a4250);
  --btn-bg: #13527f;
  --btn-fg: #fff;
  --btn-hover: #1a6a9e;
  --sec-bg: var(--vscode-button-secondaryBackground, #2f3540);
  --sec-fg: var(--vscode-button-secondaryForeground, #fff);
  --active: #13527f;
  --active-fg: #fff;
  --hover: color-mix(in srgb, #13527f 22%, transparent);
  --focus: #f6c415;
  --blue: #13527f;
  --blue-bright: #2f8fc4;
  --amber: #f6c415;
  --amber-dim: #c49a12;
  --panel-bg: color-mix(in srgb, var(--bg) 88%, #0b1a28 12%);
  --dropdown-bg: var(--vscode-dropdown-background, var(--input-bg));
  --dropdown-fg: var(--vscode-dropdown-foreground, var(--input-fg));
  --dropdown-border: var(--vscode-dropdown-border, var(--input-border));
  --dropdown-list-bg: var(--vscode-dropdown-background, #252a33);
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; height: 100%;
  background: var(--bg); color: var(--fg);
  font-family: var(--vscode-font-family); font-size: 12px;
}
.app { display: flex; flex-direction: column; min-height: 100%; }
.brand {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  padding: 14px 10px 12px;
  border-bottom: 1px solid var(--border);
  background: #0b121a;
}
.logo {
  width: 52px; height: 52px; object-fit: contain;
  display: block;
}
.brand h1 {
  margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.1em;
  color: #fff; line-height: 1.1;
}
.tabs {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 0; border-bottom: 1px solid var(--border); background: #10161e;
}
.tab {
  appearance: none; border: none; border-bottom: 2px solid transparent;
  background: transparent; color: var(--muted);
  padding: 9px 4px; cursor: pointer; font: inherit; font-size: 11px;
}
.tab:hover { color: var(--fg); background: var(--hover); }
.tab.active {
  color: var(--fg); border-bottom-color: var(--amber);
  background: color-mix(in srgb, var(--blue) 18%, transparent);
}
.body { flex: 1; overflow: auto; padding: 10px; }
.page { display: none; }
.page.active { display: block; }
.editor { display: flex; flex-direction: column; gap: 8px; }
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
  border-bottom-color: var(--amber);
}
.sheet, .panel {
  border: none; border-radius: 0; background: transparent; padding: 0;
}
.group-title {
  margin: 0 0 8px; padding: 0 0 6px; border-bottom: 1px solid var(--border);
  color: var(--blue-bright); font-size: 12px; font-weight: 700;
}
.field { margin-bottom: 9px; }
.field > label {
  display: block; margin-bottom: 3px; color: var(--muted); font-size: 11px;
}
.row { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.row > input[type="text"] { flex: 1 1 120px; min-width: 0; }
input[type="text"], input[type="color"], textarea {
  width: 100%; background: var(--input-bg); color: var(--input-fg);
  border: 1px solid var(--input-border); border-radius: 3px;
  padding: 5px 7px; outline: none; font: inherit;
}
textarea { min-height: 56px; resize: vertical; }
input:focus, textarea:focus { border-color: var(--blue-bright); box-shadow: 0 0 0 1px color-mix(in srgb, var(--blue-bright) 40%, transparent); }
input[type="color"] { padding: 2px; height: 28px; max-width: 42px; }

.cselect { position: relative; width: 100%; }
.cselect-btn {
  width: 100%; text-align: left; appearance: none; cursor: pointer;
  background: var(--dropdown-bg); color: var(--dropdown-fg);
  border: 1px solid var(--dropdown-border); border-radius: 3px;
  padding: 5px 24px 5px 7px; font: inherit; position: relative;
}
.cselect-btn::after {
  content: ""; position: absolute; right: 8px; top: 50%;
  border: 4px solid transparent; border-top-color: var(--dropdown-fg);
  transform: translateY(-15%);
}
.cselect-btn:focus { outline: 1px solid var(--blue-bright); }
.cselect-menu {
  display: none; position: absolute; z-index: 50; left: 0; right: 0; top: calc(100% + 2px);
  max-height: 180px; overflow: auto;
  background: var(--dropdown-list-bg); color: var(--dropdown-fg);
  border: 1px solid var(--dropdown-border); border-radius: 3px;
  box-shadow: 0 8px 20px rgba(0,0,0,.45);
}
.cselect.open .cselect-menu { display: block; }
.cselect-option {
  padding: 6px 7px; cursor: pointer; color: var(--dropdown-fg);
  background: var(--dropdown-list-bg);
}
.cselect-option:hover, .cselect-option.active {
  background: var(--blue); color: #fff;
}

.btn {
  appearance: none; border: none; border-radius: 3px; cursor: pointer;
  padding: 6px 11px; background: var(--blue); color: #fff; font: inherit;
}
.btn:hover { background: var(--btn-hover); }
.btn.secondary { background: var(--sec-bg); color: var(--sec-fg); }
.btn.ghost {
  background: transparent; border: 1px solid var(--border); color: var(--fg); padding: 5px 8px;
}
.btn.ghost:hover { border-color: var(--blue-bright); color: var(--blue-bright); }
.btn.primary-amber { background: var(--amber); color: #1a1400; font-weight: 650; }
.btn.primary-amber:hover { filter: brightness(1.05); }
.actions {
  display: flex; gap: 8px; flex-wrap: wrap;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);
  position: sticky; bottom: 0; background: var(--bg); padding-bottom: 2px;
}
.hint { margin: 0 0 10px; color: var(--muted); line-height: 1.45; font-size: 11px; }
.warn {
  padding: 8px 10px; border-radius: 3px; margin-bottom: 10px;
  border: 1px solid color-mix(in srgb, var(--amber) 40%, var(--border));
  background: color-mix(in srgb, var(--amber) 10%, var(--bg));
  color: var(--fg);
}
.kb-row {
  display: grid; grid-template-columns: 1fr minmax(110px, 120px); gap: 8px;
  align-items: center; margin-bottom: 8px;
}
.kb-capture {
  appearance: none; border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg); color: var(--input-fg);
  padding: 6px 8px; font: inherit; cursor: pointer; text-align: center;
  min-height: 28px;
}
.kb-capture:hover { border-color: var(--blue-bright); }
.kb-capture.recording {
  border-color: var(--amber); color: var(--amber);
  box-shadow: 0 0 0 1px var(--amber);
}
.color-list { display: flex; flex-direction: column; gap: 10px; }
.color-group {
  border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--bg) 92%, #000 8%);
  overflow: hidden;
}
.color-cat {
  margin: 0; padding: 7px 10px;
  font-weight: 650; font-size: 11px; color: var(--muted);
  background: color-mix(in srgb, var(--bg) 70%, #000 30%);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}
.color-group-body { padding: 8px 10px 4px; }
.color-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto 40px 72px; gap: 6px;
  align-items: center; margin-bottom: 8px;
}
.color-label {
  font-weight: 650; cursor: default; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.color-label:hover { color: var(--fg); }
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
.project-bar { margin-bottom: 10px; }
.project-bar label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; }
.project-meta { margin: 6px 0 10px; color: var(--muted); font-size: 10px; word-break: break-all; }
#project-editor {
  border-top: 1px solid var(--border); padding-top: 8px;
}
</style>
</head>
<body>
<div class="app">
  <div class="brand">
    <img class="logo" src="${logoUri}" alt="Smile" />
    <h1>Smile</h1>
  </div>
  <div class="tabs">
    <button class="tab active" data-tab="project">项目</button>
    <button class="tab" data-tab="keyboard">键盘</button>
    <button class="tab" data-tab="colors">颜色</button>
  </div>
  <div class="body">
    <section class="page active" id="page-project">
      <div id="warn" class="warn hidden">需要先打开工作区文件夹才能保存项目属性。</div>
      <div class="project-bar">
        <label>当前项目</label>
        <div class="cselect" id="project-select"></div>
        <div class="project-meta" id="project-meta"></div>
      </div>
      <div id="project-editor"></div>
    </section>

    <section class="page" id="page-keyboard">
      <div class="panel">
        <h2 class="group-title">键盘设置</h2>
        <p class="hint">点击右侧，再按下快捷键。保存后写入用户 keybindings.json。</p>
        <div id="kb-list"></div>
        <div class="actions">
          <button class="btn primary-amber" id="save-keyboard">保存</button>
          <button class="btn secondary" id="reset-keyboard">恢复默认</button>
        </div>
      </div>
    </section>

    <section class="page" id="page-colors">
      <div class="panel">
        <h2 class="group-title">C++ 颜色</h2>
        <p class="hint">全局着色。保存后写入当前主题配置。</p>
        <div id="color-list"></div>
        <div class="actions">
          <button class="btn primary-amber" id="save-colors">应用</button>
          <button class="btn secondary" id="reset-colors">恢复默认</button>
        </div>
      </div>
    </section>
  </div>
</div>

<div class="modal-mask" id="cfg-mask">
  <div class="modal-card">
    <h3>配置管理器</h3>
    <p class="hint">添加或删除配置与平台组合。</p>
    <table class="cfg-table">
      <thead><tr><th>配置</th><th>平台</th><th></th></tr></thead>
      <tbody id="cfg-body"></tbody>
    </table>
    <div class="cfg-form">
      <input type="text" id="cfg-new-name" placeholder="新配置名，如 RelWithDebInfo" />
      <input type="text" id="cfg-new-platform" placeholder="平台，如 x64 / ARM64" />
      <button class="btn" id="cfg-add">添加</button>
    </div>
    <div class="actions">
      <button class="btn" id="cfg-ok">确定</button>
      <button class="btn secondary" id="cfg-cancel">取消</button>
    </div>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = {
  projects: [],
  keybindings: {},
  keybindingDefs: [],
  colors: [],
  compilers: [],
  compilerNames: ${JSON.stringify([...COMPILER_NAMES])},
  hasWorkspace: false
};
let draftConfigs = [];
let cfgTargetId = null;
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
function unique(arr) { return [...new Set(arr)]; }

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

function editorHtml(id) {
  return \`
  <div class="editor" data-project-id="\${id}">
    <div class="secbar" data-nav>
      <button type="button" class="active" data-section="compiler">编译器</button>
      <button type="button" data-section="configuration">配置</button>
      <button type="button" data-section="general">常规</button>
      <button type="button" data-section="advanced">高级</button>
      <button type="button" data-section="debug">调试</button>
      <button type="button" data-section="cpp">C++</button>
    </div>
    <div class="sheet">
      <div class="section" data-sec="compiler">
        <h2 class="group-title">编译器</h2>
        <p class="hint">MSVC / MinGW64。CMake 工程的构建目录取自「常规 → 输出目录」（默认 build-smile）。</p>
        <div class="field"><label>编译器</label>
          <div class="cselect" data-field="compiler.name" data-options='${JSON.stringify([...COMPILER_NAMES])}'></div>
        </div>
        <div class="field"><label>路径</label><div class="row">
          <input type="text" id="\${pid(id,'compiler.path')}" placeholder="MinGW 根目录、g++.exe 或 MSBuild.exe" />
          <button class="btn ghost" data-pick-file="\${pid(id,'compiler.path')}">文件</button>
          <button class="btn ghost" data-pick-folder="\${pid(id,'compiler.path')}">目录</button>
        </div></div>
        <div class="field">
          <button class="btn secondary" data-detect-compiler="\${id}">自动搜索</button>
        </div>
        <div class="field" data-detected-wrap>
          <label>检测到的安装</label>
          <div class="cselect" data-role="detected-compiler"></div>
        </div>
      </div>
      <div class="section hidden" data-sec="configuration">
        <h2 class="group-title">配置</h2>
        <div class="field"><label>配置</label><div class="cselect" data-field="configuration.config" data-role="config"></div></div>
        <div class="field"><label>平台</label><div class="cselect" data-field="configuration.platform" data-role="platform"></div></div>
        <div class="field">
          <button class="btn secondary" data-cfg-manager="\${id}">配置管理器…</button>
        </div>
      </div>
      <div class="section hidden" data-sec="general">
        <h2 class="group-title">常规</h2>
        <div class="field"><label>输出目录</label><input type="text" id="\${pid(id,'general.outputDirectory')}" /></div>
        <div class="field"><label>中间目录</label><input type="text" id="\${pid(id,'general.intermediateDirectory')}" /></div>
        <div class="field"><label>目标文件名</label><input type="text" id="\${pid(id,'general.targetFileName')}" /></div>
        <div class="field"><label>配置类型</label>
          <div class="cselect" data-field="general.configurationType" data-options='["应用程序 (.exe)","动态库 (.dll)","静态库 (.lib)","实用工具"]'></div>
        </div>
        <div class="field"><label>语言标准（C++）</label>
          <div class="cselect" data-field="general.languageStandard" data-options='["默认","C++14","C++17","C++20","C++23","最新"]'></div>
        </div>
      </div>
      <div class="section hidden" data-sec="advanced">
        <h2 class="group-title">高级</h2>
        <div class="field"><label>目标文件扩展名</label><input type="text" id="\${pid(id,'advanced.targetFileExtension')}" /></div>
        <div class="field"><label>MFC 的使用</label>
          <div class="cselect" data-field="advanced.mfcUsage" data-options='["使用标准 Windows 库","在静态库中使用 MFC","在共享 DLL 中使用 MFC"]'></div>
        </div>
        <div class="field"><label>字符集</label>
          <div class="cselect" data-field="advanced.characterSet" data-options='["Unicode","多字节字符集","未设置"]'></div>
        </div>
      </div>
      <div class="section hidden" data-sec="debug">
        <h2 class="group-title">调试</h2>
        <div class="field"><label>命令</label><div class="row">
          <input type="text" id="\${pid(id,'debug.command')}" />
          <button class="btn ghost" data-pick-file="\${pid(id,'debug.command')}">浏览</button>
        </div></div>
        <div class="field"><label>命令参数</label><input type="text" id="\${pid(id,'debug.commandArguments')}" /></div>
        <div class="field"><label>工作目录</label><div class="row">
          <input type="text" id="\${pid(id,'debug.workingDirectory')}" />
          <button class="btn ghost" data-pick-folder="\${pid(id,'debug.workingDirectory')}">浏览</button>
        </div></div>
      </div>
      <div class="section hidden" data-sec="cpp">
        <h2 class="group-title">C++</h2>
        <p class="hint">多项用分号分隔。</p>
        <div class="field"><label>附加包含目录</label><textarea id="\${pid(id,'cpp.additionalIncludeDirectories')}"></textarea></div>
        <div class="field"><label>附加库目录</label><textarea id="\${pid(id,'cpp.additionalLibraryDirectories')}"></textarea></div>
        <div class="field"><label>附加依赖项</label><textarea id="\${pid(id,'cpp.additionalDependencies')}"></textarea></div>
        <div class="field"><label>预处理器</label><textarea id="\${pid(id,'cpp.preprocessorDefinitions')}"></textarea></div>
        <div class="field"><label>预编译头</label>
          <div class="cselect" data-field="cpp.precompiledHeader" data-options='["使用","创建","不使用"]'></div>
        </div>
        <div class="field" data-pch-file>
          <label>预编译头文件</label>
          <input type="text" id="\${pid(id,'cpp.precompiledHeaderFile')}" placeholder="pch.h / stdafx.h" />
        </div>
      </div>
      <div class="actions">
        <button class="btn primary-amber" data-save="\${id}">保存</button>
        <button class="btn secondary" data-reset="\${id}">恢复默认</button>
      </div>
    </div>
  </div>\`;
}

function bindEditor(root, project) {
  const id = project.id;
  const props = project.props;
  root.querySelectorAll('.secbar button').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.secbar button').forEach(b => b.classList.remove('active'));
      root.querySelectorAll('[data-sec]').forEach(s => s.classList.add('hidden'));
      btn.classList.add('active');
      root.querySelector('[data-sec="' + btn.dataset.section + '"]').classList.remove('hidden');
    });
  });

  const textIds = [
    'compiler.path','general.outputDirectory','general.intermediateDirectory','general.targetFileName',
    'advanced.targetFileExtension','debug.command','debug.commandArguments','debug.workingDirectory',
    'cpp.additionalIncludeDirectories','cpp.additionalLibraryDirectories','cpp.additionalDependencies',
    'cpp.preprocessorDefinitions','cpp.precompiledHeaderFile'
  ];
  for (const field of textIds) {
    const el = $(pid(id, field));
    if (el) el.value = getDeep(props, field) ?? '';
  }

  root.querySelectorAll('.cselect[data-options]').forEach(el => {
    const options = JSON.parse(el.getAttribute('data-options'));
    const val = getDeep(props, el.dataset.field);
    mountSelect(el, options, val || options[0], (v) => {
      if (el.dataset.field === 'cpp.precompiledHeader') {
        const pch = root.querySelector('[data-pch-file]');
        if (pch) pch.classList.toggle('hidden', !(v === '使用' || v === '创建'));
      }
      if (el.dataset.field === 'compiler.name') {
        applyCompilerName(root, id, v);
      }
    });
  });

  // 初次加载：若已存路径与编译器类型不一致，纠正为检测到的匹配项
  applyCompilerName(root, id, props.compiler.name, { keepPathIfCompatible: true });
  root.querySelector('[data-detect-compiler]')?.addEventListener('click', () => {
    const nameEl = root.querySelector('.cselect[data-field="compiler.name"]');
    const compilerName = nameEl?.dataset.value || nameEl?.querySelector('.cselect-btn')?.textContent || '';
    vscode.postMessage({ type: 'detectCompilers', projectId: id, compilerName });
  });

  const configs = props.configuration.configurations || [];
  const names = unique(configs.map(c => c.name));
  const platforms = unique(configs.map(c => c.platform));
  const configEl = root.querySelector('[data-role="config"]');
  const platEl = root.querySelector('[data-role="platform"]');
  mountSelect(configEl, names, props.configuration.config);
  mountSelect(platEl, platforms, props.configuration.platform);

  const pchVal = props.cpp.precompiledHeader;
  const pch = root.querySelector('[data-pch-file]');
  if (pch) pch.classList.toggle('hidden', !(pchVal === '使用' || pchVal === '创建'));

  root.querySelectorAll('[data-pick-file]').forEach(btn => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'pickFile', field: btn.getAttribute('data-pick-file') }));
  });
  root.querySelectorAll('[data-pick-folder]').forEach(btn => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'pickFolder', field: btn.getAttribute('data-pick-folder') }));
  });
  root.querySelector('[data-save]').addEventListener('click', () => {
    vscode.postMessage({ type: 'saveProject', projectId: id, payload: collectEditor(root, props) });
  });
  root.querySelector('[data-reset]').addEventListener('click', () => {
    vscode.postMessage({ type: 'resetProject', projectId: id });
  });
  root.querySelector('[data-cfg-manager]').addEventListener('click', () => {
    cfgTargetId = id;
    draftConfigs = JSON.parse(JSON.stringify(props.configuration.configurations || []));
    renderCfgTable();
    $('cfg-mask').classList.add('show');
  });
}

function compilersForName(compilerName) {
  const n = (compilerName || '').toLowerCase();
  return (state.compilers || []).filter(c => {
    if (n.includes('mingw')) return c.kind === 'mingw64' || c.name === 'MinGW64';
    if (n.includes('msvc')) return c.kind === 'msvc' || c.name === 'MSVC';
    return c.name === 'MSVC' || c.name === 'MinGW64';
  });
}

function pathMatchesCompiler(pathValue, compilerName) {
  const p = (pathValue || '').toLowerCase();
  const n = (compilerName || '').toLowerCase();
  if (!p || !n) return true;
  if (n.includes('mingw')) {
    const looksGnu = p.includes('mingw') || p.includes('msys') || p.includes('g++') || p.includes('ucrt64');
    const looksMsvc = p.includes('msbuild') || p.endsWith('cl.exe');
    return looksGnu && !looksMsvc;
  }
  if (n.includes('msvc')) {
    return p.includes('msbuild') || p.endsWith('cl.exe') || p.includes('visual studio') || p.includes('msvc');
  }
  return true;
}

/** 切换编译器类型时：刷新检测列表，并自动填入匹配路径 */
function applyCompilerName(root, id, compilerName, opts) {
  const keepPathIfCompatible = opts && opts.keepPathIfCompatible;
  const pathEl = $(pid(id, 'compiler.path'));
  const list = compilersForName(compilerName);
  const current = pathEl?.value || '';
  const compatible = keepPathIfCompatible && pathMatchesCompiler(current, compilerName);
  if (pathEl && !compatible) {
    pathEl.value = list[0]?.path || '';
  }
  refreshDetectedSelect(root, id, compilerName);
}

function refreshDetectedSelect(root, id, compilerName) {
  const el = root.querySelector('[data-role="detected-compiler"]');
  if (!el) return;
  const list = compilersForName(compilerName);
  const labels = list.length ? list.map(c => c.label) : ['（未检测到，请点自动搜索或手动浏览）'];
  const currentPath = $(pid(id, 'compiler.path'))?.value || '';
  const selected = list.find(c => c.path === currentPath)?.label || labels[0];
  mountSelect(el, labels, selected, (label) => {
    const hit = list.find(c => c.label === label);
    if (!hit) return;
    const pathEl = $(pid(id, 'compiler.path'));
    if (pathEl) pathEl.value = hit.path;
    const nameEl = root.querySelector('.cselect[data-field="compiler.name"]');
    if (nameEl && nameEl._setOptions) {
      const names = state.compilerNames || ${JSON.stringify([...COMPILER_NAMES])};
      nameEl._setOptions(names, hit.name);
    } else if (nameEl) {
      nameEl.dataset.value = hit.name;
      const btn = nameEl.querySelector('.cselect-btn');
      if (btn) btn.textContent = hit.name;
    }
  });
}

function collectEditor(root, baseProps) {
  const project = JSON.parse(JSON.stringify(baseProps));
  const id = root.dataset.projectId || root.closest('[data-project-id]')?.dataset.projectId;
  const textIds = [
    'compiler.path','general.outputDirectory','general.intermediateDirectory','general.targetFileName',
    'advanced.targetFileExtension','debug.command','debug.commandArguments','debug.workingDirectory',
    'cpp.additionalIncludeDirectories','cpp.additionalLibraryDirectories','cpp.additionalDependencies',
    'cpp.preprocessorDefinitions','cpp.precompiledHeaderFile'
  ];
  for (const field of textIds) {
    const el = $(pid(id, field));
    if (el) setDeep(project, field, el.value);
  }
  root.querySelectorAll('.cselect[data-field]').forEach(el => {
    setDeep(project, el.dataset.field, el.dataset.value || el.querySelector('.cselect-btn')?.textContent || '');
  });
  return project;
}

function showProjectEditor(project) {
  const host = $('project-editor');
  const meta = $('project-meta');
  if (!project) {
    host.innerHTML = '';
    if (meta) meta.textContent = '';
    return;
  }
  openProjectId = project.id;
  if (meta) {
    meta.textContent = project.sourceLabel + ' · ' + project.relativePath +
      (project.hasExistingProps ? ' · 已读取现有属性' : ' · 使用默认属性');
  }
  host.innerHTML = editorHtml(project.id);
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
    host.innerHTML = '<p class="hint">未发现项目。打开含 .vcxproj / CMakeLists.txt 的文件夹后重试。</p>';
    if ($('project-meta')) $('project-meta').textContent = '';
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
  if (/^F\d{1,2}$/i.test(e.key)) return e.key.toUpperCase();
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

function renderColors() {
  const root = $('color-list');
  root.className = 'color-list';
  root.innerHTML = '';
  let lastCat = '';
  let body = null;
  for (const c of state.colors) {
    if (c.category !== lastCat) {
      lastCat = c.category;
      const group = document.createElement('section');
      group.className = 'color-group';
      const h = document.createElement('div');
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

function renderCfgTable() {
  const body = $('cfg-body');
  body.innerHTML = '';
  for (let i = 0; i < draftConfigs.length; i++) {
    const c = draftConfigs[i];
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + c.name + '</td><td>' + c.platform + '</td><td><button class="btn ghost" data-del="' + i + '">删除</button></td>';
    body.appendChild(tr);
  }
  body.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      draftConfigs.splice(Number(btn.getAttribute('data-del')), 1);
      renderCfgTable();
    });
  });
}

function render() {
  $('warn').classList.toggle('hidden', state.hasWorkspace);
  renderProjects();
  renderKeybindings();
  renderColors();
}

$('save-keyboard').addEventListener('click', () => {
  vscode.postMessage({ type: 'saveKeybindings', payload: collectKeybindings() });
});
$('reset-keyboard').addEventListener('click', () => vscode.postMessage({ type: 'resetKeybindings' }));
$('save-colors').addEventListener('click', () => {
  vscode.postMessage({ type: 'saveColors', payload: collectColors() });
});
$('reset-colors').addEventListener('click', () => vscode.postMessage({ type: 'resetColors' }));

$('cfg-cancel').addEventListener('click', () => $('cfg-mask').classList.remove('show'));
$('cfg-add').addEventListener('click', () => {
  const name = $('cfg-new-name').value.trim();
  const platform = $('cfg-new-platform').value.trim();
  if (!name || !platform) return;
  if (!draftConfigs.some(c => c.name === name && c.platform === platform)) {
    draftConfigs.push({ name, platform });
    renderCfgTable();
  }
  $('cfg-new-name').value = '';
});
$('cfg-ok').addEventListener('click', () => {
  if (!draftConfigs.length || !cfgTargetId) return;
  const proj = state.projects.find(p => p.id === cfgTargetId);
  if (!proj) return;
  proj.props.configuration.configurations = draftConfigs;
  if (!draftConfigs.some(c => c.name === proj.props.configuration.config && c.platform === proj.props.configuration.platform)) {
    proj.props.configuration.config = draftConfigs[0].name;
    proj.props.configuration.platform = draftConfigs[0].platform;
  }
  openProjectId = cfgTargetId;
  $('cfg-mask').classList.remove('show');
  renderProjects();
});

document.addEventListener('click', () => closeAllSelects());
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'state') {
    state = msg;
    if (!openProjectId && state.projects && state.projects[0]) openProjectId = state.projects[0].id;
    render();
  } else if (msg.type === 'pathPicked') {
    const el = $(msg.field);
    if (el) el.value = msg.path;
  } else if (msg.type === 'compilersDetected') {
    state.compilers = msg.compilers || [];
    const body = document.querySelector('#project-editor .editor');
    if (body) {
      const nameEl = body.querySelector('.cselect[data-field="compiler.name"]');
      const name = nameEl?.dataset.value || nameEl?.querySelector('.cselect-btn')?.textContent || '';
      applyCompilerName(body, body.dataset.projectId, name, { keepPathIfCompatible: true });
    }
  } else if (msg.type === 'compilerPicked') {
    const body = document.querySelector('#project-editor .editor[data-project-id="' + msg.projectId + '"]')
      || document.querySelector('#project-editor .editor');
    if (!body) return;
    const pathEl = $(pid(msg.projectId, 'compiler.path'));
    if (pathEl) pathEl.value = msg.path || '';
    const nameEl = body.querySelector('.cselect[data-field="compiler.name"]');
    if (nameEl) {
      nameEl.dataset.value = msg.name;
      const btn = nameEl.querySelector('.cselect-btn');
      if (btn) btn.textContent = msg.name;
      if (nameEl._setOptions) nameEl._setOptions(state.compilerNames || [], msg.name);
    }
    refreshDetectedSelect(body, msg.projectId, msg.name);
  } else if (msg.type === 'switchTab') {
    switchTab(msg.tab);
  }
});

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
