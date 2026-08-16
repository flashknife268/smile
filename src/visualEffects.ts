import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import * as vscode from "vscode";
import { applyDarkModernEditorBackground } from "./store";
import { VisualEffectId, VisualEffectOpacityMap, DEFAULT_VISUAL_EFFECT_OPACITY } from "./types";

const MARK_START = "<!-- SMILE-VISUAL-START -->";
const MARK_END = "<!-- SMILE-VISUAL-END -->";
const JS_NAME = "smile-visual.js";
const BACKUP_KEY = "smile.visualEffectBackup";
const MENU_STYLE_BACKUP_KEY = "smile.menuStyleBackup";
const GPU_BACKUP_KEY = "smile.terminalGpuBackup";
const NOTEPADS_TINT_MIN = 0.22;
const MENU_PANEL_ALPHA = 0.88;
const ELECTRON_START = "/* SMILE-ELECTRON-START */";
const ELECTRON_END = "/* SMILE-ELECTRON-END */";
const ELECTRON_HOOK_RE = /\n?\/\* SMILE-ELECTRON-START \*\/[\s\S]*?\/\* SMILE-ELECTRON-END \*\//;
const RUNTIME_NAME = "smile-runtime.mjs";
const ELECTRON_OPT_RE =
  /(?:frame:false,transparent:(?:true|false),)?backgroundMaterial:"(?:acrylic|mica|tabbed)",(?:backgroundColor:"#00000000",)?experimentalDarkMode/g;
const STICKY_SCROLL_MIN_OPACITY = 0.75;

const TRANSPARENT_BG_KEYS = [
  "editorPane.background",
  "editorGutter.background",
  "editorGroupHeader.tabsBackground",
  "editorGroupHeader.noTabsBackground",
  "sideBar.background",
  "sideBarTitle.background",
  "sideBarSectionHeader.background",
  "titleBar.activeBackground",
  "titleBar.inactiveBackground",
  "statusBar.background",
  "statusBar.noFolderBackground",
  "panel.background",
  "panelSection.background",
  "tab.activeBackground",
  "tab.unfocusedActiveBackground",
  "breadcrumb.background",
  "terminal.background",
  "welcomePage.background",
  "walkThrough.embeddedEditorBackground",
] as const;

const SEMITRANSPARENT_BG_KEYS = [
  "editor.background",
  "activityBar.background",
  "tab.inactiveBackground",
  "tab.unfocusedInactiveBackground",
] as const;

const STICKY_SCROLL_BG_KEYS = [
  "editorStickyScroll.background",
  "editorStickyScrollGutter.background",
  "sideBarStickyScroll.background",
  "panelStickyScroll.background",
  "terminalStickyScroll.background",
] as const;

const OPAQUE_BG_KEYS = [
  "inlineChat.background",
  "editorWidget.background",
  "editorHoverWidget.background",
  "editorHoverWidget.statusBarBackground",
  "editorSuggestWidget.background",
  "editorMarkerNavigation.background",
  "peekViewEditor.background",
  "peekViewEditorGutter.background",
  "peekViewResult.background",
  "peekViewTitle.background",
  "notifications.background",
  "notificationCenterHeader.background",
  "quickInput.background",
  "input.background",
] as const;

const MENU_BG_KEYS = [
  "menu.background",
  "dropdown.background",
  "dropdown.listBackground",
] as const;

const ALL_EFFECT_KEYS = [
  ...TRANSPARENT_BG_KEYS,
  ...SEMITRANSPARENT_BG_KEYS,
  ...STICKY_SCROLL_BG_KEYS,
  ...OPAQUE_BG_KEYS,
  ...MENU_BG_KEYS,
] as const;

export type ApplyVisualEffectOptions = {
  reload?: boolean;
  opacity?: VisualEffectOpacityMap;
};

let globalState: vscode.Memento | undefined;
let extensionPath: string | undefined;

export function initVisualEffects(state: vscode.Memento, extPath?: string): void {
  globalState = state;
  if (extPath) {
    extensionPath = extPath;
  }
}

function clone<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function opacityOf(effect: "acrylic", map?: VisualEffectOpacityMap): number {
  return clampOpacity((map ?? DEFAULT_VISUAL_EFFECT_OPACITY)[effect]);
}

function materialOf(_effect: "acrylic"): "acrylic" {
  return "acrylic";
}

type EffectColorBackup = {
  root: Record<string, string | undefined>;
  themes: Record<string, Record<string, string | undefined>>;
};

function isOurAlphaColor(value: unknown): boolean {
  return typeof value === "string" && /#[0-9a-fA-F]{8}$/.test(value);
}

function originalColor(value: unknown): string | undefined {
  return typeof value === "string" && value && !isOurAlphaColor(value) ? value : undefined;
}

