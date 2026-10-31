import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  legacySmileRoots,
  migrateSmileDir,
  resolveExistingSmileJson,
  smileProjectJson,
  smileProjectsDir,
  smileRoot,
} from "./paths";
import {
  BuildType,
  CompilerName,
  ConfigType,
  DEFAULT_PROJECT,
  LanguageStandard,
  ProjectProperties,
} from "./types";
import { syncVsCodeBuildFromProject } from "./vscodeBuildSync";

export type ProjectKind = "cmake" | "smile";

export interface DiscoveredProject {
  id: string;
  name: string;
  kind: ProjectKind;
  /** Absolute path to the CMake project directory, or the Smile property file */
  path: string;
  relativePath: string;
  sourceLabel: string;
  hasExistingProps: boolean;
}

export interface ProjectStateItem extends DiscoveredProject {
  props: ProjectProperties;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function safeId(input: string): string {
  return input.replace(/[^\w.-]+/g, "_");
}

function smileJsonPath(root: string, id: string): string {
  return smileProjectJson(root, id);
}

function isMsvcPath(value?: string): boolean {
  return /msbuild|cl\.exe|visual studio|vcvars/i.test(value || "");
}

function normalizeCompilerName(name?: string, compilerPath?: string): CompilerName {
  const n = `${name || ""} ${compilerPath || ""}`.toLowerCase();
  if (n.includes("clang")) {
    return "Clang";
  }
  return "GCC";
}

function normalizeBuildType(name?: string): BuildType {
  return /release|minsize|relwithdeb/i.test(name || "") ? "Release" : "Debug";
}

function normalizeConfigType(value?: string): ConfigType {
  const v = value || "";
  if (v.includes("动态") || /dll|shared/i.test(v)) {
    return "动态库";
  }
  if (v.includes("静态") || /static|\.lib|\.a\b/i.test(v)) {
    return "静态库";
  }
  return "可执行文件";
}

function normalizeStandard(value?: string): LanguageStandard {
  if (value === "C++20") {
    return "C++20";
  }
  if (value === "C++23" || value === "最新") {
    return "C++23";
  }
  return "C++17";
}

/** 旧的 VS 宏路径和 MSVC 默认项，读入时收成 GCC/Clang 能直接用的值。 */
function normalizeOutputDir(dir?: string): string {
  const d = (dir || "").trim();
  if (!d || /\$\((SolutionDir|Platform|Configuration|OutDir)\)/i.test(d)) {
    return "build";
  }
  return d.replace(/[\\/]+$/, "") || "build";
}

function normalizeDefines(value?: string): string {
  const parts = (value || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const msvcDefaults = new Set(["_DEBUG", "NDEBUG", "_CONSOLE", "UNICODE", "_UNICODE"]);
  if (parts.length && parts.every((p) => msvcDefaults.has(p))) {
    return "";
  }
  return parts.join(";");
}

function normalizeProps(raw?: Partial<ProjectProperties>): ProjectProperties {
  const compilerPath = isMsvcPath(raw?.compiler?.path) ? "" : raw?.compiler?.path || "";
  const target = (raw?.general?.targetFileName || "").trim();
  const command = (raw?.debug?.command || "").trim();
  const cwd = (raw?.debug?.workingDirectory || "").trim();
  return {
    compiler: {
      name: normalizeCompilerName(raw?.compiler?.name, compilerPath),
      path: compilerPath,
    },
    configuration: {
      config: normalizeBuildType(raw?.configuration?.config),
      platform: "x64",
      configurations: structuredClone(DEFAULT_PROJECT.configuration.configurations),
    },
    general: {
      outputDirectory: normalizeOutputDir(raw?.general?.outputDirectory),
      targetFileName: /^\$\(ProjectName\)$/i.test(target) ? "" : target,
      configurationType: normalizeConfigType(raw?.general?.configurationType),
      languageStandard: normalizeStandard(raw?.general?.languageStandard),
    },
    debug: {
      command: !command || /^\$\(TargetPath\)$/i.test(command) ? "" : command,
      commandArguments: raw?.debug?.commandArguments || "",
      workingDirectory: !cwd || /^\$\(ProjectDir\)$/i.test(cwd) ? "" : cwd,
    },
    cpp: {
      additionalIncludeDirectories: raw?.cpp?.additionalIncludeDirectories || "",
      additionalLibraryDirectories: raw?.cpp?.additionalLibraryDirectories || "",
      additionalDependencies: raw?.cpp?.additionalDependencies || "",
      preprocessorDefinitions: normalizeDefines(raw?.cpp?.preprocessorDefinitions),
    },
  };
}

function readJsonProps(filePath: string): ProjectProperties | undefined {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ProjectProperties>;
    return normalizeProps(raw);
  } catch {
    return undefined;
  }
}

function writeJsonProps(filePath: string, props: ProjectProperties): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(normalizeProps(props), null, 2), "utf8");
}

