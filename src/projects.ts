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
import { COMPILER_NAMES, DEFAULT_PROJECT, ProjectProperties } from "./types";
import { readVcxproj, writeVcxproj } from "./vcxproj";
import { syncVsCodeBuildFromProject } from "./vscodeBuildSync";

export type ProjectKind = "vcxproj" | "cmake" | "smile";

export interface DiscoveredProject {
  id: string;
  name: string;
  kind: ProjectKind;
  /** Absolute path to .vcxproj, CMakeLists.txt dir, or logical folder */
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

function normalizeCompilerName(name?: string): string {
  const n = (name || "").toLowerCase();
  if (n.includes("mingw") || n.includes("gcc") || n.includes("g++")) {
    return "MinGW64";
  }
  if (COMPILER_NAMES.includes(name as (typeof COMPILER_NAMES)[number])) {
    return name as string;
  }
  return "MSVC";
}

function readJsonProps(filePath: string): ProjectProperties | undefined {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ProjectProperties>;
    return {
      compiler: {
        ...DEFAULT_PROJECT.compiler,
        ...raw.compiler,
        name: normalizeCompilerName(raw.compiler?.name ?? DEFAULT_PROJECT.compiler.name),
      },
      configuration: {
        ...DEFAULT_PROJECT.configuration,
        ...raw.configuration,
        configurations:
          raw.configuration?.configurations?.length
            ? raw.configuration.configurations
            : structuredClone(DEFAULT_PROJECT.configuration.configurations),
      },
      general: { ...DEFAULT_PROJECT.general, ...raw.general },
      advanced: { ...DEFAULT_PROJECT.advanced, ...raw.advanced },
      debug: { ...DEFAULT_PROJECT.debug, ...raw.debug },
      cpp: { ...DEFAULT_PROJECT.cpp, ...raw.cpp },
    };
  } catch {
    return undefined;
  }
}

function writeJsonProps(filePath: string, props: ProjectProperties): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const next = {
    ...props,
    compiler: {
      ...props.compiler,
      name: normalizeCompilerName(props.compiler.name),
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
}

function mergeProps(base: ProjectProperties, overlay?: ProjectProperties): ProjectProperties {
  if (!overlay) {
    return base;
  }
  return {
    compiler: {
      ...base.compiler,
      ...overlay.compiler,
      name: normalizeCompilerName(overlay.compiler?.name ?? base.compiler.name),
    },
    configuration: {
      ...base.configuration,
      ...overlay.configuration,
      configurations:
        overlay.configuration.configurations?.length
          ? overlay.configuration.configurations
          : base.configuration.configurations,
    },
    general: { ...base.general, ...overlay.general },
    advanced: { ...base.advanced, ...overlay.advanced },
    debug: { ...base.debug, ...overlay.debug },
    cpp: { ...base.cpp, ...overlay.cpp },
  };
}

async function findVcxprojs(root: string): Promise<string[]> {
  const pattern = new vscode.RelativePattern(root, "**/*.vcxproj");
  const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 100);
  return uris.map((u) => u.fsPath).sort((a, b) => a.localeCompare(b));
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

  const vcxprojs = await findVcxprojs(root);
  for (const file of vcxprojs) {
    const name = path.basename(file, ".vcxproj");
    const id = safeId(path.relative(root, file));
    const dir = path.dirname(file).toLowerCase();
    seenDirs.add(dir);
    projects.push({
      id,
      name,
      kind: "vcxproj",
      path: file,
      relativePath: path.relative(root, file),
      sourceLabel: "Visual Studio (.vcxproj)",
      hasExistingProps: true,
    });
  }

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
      sourceLabel: "Smile（新建）",
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

  if (project.kind === "vcxproj") {
    let fromVs = structuredClone(DEFAULT_PROJECT);
    try {
      fromVs = readVcxproj(project.path);
    } catch {
      // keep defaults
    }
    const overlayPath = resolveExistingSmileJson(root, project.id);
    const overlay = overlayPath ? readJsonProps(overlayPath) : undefined;
    return mergeProps(fromVs, overlay);
  }

  const jsonPath = resolveExistingSmileJson(root, project.id);
  const fromJson =
    (jsonPath ? readJsonProps(jsonPath) : undefined) ||
    (project.kind === "smile" ? readJsonProps(project.path) : undefined);
  const props = fromJson ?? structuredClone(DEFAULT_PROJECT);
  props.compiler.name = normalizeCompilerName(props.compiler.name);
  if (project.kind === "cmake") {
    if (!props.general.targetFileName) {
      props.general.targetFileName = project.name;
    }
    // 新建 CMake 工程：默认输出目录用 build
    if (!fromJson) {
      props.general.outputDirectory = "build\\";
      props.general.intermediateDirectory = "build\\";
    }
  }
  return props;
}

export function saveProjectProps(project: DiscoveredProject, props: ProjectProperties): string {
  const root = workspaceRoot();
  if (!root) {
    throw new Error("请先打开一个工作区文件夹");
  }

  props.compiler.name = normalizeCompilerName(props.compiler.name);
  const jsonPath = smileJsonPath(root, project.id);
  writeJsonProps(jsonPath, props);

  const parts: string[] = [];
  if (project.kind === "vcxproj") {
    writeVcxproj(project.path, props);
    parts.push(`已写入 ${path.basename(project.path)}`);
  }
  parts.push(`已保存 ${path.relative(root, jsonPath)}`);

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
