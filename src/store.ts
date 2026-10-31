import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { writeUserKeybindings } from "./keybindingsWriter";
import {
  BuildConfiguration,
  CppColorItem,
  CPP_COLOR_DEFS,
  DEFAULT_CONFIGURATIONS,
  DEFAULT_KEYBINDINGS,
  DEFAULT_PROJECT,
  ProjectProperties,
  SMILE_SYNC_VERSION,
  VisualEffectId,
  VisualEffectOpacityMap,
  DEFAULT_VISUAL_EFFECT_OPACITY,
} from "./types";

const PROJECT_FILE = ".vscode/.smile/project.json";
const LEGACY_PROJECT_FILE = ".smile/project.json";
const GLOBAL_KEYS = {
  keybindings: "smile.keybindings",
  colors: "smile.cppColors",
  visualEffect: "smile.visualEffect",
  visualEffectOpacity: "smile.visualEffectOpacity",
  syncVersion: "smile.syncVersion",
};
const LEGACY_GLOBAL_KEYS = {
  keybindings: "smilodon.keybindings",
  colors: "smilodon.cppColors",
  syncVersion: "smilodon.syncVersion",
};
const RULE_NAME = "smile-cpp";
const LEGACY_RULE_NAMES = new Set(["smile-cpp", "smilodon-cpp"]);

let globalState: vscode.Memento | undefined;