async function findCMakeLists(root: string): Promise<string[]> {
  const pattern = new vscode.RelativePattern(root, "**/CMakeLists.txt");
  const uris = await vscode.workspace.findFiles(
    pattern,
    "**/{node_modules,build,build-*,.smile,.smilodon,out,bin,x64,Win32,Debug,Release,.vs,cmake-build-*,.vscode}/**",
    50
  );
  return uris.map((u) => u.fsPath).sort((a, b) => a.localeCompare(b));
}

export async function discoverProjects(): Promise<DiscoveredProject[]> {
  const root = workspaceRoot();
  if (!root) {
    return [];
  }

  migrateSmileDir(root);

  const projects: DiscoveredProject[] = [];
  const seenDirs = new Set<string>();

  const cmakeFiles = await findCMakeLists(root);
  for (const file of cmakeFiles) {
    const dir = path.dirname(file);
    if (seenDirs.has(dir.toLowerCase())) {
      continue;
    }
    seenDirs.add(dir.toLowerCase());
    const name = path.basename(dir);
    const id = safeId(`cmake_${path.relative(root, dir) || name}`);
    const jsonPath = smileJsonPath(root, id);
    projects.push({
      id,
      name,
      kind: "cmake",
      path: dir,
      relativePath: path.relative(root, file),
      sourceLabel: "CMake",
      hasExistingProps: fs.existsSync(jsonPath),
    });
  }

  const projectDirs = [
    smileProjectsDir(root),
    ...legacySmileRoots(root).map((r) => path.join(r, "projects")),
  ];
  for (const smDir of projectDirs) {
    if (!fs.existsSync(smDir)) {
      continue;
    }
    for (const file of fs.readdirSync(smDir)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const id = file.replace(/\.json$/i, "");
      if (projects.some((p) => p.id === id)) {
        continue;
      }
      // CMake 以目录扫描为准，避免从 json 名反推错误路径
      if (id.startsWith("cmake_")) {
        continue;
      }
      projects.push({
        id,
        name: id === "workspace" ? path.basename(root) : id,
        kind: "smile",
        path: path.join(smDir, file),
        relativePath: path.relative(root, path.join(smDir, file)),
        sourceLabel: "Smile",
        hasExistingProps: true,
      });
    }
  }

  const legacyCandidates = [
    path.join(smileRoot(root), "project.json"),
    ...legacySmileRoots(root).map((r) => path.join(r, "project.json")),
  ];
  for (const legacy of legacyCandidates) {
    if (!projects.length && fs.existsSync(legacy)) {
      projects.push({
        id: "workspace",
        name: path.basename(root),
        kind: "smile",
        path: legacy,
        relativePath: path.relative(root, legacy),
        sourceLabel: "Smile",
        hasExistingProps: true,
      });
      break;
    }
  }

  if (!projects.length) {
    projects.push({
      id: "workspace",
      name: path.basename(root),
      kind: "smile",
      path: smileJsonPath(root, "workspace"),
      relativePath: path.relative(root, smileJsonPath(root, "workspace")),
      sourceLabel: "文件夹",
      hasExistingProps: false,
    });
  }

  return projects;
}

export function loadProjectProps(project: DiscoveredProject): ProjectProperties {
  const root = workspaceRoot();
  if (!root) {
    return structuredClone(DEFAULT_PROJECT);
  }

  const jsonPath = resolveExistingSmileJson(root, project.id);
  const fromJson =
    (jsonPath ? readJsonProps(jsonPath) : undefined) ||
    (project.kind === "smile" ? readJsonProps(project.path) : undefined);
  const props = fromJson ?? structuredClone(DEFAULT_PROJECT);
  if (project.kind === "cmake" && !props.general.targetFileName) {
    props.general.targetFileName = project.name;
  }
  return props;
}

export function saveProjectProps(project: DiscoveredProject, props: ProjectProperties): string {
  const root = workspaceRoot();
  if (!root) {
    throw new Error("请先打开一个工作区文件夹");
  }

  const normalized = normalizeProps(props);
  props.compiler = normalized.compiler;
  props.configuration = normalized.configuration;
  props.general = normalized.general;
  props.debug = normalized.debug;
  props.cpp = normalized.cpp;

  const jsonPath = smileJsonPath(root, project.id);
  writeJsonProps(jsonPath, props);

  const parts: string[] = [`已保存 ${path.relative(root, jsonPath)}`];

  try {
    parts.push(syncVsCodeBuildFromProject(root, project, props));
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    parts.push(`VS Code 构建同步失败: ${text}`);
  }

  return parts.join("；");
}

export async function loadAllProjectStates(): Promise<ProjectStateItem[]> {
  const list = await discoverProjects();
  return list.map((p) => ({
    ...p,
    props: loadProjectProps(p),
  }));
}