function isStructuredBackup(value: unknown): value is EffectColorBackup {
  return (
    !!value &&
    typeof value === "object" &&
    "root" in value &&
    "themes" in value &&
    typeof (value as EffectColorBackup).root === "object" &&
    typeof (value as EffectColorBackup).themes === "object"
  );
}

function readColorBackup(): EffectColorBackup {
  const raw = globalState?.get<unknown>(BACKUP_KEY);
  if (isStructuredBackup(raw)) {
    return { root: { ...raw.root }, themes: clone(raw.themes) ?? {} };
  }
  if (raw && typeof raw === "object") {
    return { root: { ...(raw as Record<string, string | undefined>) }, themes: {} };
  }
  return { root: {}, themes: {} };
}

function snapshotColorBackup(global: Record<string, unknown>): EffectColorBackup {
  const backup = readColorBackup();
  for (const key of ALL_EFFECT_KEYS) {
    if (key in backup.root) {
      continue;
    }
    backup.root[key] = originalColor(global[key]);
  }
  for (const [bucketKey, value] of Object.entries(global)) {
    if (!bucketKey.startsWith("[") || typeof value !== "object" || !value || backup.themes[bucketKey]) {
      continue;
    }
    const bucket = value as Record<string, unknown>;
    const snap: Record<string, string | undefined> = {};
    for (const colorKey of ALL_EFFECT_KEYS) {
      snap[colorKey] = originalColor(bucket[colorKey]);
    }
    backup.themes[bucketKey] = snap;
  }
  return backup;
}

function restoreColorKey(
  target: Record<string, unknown>,
  key: string,
  original: string | undefined
): boolean {
  const restoreTo = originalColor(original);
  if (!restoreTo) {
    if (key in target) {
      delete target[key];
      return true;
    }
    return false;
  }
  if (target[key] !== restoreTo) {
    target[key] = restoreTo;
    return true;
  }
  return false;
}

function addRoot(roots: string[], value?: string): void {
  if (!value) {
    return;
  }
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved) && !roots.includes(resolved)) {
    roots.push(resolved);
  }
}

function addInstallAppRoots(roots: string[], installDir?: string): void {
  if (!installDir || !fs.existsSync(installDir)) {
    return;
  }
  addRoot(roots, path.join(installDir, "resources", "app"));
  try {
    for (const entry of fs.readdirSync(installDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        addRoot(roots, path.join(installDir, entry.name, "resources", "app"));
      }
    }
  } catch {
    // ignore
  }
}

function findAppRootFrom(start?: string): string | undefined {
  if (!start) {
    return undefined;
  }
  let dir = path.resolve(fs.existsSync(start) && fs.statSync(start).isFile() ? path.dirname(start) : start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "product.json")) && fs.existsSync(path.join(dir, "out"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

function appRoots(): string[] {
  const roots: string[] = [];
  addRoot(roots, vscode.env.appRoot);
  addRoot(roots, findAppRootFrom(vscode.env.appRoot));
  addRoot(roots, findAppRootFrom(process.execPath));
  addRoot(roots, path.join(path.dirname(process.execPath), "resources", "app"));
  addInstallAppRoots(roots, path.dirname(process.execPath));
  const local = process.env.LOCALAPPDATA;
  if (local) {
    addInstallAppRoots(roots, path.join(local, "Programs", "Microsoft VS Code"));
    addInstallAppRoots(roots, path.join(local, "Programs", "Microsoft VS Code Insiders"));
  }
  addInstallAppRoots(roots, "C:\\Program Files\\Microsoft VS Code");
  addInstallAppRoots(roots, "E:\\software\\Microsoft VS Code");
  addInstallAppRoots(roots, "E:\\software\\cursor");
  addInstallAppRoots(roots, "D:\\software\\Microsoft VS Code");
  return roots;
}

function walkHtml(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || !fs.existsSync(dir)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkHtml(full, depth - 1, out);
    } else if (
      entry.isFile() &&
      /^workbench.*\.html$/i.test(entry.name) &&
      dir.toLowerCase().includes("workbench") &&
      !out.includes(full)
    ) {
      out.push(full);
    }
  }
}

function findWorkbenchHtmls(): string[] {
  const found: string[] = [];
  const rels = [
    ["out", "vs", "code", "electron-sandbox", "workbench", "workbench.html"],
    ["out", "vs", "code", "electron-sandbox", "workbench", "workbench.esm.html"],
    ["out", "vs", "code", "electron-browser", "workbench", "workbench.html"],
  ];
  for (const root of appRoots()) {
    for (const rel of rels) {
      const full = path.join(root, ...rel);
      if (fs.existsSync(full) && !found.includes(full)) {
        found.push(full);
      }
    }
    walkHtml(path.join(root, "out", "vs", "code"), 5, found);
  }
  return found;
}