export async function initStore(context: vscode.ExtensionContext): Promise<void> {
  globalState = context.globalState;
  // 从旧扩展 smilodon.* 迁移一次
  if (globalState.get(GLOBAL_KEYS.syncVersion) == null) {
    const oldKeys = globalState.get(LEGACY_GLOBAL_KEYS.keybindings);
    const oldColors = globalState.get(LEGACY_GLOBAL_KEYS.colors);
    if (oldKeys) {
      await globalState.update(GLOBAL_KEYS.keybindings, oldKeys);
    }
    if (oldColors) {
      await globalState.update(GLOBAL_KEYS.colors, oldColors);
    }
    const oldSync = globalState.get<number>(LEGACY_GLOBAL_KEYS.syncVersion);
    if (oldSync != null) {
      await globalState.update(GLOBAL_KEYS.syncVersion, oldSync);
    }
  }
  const current = globalState.get<number>(GLOBAL_KEYS.syncVersion) ?? 0;
  if (current < SMILE_SYNC_VERSION) {
    await globalState.update(GLOBAL_KEYS.keybindings, { ...DEFAULT_KEYBINDINGS });
    const colorMap: Record<string, { color: string; bold?: boolean; italic?: boolean }> = {};
    for (const c of CPP_COLOR_DEFS) {
      colorMap[c.id] = { color: c.color, bold: c.bold, italic: c.italic };
    }
    await globalState.update(GLOBAL_KEYS.colors, colorMap);
    await globalState.update(GLOBAL_KEYS.syncVersion, SMILE_SYNC_VERSION);
  }
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return structuredClone(fallback);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return structuredClone(fallback);
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function mergeProject(saved: Partial<ProjectProperties>): ProjectProperties {
  const configurations: BuildConfiguration[] =
    saved.configuration?.configurations?.length
      ? saved.configuration.configurations
      : structuredClone(DEFAULT_CONFIGURATIONS);

  return {
    compiler: { ...DEFAULT_PROJECT.compiler, ...saved.compiler },
    configuration: {
      ...DEFAULT_PROJECT.configuration,
      ...saved.configuration,
      configurations,
    },
    general: { ...DEFAULT_PROJECT.general, ...saved.general },
    debug: { ...DEFAULT_PROJECT.debug, ...saved.debug },
    cpp: { ...DEFAULT_PROJECT.cpp, ...saved.cpp },
  };
}

export function loadProject(): ProjectProperties {
  const root = workspaceRoot();
  if (!root) {
    return structuredClone(DEFAULT_PROJECT);
  }
  const neu = path.join(root, PROJECT_FILE);
  const old = path.join(root, LEGACY_PROJECT_FILE);
  const file = fs.existsSync(neu) ? neu : old;
  const saved = readJsonFile<Partial<ProjectProperties>>(file, {});
  return mergeProject(saved);
}

export function saveProject(project: ProjectProperties): void {
  const root = workspaceRoot();
  if (!root) {
    throw new Error("请先打开一个工作区文件夹");
  }
  writeJsonFile(path.join(root, PROJECT_FILE), project);
}

export function loadKeybindings(): Record<string, string> {
  const saved = globalState?.get<Record<string, string>>(GLOBAL_KEYS.keybindings);
  return { ...DEFAULT_KEYBINDINGS, ...(saved ?? {}) };
}

export async function saveKeybindings(keys: Record<string, string>): Promise<void> {
  if (!globalState) {
    throw new Error("扩展尚未初始化");
  }
  await globalState.update(GLOBAL_KEYS.keybindings, keys);
}

export function loadCppColors(): CppColorItem[] {
  const defaults = structuredClone(CPP_COLOR_DEFS);
  const saved = globalState?.get<Record<string, Partial<CppColorItem>>>(GLOBAL_KEYS.colors) ?? {};
  return defaults.map((item) => ({
    ...item,
    ...saved[item.id],
    id: item.id,
    label: item.label,
    category: item.category,
    scope: item.scope,
    semantic: item.semantic,
  }));
}

export async function saveCppColors(colors: CppColorItem[]): Promise<void> {
  if (!globalState) {
    throw new Error("扩展尚未初始化");
  }
  const map: Record<string, { color: string; bold?: boolean; italic?: boolean }> = {};
  for (const c of colors) {
    map[c.id] = { color: c.color, bold: c.bold, italic: c.italic };
  }
  await globalState.update(GLOBAL_KEYS.colors, map);
}

export function loadVisualEffect(): VisualEffectId {
  const saved = globalState?.get<string>(GLOBAL_KEYS.visualEffect);
  if (saved === "acrylic" || saved === "none") {
    return saved;
  }
  if (saved === "glass") {
    return "acrylic";
  }
  return "none";
}

export async function saveVisualEffect(effect: VisualEffectId): Promise<void> {
  if (!globalState) {
    throw new Error("扩展尚未初始化");
  }
  await globalState.update(GLOBAL_KEYS.visualEffect, effect);
}

function clampOpacity(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function loadVisualEffectOpacity(): VisualEffectOpacityMap {
  const saved = globalState?.get<Partial<VisualEffectOpacityMap>>(GLOBAL_KEYS.visualEffectOpacity) ?? {};
  return {
    acrylic: clampOpacity(saved.acrylic, DEFAULT_VISUAL_EFFECT_OPACITY.acrylic),
  };
}

export async function saveVisualEffectOpacity(map: VisualEffectOpacityMap): Promise<void> {
  if (!globalState) {
    throw new Error("扩展尚未初始化");
  }
  await globalState.update(GLOBAL_KEYS.visualEffectOpacity, {
    acrylic: clampOpacity(map.acrylic, DEFAULT_VISUAL_EFFECT_OPACITY.acrylic),
  });
}

function fontStyleOf(c: CppColorItem): string | undefined {
  if (c.bold && c.italic) {
    return "bold italic";
  }
  if (c.bold) {
    return "bold";
  }
  if (c.italic) {
    return "italic";
  }
  return undefined;
}

function clone<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function isThemeKey(key: string): boolean {
  return key.startsWith("[") && key.endsWith("]");
}

function filterManagedColorRules(rules: unknown[]): unknown[] {
  return rules.filter((rule) => !LEGACY_RULE_NAMES.has((rule as { name?: string }).name ?? ""));
}

export async function applyKeybindingsToVscode(keys: Record<string, string>): Promise<void> {
  const filePath = await writeUserKeybindings(keys);
  // Remove obsolete snapshot that previously bloated settings.json
  await vscode.workspace
    .getConfiguration()
    .update("smile.keybindingsSnapshot", undefined, vscode.ConfigurationTarget.Global)
    .then(undefined, () => undefined);
  await vscode.workspace
    .getConfiguration()
    .update("smilodon.keybindingsSnapshot", undefined, vscode.ConfigurationTarget.Global)
    .then(undefined, () => undefined);
  void filePath;
}

export async function applyCppColorsToVscode(colors: CppColorItem[]): Promise<void> {
  // Put high-specificity / frequently overridden rules last so they win.
  const lateIds = new Set(["number", "nullptr", "comment", "keyword", "attribute", "stringQuote"]);
  const ordered = [
    ...colors.filter((c) => !lateIds.has(c.id)),
    ...colors.filter((c) => c.id === "number"),
    ...colors.filter((c) => c.id === "nullptr"),
    ...colors.filter((c) => c.id === "comment"),
    ...colors.filter((c) => c.id === "keyword"),
    ...colors.filter((c) => c.id === "attribute"),
    ...colors.filter((c) => c.id === "stringQuote"),
  ];
  const textMateRules = ordered
    .filter((c) => c.scope)
    .map((c) => {
      const fontStyle = fontStyleOf(c);
      return {
        name: RULE_NAME,
        scope: c.scope,
        settings: {
          foreground: c.color,
          ...(fontStyle ? { fontStyle } : {}),
        },
      };
    });

  const semanticRules: Record<string, { foreground: string; fontStyle?: string }> = {};
  for (const c of colors) {
    if (!c.semantic) {
      continue;
    }
    const fontStyle = fontStyleOf(c);
    const keys = Array.isArray(c.semantic) ? c.semantic : [c.semantic];
    for (const key of keys) {
      semanticRules[key] = {
        foreground: c.color,
        ...(fontStyle ? { fontStyle } : {}),
      };
    }
  }

  const theme =
    vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ?? "Default Dark Modern";
  const themeKey = `[${theme}]`;

  const editor = vscode.workspace.getConfiguration("editor");

  // IMPORTANT: only rewrite the user globalValue to avoid duplicating merged config.
  const tokenInspect = editor.inspect<Record<string, unknown>>("tokenColorCustomizations");
  const globalToken = clone(tokenInspect?.globalValue ?? {}) as Record<string, unknown>;

  // Remove previously mis-written top-level Smile rules (settings.json growth source).
  if (Array.isArray(globalToken.textMateRules)) {
    const cleaned = filterManagedColorRules(globalToken.textMateRules as unknown[]);
    if (cleaned.length) {
      globalToken.textMateRules = cleaned;
    } else {
      delete globalToken.textMateRules;
    }
  }

  // Write into the active theme bucket so colors actually apply (e.g. [Cursor Dark]).
  // Replace theme textMateRules entirely with Smile C/C++ rules to avoid
  // duplicate scopes and unbounded settings.json growth.
  const themeBucket = clone(
    (globalToken[themeKey] as Record<string, unknown> | undefined) ?? {}
  ) as Record<string, unknown>;
  themeBucket.textMateRules = textMateRules;
  globalToken[themeKey] = themeBucket;

  // Also clean Smile rules from any other theme buckets to prevent unbounded growth.
  for (const key of Object.keys(globalToken)) {
    if (!isThemeKey(key) || key === themeKey) {
      continue;
    }
    const bucket = globalToken[key] as Record<string, unknown> | undefined;
    if (!bucket || !Array.isArray(bucket.textMateRules)) {
      continue;
    }
    const cleaned = filterManagedColorRules(bucket.textMateRules as unknown[]);
    if (cleaned.length) {
      bucket.textMateRules = cleaned;
    } else {
      delete bucket.textMateRules;
    }
    if (Object.keys(bucket).length === 0) {
      delete globalToken[key];
    } else {
      globalToken[key] = bucket;
    }
  }

  await editor.update("tokenColorCustomizations", globalToken, vscode.ConfigurationTarget.Global);

  const semInspect = editor.inspect<Record<string, unknown>>("semanticTokenColorCustomizations");
  const globalSem = clone(semInspect?.globalValue ?? {}) as Record<string, unknown>;

  // Remove root-level semantic rules previously written by Smile.
  if (globalSem.rules && typeof globalSem.rules === "object") {
    const rootRules = { ...(globalSem.rules as Record<string, unknown>) };
    for (const key of Object.keys(semanticRules)) {
      delete rootRules[key];
    }
    if (Object.keys(rootRules).length) {
      globalSem.rules = rootRules;
    } else {
      delete globalSem.rules;
    }
  }

  const semTheme = clone(
    (globalSem[themeKey] as Record<string, unknown> | undefined) ?? {}
  ) as Record<string, unknown>;
  const prevRules =
    semTheme.rules && typeof semTheme.rules === "object"
      ? { ...(semTheme.rules as Record<string, unknown>) }
      : {};
  // Drop previous cpp/c semantic keys we manage, then write current set.
  for (const key of Object.keys(prevRules)) {
    if (key.endsWith(":cpp") || key.endsWith(":c")) {
      delete prevRules[key];
    }
  }
  semTheme.enabled = true;
  semTheme.rules = { ...prevRules, ...semanticRules };
  globalSem[themeKey] = semTheme;
  globalSem.enabled = true;

  await editor.update(
    "semanticTokenColorCustomizations",
    globalSem,
    vscode.ConfigurationTarget.Global
  );

  await vscode.workspace
    .getConfiguration("C_Cpp")
    .update("enhancedColorization", "Enabled", vscode.ConfigurationTarget.Global)
    .then(undefined, () => undefined);

  if (loadVisualEffect() === "none") {
    await applyDarkModernEditorBackground();
  }
}

const DARK_MODERN_CHROME = "#181818";
const DARK_MODERN_EDITOR_KEYS = [
  "editor.background",
  "editorPane.background",
  "editorGutter.background",
  "editorStickyScroll.background",
  "editorStickyScrollGutter.background",
] as const;

export async function applyDarkModernEditorBackground(): Promise<void> {
  const theme = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ?? "";
  if (!/dark modern/i.test(theme)) {
    return;
  }
  const inspect = vscode.workspace
    .getConfiguration("workbench")
    .inspect<Record<string, unknown>>("colorCustomizations");
  const global = clone(inspect?.globalValue ?? {}) as Record<string, unknown>;
  const bucketKey = `[${theme}]`;
  const bucket = clone((global[bucketKey] as Record<string, unknown>) ?? {});
  for (const key of DARK_MODERN_EDITOR_KEYS) {
    global[key] = DARK_MODERN_CHROME;
    bucket[key] = DARK_MODERN_CHROME;
  }
  global[bucketKey] = bucket;
  await vscode.workspace
    .getConfiguration("workbench")
    .update("colorCustomizations", global, vscode.ConfigurationTarget.Global);
}