function findElectronMains(): string[] {
  const found: string[] = [];
  const rels = [
    ["out", "main.js"],
    ["out", "vs", "code", "electron-main", "main.js"],
  ];
  for (const root of appRoots()) {
    for (const rel of rels) {
      const full = path.join(root, ...rel);
      if (fs.existsSync(full) && !found.includes(full)) {
        found.push(full);
      }
    }
  }
  return found;
}

function stripInjected(html: string): string {
  const start = html.indexOf(MARK_START);
  const end = html.indexOf(MARK_END);
  if (start >= 0 && end > start) {
    return html.slice(0, start) + html.slice(end + MARK_END.length);
  }
  return html;
}

function upsertScriptTag(html: string): string {
  const cleaned = stripInjected(html).replace(/\s+$/, "\n");
  const block = `${MARK_START}\n<script src="./${JS_NAME}"></script>\n${MARK_END}`;
  if (cleaned.includes("</html>")) {
    return cleaned.replace("</html>", `${block}\n</html>`);
  }
  return `${cleaned}\n${block}\n`;
}

function parseHexRgb(color: string): { r: number; g: number; b: number } | undefined {
  const raw = color.trim();
  const hex = raw.match(/^#([0-9a-f]{3,8})$/i);
  if (!hex) {
    return undefined;
  }
  let h = hex[1];
  if (h.length === 3 || h.length === 4) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  } else if (h.length === 8) {
    h = h.slice(0, 6);
  }
  if (h.length !== 6) {
    return undefined;
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function extractBaseColor(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const rgb = parseHexRgb(value);
  if (!rgb) {
    return undefined;
  }
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

function computeTransparentHex(base: string, opacity: number): string {
  const hex = extractBaseColor(base.startsWith("#") ? base : `#${base}`) ?? "1e1e1e";
  const a = Math.round(Math.min(1, Math.max(0, opacity)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${hex}${a}`;
}

function htmlOpacityOf(slider: number): number {
  const tint = clampOpacity(slider) / 100;
  return (1 - NOTEPADS_TINT_MIN) * tint + NOTEPADS_TINT_MIN;
}

function menuOverlayOf(_slider: number): number {
  return MENU_PANEL_ALPHA;
}

function widgetOverlayOf(slider: number): number {
  return Math.min(0.82, htmlOpacityOf(slider) + 0.14);
}

function themeBackgroundHex(): string {
  const colors = readActiveThemeColors();
  return extractBaseColor(colors["editor.background"]) ?? extractBaseColor(fallbackBackground()) ?? "1e1e1e";
}

function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function loadThemeFile(filePath: string, seen: Set<string>): Record<string, string> {
  if (seen.has(filePath) || !fs.existsSync(filePath)) {
    return {};
  }
  seen.add(filePath);
  const data = parseJsonc(fs.readFileSync(filePath, "utf8"));
  const colors: Record<string, string> = {};
  if (typeof data.include === "string") {
    Object.assign(colors, loadThemeFile(path.resolve(path.dirname(filePath), data.include), seen));
  }
  if (data.colors && typeof data.colors === "object") {
    for (const [key, value] of Object.entries(data.colors as Record<string, unknown>)) {
      if (typeof value === "string") {
        colors[key] = value;
      }
    }
  }
  return colors;
}

function readActiveThemeColors(): Record<string, string> {
  const themeName = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ?? "";
  for (const ext of vscode.extensions.all) {
    const themes = ext.packageJSON?.contributes?.themes as
      | { label?: string; id?: string; path?: string }[]
      | undefined;
    if (!themes) {
      continue;
    }
    for (const theme of themes) {
      if ((theme.label !== themeName && theme.id !== themeName) || !theme.path) {
        continue;
      }
      return loadThemeFile(path.join(ext.extensionPath, theme.path), new Set());
    }
  }
  return {};
}

function fallbackBackground(): string {
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight) {
    return "#ffffff";
  }
  return "#1e1e1e";
}

function baseColorOf(
  key: string,
  backup: Record<string, string | undefined>,
  themeColors: Record<string, string>,
  fallback: string
): string {
  const fromBackup = backup[key];
  if (typeof fromBackup === "string" && parseHexRgb(fromBackup)) {
    return fromBackup;
  }
  if (themeColors[key] && parseHexRgb(themeColors[key])) {
    return themeColors[key];
  }
  return fallback;
}

async function applyAllBackgroundColors(_effect: "acrylic", opacity: number): Promise<void> {
  const inspect = vscode.workspace
    .getConfiguration("workbench")
    .inspect<Record<string, unknown>>("colorCustomizations");
  const global = clone(inspect?.globalValue ?? {}) as Record<string, unknown>;
  const backup = snapshotColorBackup(global);
  await globalState?.update(BACKUP_KEY, backup);
  const themeColors = readActiveThemeColors();
  const fallback = fallbackBackground();
  const themeBackground = themeBackgroundHex();
  const editorTint = editorTintHex(themeBackground);
  const htmlOpacity = htmlOpacityOf(opacity);
  const sticky = Math.max(htmlOpacity, STICKY_SCROLL_MIN_OPACITY);
  const colors: Record<string, string> = {};
  for (const key of TRANSPARENT_BG_KEYS) {
    const base = extractBaseColor(baseColorOf(key, backup.root, themeColors, fallback)) ?? themeBackground;
    colors[key] = `#${base}00`;
  }
  for (const key of SEMITRANSPARENT_BG_KEYS) {
    const base =
      key === "editor.background"
        ? editorTint
        : extractBaseColor(baseColorOf(key, backup.root, themeColors, fallback)) ?? themeBackground;
    colors[key] = computeTransparentHex(base, htmlOpacity);
  }
  for (const key of STICKY_SCROLL_BG_KEYS) {
    const base = key.startsWith("editorStickyScroll")
      ? editorTint
      : extractBaseColor(baseColorOf(key, backup.root, themeColors, fallback)) ?? themeBackground;
    colors[key] = computeTransparentHex(base, sticky);
  }
  const widgetTint = rgbToHex(themeRgb());
  for (const key of MENU_BG_KEYS) {
    colors[key] = computeTransparentHex(widgetTint, menuOverlayOf(opacity));
  }
  const widgetAlpha = widgetOverlayOf(opacity);
  for (const key of OPAQUE_BG_KEYS) {
    colors[key] = computeTransparentHex(widgetTint, widgetAlpha);
  }
  colors["terminal.background"] = "#00000000";
  Object.assign(global, colors);
  const themeName = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
  if (themeName) {
    const bucketKey = `[${themeName}]`;
    const bucket = clone((global[bucketKey] as Record<string, unknown>) ?? {});
    Object.assign(bucket, colors);
    global[bucketKey] = bucket;
  }
  await vscode.workspace
    .getConfiguration("workbench")
    .update("colorCustomizations", global, vscode.ConfigurationTarget.Global);
}

function themeRgb(): { r: number; g: number; b: number } {
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight) {
    return { r: 240, g: 240, b: 240 };
  }
  return { r: 0, g: 0, b: 0 };
}

function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

function isDarkModernTheme(): boolean {
  const name = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ?? "";
  return /dark modern/i.test(name);
}

function editorTintHex(themeBackground: string): string {
  if (isDarkModernTheme()) {
    return rgbToHex(themeRgb());
  }
  return themeBackground;
}

function themeCss(opacity: number): string {
  const rgb = themeRgb();
  const htmlOpacity = htmlOpacityOf(opacity).toFixed(3);
  const tint = `rgba(${rgb.r},${rgb.g},${rgb.b},0.3)`;
  const widgetBg = `rgba(${rgb.r},${rgb.g},${rgb.b},${widgetOverlayOf(opacity).toFixed(3)})`;
  const menuBg = `rgba(${rgb.r},${rgb.g},${rgb.b},${menuOverlayOf(opacity).toFixed(3)})`;
  return [
    `html{background:rgba(${rgb.r},${rgb.g},${rgb.b},${htmlOpacity})!important;}`,
    "body,.monaco-workbench,.monaco-workbench .part,.monaco-workbench .part.editor,.monaco-workbench .part.activitybar,.monaco-workbench .part.panel,.monaco-workbench .part.titlebar,.monaco-workbench .part.statusbar,.monaco-workbench .part:not(.modal-editor-part)>.content,.monaco-workbench .part>.title,.editor-container:not(.modal-editor-part .editor-container),.monaco-editor-background,.monaco-editor .margin,.monaco-editor .overflow-guard,.monaco-editor,.monaco-editor .inputarea.ime-input,.monaco-list .monaco-list-rows,.editor-group-container,.editor-group-container>.tabs,.editor-group-container>.tabs .tab,.terminal-outer-container,.xterm-viewport,.xterm-rows,.margin-view-overlays,.notebookOverlay.notebook-editor{background:transparent!important;background-color:transparent!important;}",
    ".monaco-workbench .part.sidebar,.monaco-workbench .part.sidebar>.content,.monaco-workbench .part.sidebar .monaco-pane-view,.monaco-workbench .part.sidebar .pane,.monaco-workbench .part.sidebar .pane>.pane-header{background:transparent!important;background-color:transparent!important;}",
    ".minimap,.editor-scrollable>.decorationsOverviewRuler{opacity:0.8;}",
    `.monaco-editor .view-overlays .current-line{border-color:rgba(${rgb.r},${rgb.g},${rgb.b},0.2)!important;}`,
    `.editor-group-container>.tabs .tab.active,.editor-group-container>.tabs .monaco-breadcrumbs{background-color:${tint}!important;}`,
    ".monaco-workbench.floating-panels,.monaco-workbench.floating-panels>.monaco-grid-view,.monaco-workbench.floating-panels .part.auxiliarybar,.monaco-workbench.floating-panels .part.panel{background:transparent!important;}",
    ".monaco-workbench.floating-panels .part.sidebar,.monaco-workbench.floating-panels .part.sidebar>.content{background:transparent!important;background-color:transparent!important;}",
    ".monaco-workbench.style-override .monaco-pane-view .pane,.monaco-workbench.style-override .monaco-pane-view .pane>.pane-header{background:transparent!important;}",
    ".monaco-workbench .part::before,.monaco-workbench .editor-group-container::before,.monaco-workbench .tabs-container::before,.monaco-workbench .monaco-editor::before{content:none!important;display:none!important;}",
    ".monaco-workbench webview,.monaco-workbench .webview,.monaco-workbench iframe{pointer-events:auto!important;}",
    `:root{${isDarkModernTheme() ? `--vscode-editor-background:rgba(${rgb.r},${rgb.g},${rgb.b},${htmlOpacity})!important;` : ""}--vscode-sideBar-background:transparent!important;--vscode-sideBarTitle-background:transparent!important;--vscode-sideBarSectionHeader-background:transparent!important;--vscode-menu-background:${menuBg}!important;--vscode-dropdown-background:${menuBg}!important;--vscode-dropdown-listBackground:${menuBg}!important;--vscode-quickInput-background:${widgetBg}!important;--vscode-editorSuggestWidget-background:${widgetBg}!important;--vscode-editorHoverWidget-background:${widgetBg}!important;--vscode-editorWidget-background:${widgetBg}!important;--vscode-peekViewEditor-background:${widgetBg}!important;--vscode-peekViewResult-background:${widgetBg}!important;--vscode-peekViewTitle-background:${widgetBg}!important;}`,
    ".monaco-menu,.monaco-menu .monaco-action-bar,.monaco-menu .actions-container,.monaco-menu-container .monaco-scrollable-element,.menubar-menu-items-holder .monaco-scrollable-element,.monaco-submenu .monaco-scrollable-element,.context-view .monaco-scrollable-element{background:transparent!important;background-color:transparent!important;}",
    `.context-view:has(.monaco-menu),.monaco-menu-container:has(.monaco-menu),.menubar-menu-items-holder:has(.monaco-menu),.monaco-submenu:has(.monaco-menu),.monaco-select-box-dropdown-container{background:${menuBg}!important;background-color:${menuBg}!important;}`,
    `.suggest-widget,.monaco-hover,.parameter-hints-widget,.editor-widget,.zone-widget,.zone-widget>.zone-widget-container,.peekview-widget,.peekview-widget>.head,.peekview-widget>.body,.find-widget,.rename-box{background:${widgetBg}!important;background-color:${widgetBg}!important;}`,
    ".peekview-widget .monaco-editor,.peekview-widget .monaco-editor-background,.peekview-widget .monaco-editor .margin{background:transparent!important;background-color:transparent!important;}",
  ].join("");
}

function menuPainterJs(rgb: { r: number; g: number; b: number }, slider: number): string {
  const menuBg = `rgba(${rgb.r},${rgb.g},${rgb.b},${menuOverlayOf(slider).toFixed(3)})`;
  return `(function(){
  function paint(){
    var inners=document.querySelectorAll(".monaco-menu,.monaco-menu .monaco-action-bar,.monaco-menu .actions-container");
    for(var i=0;i<inners.length;i++){
      inners[i].style.setProperty("background-color","transparent","important");
    }
    var panels=document.querySelectorAll(".context-view,.monaco-menu-container,.menubar-menu-items-holder,.monaco-submenu,.monaco-select-box-dropdown-container");
    for(var k=0;k<panels.length;k++){
      var panel=panels[k];
      if(panel.classList.contains("monaco-select-box-dropdown-container")||panel.querySelector(".monaco-menu")){
        panel.style.setProperty("background-color","${menuBg}","important");
      }
    }
  }
  if(!window.__smileMenuPainter){
    window.__smileMenuPainter=true;
    var timer=0;
    new MutationObserver(function(){
      if(timer)return;
      timer=setTimeout(function(){timer=0;paint();},16);
    }).observe(document.documentElement,{childList:true,subtree:true});
  }
  paint();
})();`;
}

function runtimeSource(): string | undefined {
  const candidates = [
    extensionPath ? path.join(extensionPath, "media", RUNTIME_NAME) : "",
    path.join(__dirname, "..", "media", RUNTIME_NAME),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file));
}

function electronHook(material: "acrylic" | "mica", css: string, extraJs: string, _runtimeHref: string): string {
  const styleHtml = `<style id="smile-visual-style">${css}</style>`;
  const rendererJs = `(function(){try{var html=${JSON.stringify(styleHtml)};var policy={createHTML:function(v){return v}};try{if(window.trustedTypes)policy=window.trustedTypes.createPolicy("SmileVisual",{createHTML:function(v){return v}})}catch(e){}var old=document.getElementById("smile-visual-style-host");if(old)old.remove();var host=Document.prototype.createElement.call(document,"div");host.id="smile-visual-style-host";host.innerHTML=policy.createHTML(html);(document.body||document.documentElement).appendChild(host);${extraJs}}catch(err){console.error("smile visual inject",err)}})()`;
  return `
${ELECTRON_START}
import * as __smileElectron from "electron";
(function(){
  var electron = __smileElectron;
  var material = ${JSON.stringify(material)};
  var rendererJs = ${JSON.stringify(rendererJs)};
  function applyWindow(win){
    if(!win||typeof win.isDestroyed==="function"&&win.isDestroyed())return;
    if(!win.__smileBgLocked){
      win.__smileBgLocked=true;
      var original=win.setBackgroundColor.bind(win);
      win.setBackgroundColor=function(){original("#00000000");};
    }
    try{win.setBackgroundColor("#00000000");}catch(x){}
    try{if(typeof win.setBackgroundMaterial==="function")win.setBackgroundMaterial(material);}catch(x){}
    try{if(process.platform==="darwin"&&typeof win.setVibrancy==="function")win.setVibrancy("under-window");}catch(x){}
    win.webContents.on("dom-ready",function(){
      var url=win.webContents.getURL();
      if(url&&url!=="about:blank"&&url.indexOf("workbench")<0&&url.indexOf("index.html")<0&&url.indexOf("vscode-file")<0)return;
      try{win.setBackgroundColor("#00000000");}catch(x){}
      win.webContents.executeJavaScript(rendererJs);
    });
  }
  electron.app.on("browser-window-created",function(_,w){applyWindow(w);});
  function applyExisting(){electron.BrowserWindow.getAllWindows().forEach(applyWindow);}
  if(electron.app.isReady())applyExisting();else electron.app.once("ready",applyExisting);
})();
${ELECTRON_END}`;
}

function unpatchElectron(js: string): string {
  return js
    .replace(ELECTRON_HOOK_RE, "")
    .replace(ELECTRON_OPT_RE, "experimentalDarkMode")
    .replace(/frame:false,transparent:(?:true|false),experimentalDarkMode/g, "experimentalDarkMode");
}

function patchElectron(
  js: string,
  material: "acrylic" | "mica",
  css: string,
  extraJs: string,
  runtimeHref: string
): string {
  let next = unpatchElectron(js);
  if (next.includes("experimentalDarkMode")) {
    next = next.replace(
      /experimentalDarkMode/g,
      `frame:false,transparent:false,backgroundMaterial:${JSON.stringify(material)},backgroundColor:"#00000000",experimentalDarkMode`
    );
  }
  return next.replace(/\s*$/, "") + electronHook(material, css, extraJs, runtimeHref) + "\n";
}

function writeElectronPatch(
  material: "acrylic" | "mica",
  css: string,
  opacity: number
): { ok: boolean; changed: boolean; error?: string } {
  const files = findElectronMains();
  const src = runtimeSource();
  if (!src) {
    return { ok: false, changed: false, error: `未找到 ${RUNTIME_NAME}` };
  }
  if (!files.length) {
    return {
      ok: false,
      changed: false,
      error: `未找到 Electron 主进程 main.js。appRoot=${vscode.env.appRoot || "空"}`,
    };
  }
  let changed = false;
  const errors: string[] = [];
  for (const file of files) {
    try {
      const dest = path.join(path.dirname(file), RUNTIME_NAME);
      const runtime = fs.readFileSync(src, "utf8");
      if (!fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== runtime) {
        fs.writeFileSync(dest, runtime, "utf8");
        changed = true;
      }
      const current = fs.readFileSync(file, "utf8");
      const next = patchElectron(
        current,
        material,
        css,
        menuPainterJs(themeRgb(), opacity),
        pathToFileURL(dest).href
      );
      if (next !== current) {
        fs.writeFileSync(file, next, "utf8");
        changed = true;
      }
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length && !changed) {
    return { ok: false, changed: false, error: errors[0] };
  }
  return { ok: true, changed };
}

function removeElectronPatch(): boolean {
  let changed = false;
  for (const file of findElectronMains()) {
    try {
      const current = fs.readFileSync(file, "utf8");
      const next = unpatchElectron(current);
      if (next !== current) {
        fs.writeFileSync(file, next, "utf8");
        changed = true;
      }
      const dest = path.join(path.dirname(file), RUNTIME_NAME);
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
        changed = true;
      }
    } catch {
      // ignore
    }
  }
  return changed;
}

function glassJs(opacity: number): string {
  return `(function () {
  var oldRain = document.getElementById("smile-visual-root");
  if (oldRain) oldRain.remove();
  document.querySelectorAll('link[href*="smile-visual.css"]').forEach(function (el) { el.remove(); });
  window.__smileRain = false;
  var style = document.getElementById("smile-visual-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "smile-visual-style";
    document.documentElement.appendChild(style);
  }
  style.textContent = ${JSON.stringify(themeCss(opacity))};
  ${menuPainterJs(themeRgb(), opacity)}
})();
`;
}

function patchCsp(html: string): string {
  if (html.includes("SmileVisual")) {
    return html;
  }
  if (!html.includes("trusted-types")) {
    return html;
  }
  return html.replace("chatDebugTokenizer", "chatDebugTokenizer\n\t\t\t\t\tSmileVisual");
}

function unpatchCsp(html: string): string {
  return html.replace(/\n\t\t\t\t\tSmileVisual/g, "");
}

function writeInjection(js: string): { ok: boolean; changed: boolean; error?: string } {
  const files = findWorkbenchHtmls();
  if (!files.length) {
    return {
      ok: false,
      changed: false,
      error: `未找到 workbench.html。appRoot=${vscode.env.appRoot || "空"}`,
    };
  }
  let changed = false;
  const errors: string[] = [];
  for (const file of files) {
    try {
      const jsPath = path.join(path.dirname(file), JS_NAME);
      if (!fs.existsSync(jsPath) || fs.readFileSync(jsPath, "utf8") !== js) {
        fs.writeFileSync(jsPath, js, "utf8");
        changed = true;
      }
      const html = fs.readFileSync(file, "utf8");
      let next = html;
      if (!html.includes(JS_NAME) || !html.includes(MARK_START)) {
        next = upsertScriptTag(next);
      }
      next = patchCsp(next);
      if (next !== html) {
        fs.writeFileSync(file, next, "utf8");
        changed = true;
      }
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length && !changed) {
    return { ok: false, changed: false, error: errors[0] };
  }
  return { ok: true, changed };
}

function removeInjection(): boolean {
  let changed = false;
  for (const file of findWorkbenchHtmls()) {
    try {
      const html = fs.readFileSync(file, "utf8");
      const next = unpatchCsp(stripInjected(html));
      if (next !== html) {
        fs.writeFileSync(file, next, "utf8");
        changed = true;
      }
      const dir = path.dirname(file);
      for (const name of [JS_NAME, "smile-visual.css"]) {
        const extra = path.join(dir, name);
        if (fs.existsSync(extra)) {
          fs.unlinkSync(extra);
          changed = true;
        }
      }
    } catch {
      // ignore
    }
  }
  return changed;
}

async function restoreBackgroundBackup(): Promise<boolean> {
  const backup = readColorBackup();
  const inspect = vscode.workspace
    .getConfiguration("workbench")
    .inspect<Record<string, unknown>>("colorCustomizations");
  const global = clone(inspect?.globalValue ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const key of ALL_EFFECT_KEYS) {
    if (restoreColorKey(global, key, backup.root[key])) {
      changed = true;
    }
  }
  if (isOurAlphaColor(global["terminal.background"]) || global["terminal.background"] === "#00000000") {
    delete global["terminal.background"];
    changed = true;
  }
  const themeKeys = new Set([
    ...Object.keys(backup.themes),
    ...Object.keys(global).filter((key) => key.startsWith("[")),
  ]);
  for (const key of themeKeys) {
    const value = global[key];
    const bucket =
      typeof value === "object" && value ? clone(value as Record<string, unknown>) : {};
    const originals = backup.themes[key] ?? {};
    let bucketChanged = false;
    for (const colorKey of [...ALL_EFFECT_KEYS, "terminal.background"] as const) {
      const original = originals[colorKey];
      if (original) {
        if (restoreColorKey(bucket, colorKey, original)) {
          bucketChanged = true;
        }
      } else if (isOurAlphaColor(bucket[colorKey]) || bucket[colorKey] === "#00000000") {
        delete bucket[colorKey];
        bucketChanged = true;
      }
    }
    if (bucketChanged) {
      if (Object.keys(bucket).length) {
        global[key] = bucket;
      } else if (key in global) {
        delete global[key];
      }
      changed = true;
    }
  }
  if (changed) {
    await vscode.workspace
      .getConfiguration("workbench")
      .update(
        "colorCustomizations",
        Object.keys(global).length ? global : undefined,
        vscode.ConfigurationTarget.Global
      );
  }
  await globalState?.update(BACKUP_KEY, undefined);
  return changed;
}

export async function restoreLegacyEffectColorEdits(state: vscode.Memento): Promise<void> {
  initVisualEffects(state);
}

async function ensureCustomMenus(): Promise<boolean> {
  const conf = vscode.workspace.getConfiguration("window");
  const current = conf.get<string>("menuStyle");
  if (current === "custom") {
    return false;
  }
  if (globalState?.get(MENU_STYLE_BACKUP_KEY) === undefined) {
    await globalState?.update(MENU_STYLE_BACKUP_KEY, current ?? "inherit");
  }
  await conf.update("menuStyle", "custom", vscode.ConfigurationTarget.Global);
  return true;
}

async function restoreMenuStyle(): Promise<boolean> {
  const backup = globalState?.get<string>(MENU_STYLE_BACKUP_KEY);
  if (backup === undefined) {
    return false;
  }
  const conf = vscode.workspace.getConfiguration("window");
  if (conf.get<string>("menuStyle") === "custom") {
    await conf.update("menuStyle", backup, vscode.ConfigurationTarget.Global);
  }
  await globalState?.update(MENU_STYLE_BACKUP_KEY, undefined);
  return true;
}

async function ensureTerminalGpuOff(): Promise<void> {
  const conf = vscode.workspace.getConfiguration("terminal.integrated");
  if (globalState?.get(GPU_BACKUP_KEY) === undefined) {
    await globalState?.update(GPU_BACKUP_KEY, conf.inspect<string>("gpuAcceleration")?.globalValue ?? null);
  }
  await conf.update("gpuAcceleration", "off", vscode.ConfigurationTarget.Global);
}

async function restoreTerminalGpu(): Promise<boolean> {
  if (!globalState || globalState.get(GPU_BACKUP_KEY) === undefined) {
    return false;
  }
  const saved = globalState.get<string | null>(GPU_BACKUP_KEY);
  await vscode.workspace
    .getConfiguration("terminal.integrated")
    .update("gpuAcceleration", saved, vscode.ConfigurationTarget.Global);
  await globalState.update(GPU_BACKUP_KEY, undefined);
  return true;
}

export async function cleanupVisualEffects(): Promise<boolean> {
  const colorsRestored = await restoreBackgroundBackup();
  const menuStyleRestored = await restoreMenuStyle();
  const gpuRestored = await restoreTerminalGpu();
  const htmlRemoved = removeInjection();
  const electronRemoved = removeElectronPatch();
  return colorsRestored || menuStyleRestored || gpuRestored || htmlRemoved || electronRemoved;
}

function findCodeCli(): string {
  const cliName = "code";
  const nextToExe = path.join(path.dirname(process.execPath), "bin", `${cliName}.cmd`);
  if (fs.existsSync(nextToExe)) {
    return nextToExe;
  }
  let dir = vscode.env.appRoot;
  for (let i = 0; i < 6 && dir !== path.dirname(dir); i++) {
    dir = path.dirname(dir);
    const candidate = path.join(dir, "bin", `${cliName}.cmd`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return cliName;
}

function relaunchAfterQuit(): void {
  const cliCommand = findCodeCli();
  const binName = path.basename(process.execPath);
  const vbsScript = [
    `Set WshShell = CreateObject("WScript.Shell")`,
    `Set WMI = GetObject("winmgmts:\\\\.\\root\\cimv2")`,
    `Do`,
    ` WScript.Sleep 1000`,
    ` Set procs = WMI.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = '${binName.replace(/'/g, "")}'")`,
    ` If procs.Count = 0 Then Exit Do`,
    `Loop`,
    `WScript.Sleep 1500`,
    `WshShell.Run """${cliCommand.replace(/"/g, '""')}""", 0, False`,
    `CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName`,
  ].join("\r\n");
  const vbsPath = path.join(os.tmpdir(), "smile-restart.vbs");
  const vbsBom = Buffer.from([0xff, 0xfe]);
  const vbsContent = Buffer.from(vbsScript, "utf16le");
  fs.writeFileSync(vbsPath, Buffer.concat([vbsBom, vbsContent]));
  spawn("wscript", [vbsPath], { detached: true, stdio: "ignore" }).unref();
  void vscode.commands.executeCommand("workbench.action.quit");
}

function promptRestart(message: string): void {
  void vscode.window.showInformationMessage(message, { title: "重启应用" }).then((msg) => {
    if (msg) {
      relaunchAfterQuit();
    }
  });
}

export async function applyVisualEffect(
  effect: VisualEffectId,
  options?: ApplyVisualEffectOptions
): Promise<void> {
  if (effect === "none") {
    const removed = await cleanupVisualEffects();
    await applyDarkModernEditorBackground();
    if (removed && options?.reload) {
      promptRestart("已关闭视觉效果，请重启应用。");
    }
    return;
  }

  const opacity = opacityOf(effect, options?.opacity);
  const material = materialOf(effect);
  const css = themeCss(opacity);
  await ensureCustomMenus();
  await ensureTerminalGpuOff();
  await applyAllBackgroundColors(effect, opacity);
  const electron = writeElectronPatch(material, css, opacity);
  if (!electron.ok) {
    vscode.window.showErrorMessage(`亚克力未能写入 Electron 主进程：${electron.error}`);
    return;
  }
  const written = writeInjection(glassJs(opacity));
  if (!written.ok) {
    vscode.window.showErrorMessage(`亚克力未能写入主界面：${written.error}`);
    return;
  }
  if (options?.reload === false) {
    return;
  }
  promptRestart("视觉效果已写入，请重启应用。");
}
