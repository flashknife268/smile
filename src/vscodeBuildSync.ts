import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { legacySmileRoots, smileRoot } from "./paths";
import type { DiscoveredProject } from "./projects";
import type { LanguageStandard, ProjectProperties } from "./types";

const TASK_PREFIX = "Smile: Build ";
const MANAGED_DETAIL = "由 Smile 根据项目属性自动生成";
const MANAGED_DETAIL_LEGACY = "由 Smilodon 根据项目属性自动生成";
const MANAGED_LABEL_RE = /^(Smile|Smilodon): (Build|Run) /;
const MANAGED_DEBUG_RE = /^(Smile|Smilodon): Debug /;

function expandMacros(
  value: string,
  ctx: {
    projectDir: string;
    solutionDir: string;
    projectName: string;
    config: string;
    platform: string;
    outDir: string;
    targetFile: string;
  }
): string {
  const projectDir =
    ctx.projectDir.endsWith("\\") || ctx.projectDir.endsWith("/")
      ? ctx.projectDir
      : ctx.projectDir + path.sep;
  const solutionDir =
    ctx.solutionDir.endsWith("\\") || ctx.solutionDir.endsWith("/")
      ? ctx.solutionDir
      : ctx.solutionDir + path.sep;

  return value
    .replace(/\$\(ProjectDir\)/gi, projectDir)
    .replace(/\$\(SolutionDir\)/gi, solutionDir)
    .replace(/\$\(Configuration\)/gi, ctx.config)
    .replace(/\$\(Platform\)/gi, ctx.platform)
    .replace(/\$\(ProjectName\)/gi, ctx.projectName)
    .replace(/\$\(OutDir\)/gi, ctx.outDir)
    .replace(/\$\(TargetPath\)/gi, ctx.targetFile)
    .replace(/\$\(TargetFileName\)/gi, path.basename(ctx.targetFile))
    .replace(/%\([^)]+\)/g, "");
}

function splitList(value: string): string[] {
  return value
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("%("));
}

function toStdFlag(lang: LanguageStandard): string {
  switch (lang) {
    case "C++14":
      return "-std=c++14";
    case "C++17":
      return "-std=c++17";
    case "C++20":
      return "-std=c++20";
    case "C++23":
      return "-std=c++23";
    case "最新":
      return "-std=c++2b";
    default:
      return "-std=c++17";
  }
}

function toStdFlagMsvc(lang: LanguageStandard): string {
  switch (lang) {
    case "C++14":
      return "/std:c++14";
    case "C++17":
      return "/std:c++17";
    case "C++20":
      return "/std:c++20";
    case "C++23":
      return "/std:c++latest";
    case "最新":
      return "/std:c++latest";
    default:
      return "/std:c++17";
  }
}

function resolveExistingFile(candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.statSync(c).isFile()) {
      return c;
    }
  }
  return undefined;
}

function resolveCmake(): string {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  const candidates: string[] = [];
  try {
    const fromWhere = execFileSync("where.exe", ["cmake"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    candidates.push(...fromWhere);
  } catch {
    // ignore
  }
  if (fs.existsSync(vswhere)) {
    try {
      const fromVs = execFileSync(
        vswhere,
        ["-latest", "-products", "*", "-find", "Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe"],
        { encoding: "utf8", windowsHide: true, timeout: 8000 }
      )
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      candidates.push(...fromVs);
    } catch {
      // ignore
    }
  }
  candidates.push(
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "CMake", "bin", "cmake.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "CMake",
      "bin",
      "cmake.exe"
    ),
    "E:\\software\\cmake\\bin\\cmake.exe",
    "D:\\software\\cmake\\bin\\cmake.exe"
  );
  return resolveExistingFile(candidates) || "cmake";
}

function resolveVsCmakeGenerator(): string {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (fs.existsSync(vswhere)) {
    try {
      const major = execFileSync(
        vswhere,
        ["-latest", "-products", "*", "-property", "installationVersion"],
        { encoding: "utf8", windowsHide: true, timeout: 5000 }
      )
        .trim()
        .split(".")[0];
      if (major === "18") {
        return "Visual Studio 18 2026";
      }
      if (major === "17") {
        return "Visual Studio 17 2022";
      }
      if (major === "16") {
        return "Visual Studio 16 2019";
      }
    } catch {
      // fall through
    }
  }
  return "Visual Studio 17 2022";
}

function resolveMsbuild(): string {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (fs.existsSync(vswhere)) {
    try {
      const out = execFileSync(
        vswhere,
        [
          "-latest",
          "-requires",
          "Microsoft.Component.MSBuild",
          "-find",
          "MSBuild\\**\\Bin\\MSBuild.exe",
        ],
        { encoding: "utf8" }
      )
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0);
      if (out && fs.existsSync(out)) {
        return out;
      }
    } catch {
      // fall through
    }
  }

  const candidates = [
    process.env.MSBUILD_PATH,
    "E:\\software\\vs2026\\MSBuild\\Current\\Bin\\MSBuild.exe",
    path.join(
      process.env["ProgramFiles"] || "C:\\Program Files",
      "Microsoft Visual Studio",
      "2022",
      "Community",
      "MSBuild",
      "Current",
      "Bin",
      "MSBuild.exe"
    ),
    path.join(
      process.env["ProgramFiles"] || "C:\\Program Files",
      "Microsoft Visual Studio",
      "2022",
      "Professional",
      "MSBuild",
      "Current",
      "Bin",
      "MSBuild.exe"
    ),
  ].filter(Boolean) as string[];

  return resolveExistingFile(candidates) || "msbuild";
}

function resolveVsInstallPath(): string | undefined {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (!fs.existsSync(vswhere)) {
    return undefined;
  }
  try {
    const out = execFileSync(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      { encoding: "utf8", windowsHide: true }
    )
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return out && fs.existsSync(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

function resolveVcvars(platform: string): string | undefined {
  const install = resolveVsInstallPath();
  const bat =
    platform === "Win32" || platform === "x86"
      ? "vcvars32.bat"
      : "vcvars64.bat";
  const candidates = [
    install ? path.join(install, "VC", "Auxiliary", "Build", bat) : "",
    `E:\\software\\vs2026\\VC\\Auxiliary\\Build\\${bat}`,
    `D:\\software\\vs2026\\VC\\Auxiliary\\Build\\${bat}`,
    path.join(
      process.env["ProgramFiles"] || "C:\\Program Files",
      "Microsoft Visual Studio",
      "2022",
      "Community",
      "VC",
      "Auxiliary",
      "Build",
      bat
    ),
  ];
  return resolveExistingFile(candidates);
}

function resolveClExe(): string | undefined {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (fs.existsSync(vswhere)) {
    try {
      const out = execFileSync(
        vswhere,
        [
          "-latest",
          "-products",
          "*",
          "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          "-find",
          "VC\\Tools\\MSVC\\**\\bin\\Hostx64\\x64\\cl.exe",
        ],
        { encoding: "utf8", windowsHide: true }
      )
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && fs.existsSync(s));
      if (out) {
        return out;
      }
    } catch {
      // fall through
    }
  }
  return undefined;
}

function resolveCompiler(props: ProjectProperties): {
  kind: "gcc" | "clang" | "msvc";
  command: string;
} {
  const name = (props.compiler.name || "").toLowerCase();
  let p = (props.compiler.path || "").trim();

  if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const found = resolveExistingFile([
      path.join(p, "bin", "g++.exe"),
      path.join(p, "bin", "g++"),
      path.join(p, "bin", "clang++.exe"),
      path.join(p, "bin", "clang++"),
      path.join(p, "g++.exe"),
      path.join(p, "clang++.exe"),
      path.join(p, "cl.exe"),
    ]);
    if (found) {
      p = found;
    }
  }

  if (name.includes("clang") || /clang\+\+/i.test(p)) {
    return { kind: "clang", command: p || "clang++" };
  }
  if (
    name.includes("gcc") ||
    name.includes("mingw") ||
    /g\+\+/i.test(p) ||
    /mingw/i.test(p)
  ) {
    return { kind: "gcc", command: p || "g++" };
  }
  if (/g\+\+/i.test(p)) {
    return { kind: "gcc", command: p };
  }
  if (/clang\+\+/i.test(p)) {
    return { kind: "clang", command: p };
  }
  if (/cl\.exe$/i.test(p)) {
    return { kind: "msvc", command: p };
  }
  // 「自定义」但路径已指向 g++/clang++
  if (p && /\.exe$/i.test(p) && !/msbuild|cl\.exe/i.test(p)) {
    if (/clang/i.test(p)) {
      return { kind: "clang", command: p };
    }
    if (/g\+\+|c\+\+|gcc/i.test(p)) {
      return { kind: "gcc", command: p };
    }
  }
  // MSVC：folder 工程用 cl，.vcxproj 用 msbuild（调用方区分）
  return { kind: "msvc", command: p || resolveClExe() || resolveMsbuild() };
}

function collectFolderSources(rootDir: string): string[] {
  const skipDirs = new Set([
    ".git",
    ".smile",
    ".smilodon",
    ".vscode",
    ".vs",
    "node_modules",
    "x64",
    "win32",
    "debug",
    "release",
    "build",
    "build-smile",
    "build-smilodon",
    "out",
    "bin",
    "obj",
  ]);
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) {
      return [];
    }
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (skipDirs.has(entry.toLowerCase())) {
          continue;
        }
        out.push(...walk(full));
      } else if (/\.(cpp|cc|cxx|c)$/i.test(entry)) {
        out.push(full);
      }
    }
    return out;
  };
  return walk(rootDir);
}

function collectVcxprojSources(vcxprojPath: string): string[] {
  try {
    const xml = fs.readFileSync(vcxprojPath, "utf8");
    const dir = path.dirname(vcxprojPath);
    return [...xml.matchAll(/<ClCompile\s+Include="([^"]+)"/gi)].map((m) =>
      path.resolve(dir, m[1])
    );
  } catch {
    return [];
  }
}

function maybeAddGladSource(
  projectDir: string,
  includeDirs: string[],
  sources: string[]
): string[] {
  const already = sources.some((s) => /glad[/\\]gl\.c$/i.test(s) || /glad\.c$/i.test(s));
  if (already) {
    return sources;
  }
  const candidates = [
    ...includeDirs.map((d) => path.join(d, "glad", "gl.c")),
    path.join(projectDir, "..", "3rdParty", "glad", "gl.c"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return [...sources, c];
    }
  }
  return sources;
}

function libNameToLinkFlag(lib: string): string | undefined {
  const base = path.basename(lib).replace(/\.lib$/i, "").replace(/\.a$/i, "");
  if (!base || base.startsWith("%(")) {
    return undefined;
  }
  if (/^(msvcrtd?|ucrtd?|vcruntimed?)/i.test(base)) {
    return undefined;
  }
  return `-l${base.replace(/^lib/, "")}`;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 4) + "\n", "utf8");
}

function q(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

/**
 * cmd 参数引号：末尾 `\` 会转义收尾 `"`，需再补一个 `\`。
 * 例：`"...Debug\"` → 引号被吃掉，后续 `/p:OutDir=...` 会粘进路径。
 */
function qArg(value: string): string {
  let v = value.replace(/"/g, "");
  if (v.endsWith("\\")) {
    v += "\\";
  }
  return `"${v}"`;
}

/** Windows 路径引号：统一反斜杠，并避免收尾 `\` 转义引号 */
function qPath(value: string): string {
  return qArg(value.replace(/\//g, "\\"));
}

/** 相对工程目录解析输出路径，避免 path.resolve 落到进程 cwd */
function resolveUnder(baseDir: string, value: string): string {
  const normalized = value.replace(/\//g, "\\");
  if (path.isAbsolute(normalized)) {
    return path.normalize(normalized);
  }
  return path.resolve(baseDir, normalized);
}

/** MSBuild 目录属性：正斜杠 + 尾部 /，避免 shell 把 `\` 当转义 */
function msbuildDirProp(name: string, dir: string): string {
  let d = dir.replace(/\\/g, "/");
  if (!d.endsWith("/")) {
    d += "/";
  }
  return `/p:${name}=${d}`;
}

/** 是否为 Visual Studio 解决方案（含 VS2022+ 的 .slnx） */
function hasSolutionFile(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.slnx?$/i.test(f));
  } catch {
    return false;
  }
}

/** 向上查找 .sln / .slnx，使 $(SolutionDir) 与 Visual Studio 一致 */
function resolveSolutionDir(projectDir: string, workspaceRoot: string): string {
  let cur = projectDir;
  for (;;) {
    if (hasSolutionFile(cur)) {
      return cur;
    }
    if (path.resolve(cur) === path.resolve(workspaceRoot)) {
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  if (hasSolutionFile(workspaceRoot)) {
    return workspaceRoot;
  }
  // 无解决方案时 MSBuild 将 SolutionDir 设为工程目录
  return projectDir;
}

function writeRunScript(
  workspaceRoot: string,
  project: DiscoveredProject,
  buildCommand: string,
  buildArgs: string[],
  program: string,
  cwd: string
): string {
  const scriptPath = path.join(
    smileRoot(workspaceRoot),
    `run-${safeFileId(project.id)}.cmd`
  );
  const isBatch = /\.(cmd|bat)$/i.test(buildCommand);
  const argStr = buildArgs.map(qArg).join(" ");
  // 调用另一个 .cmd 必须用 call，否则构建结束后不会继续运行 exe
  const buildLine = isBatch
    ? `call ${qPath(buildCommand)}${argStr ? ` ${argStr}` : ""}`
    : `${qArg(buildCommand)}${argStr ? ` ${argStr}` : ""}`;
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "set PYTHONUTF8=1",
    `cd /d ${qPath(cwd)}`,
    buildLine,
    "if errorlevel 1 exit /b 1",
    `if not exist ${qPath(program)} (`,
    `  echo Smile: 未找到输出文件 ${program}`,
    "  exit /b 1",
    ")",
    // 不转发 Code Runner 附带的源文件参数
    qPath(program),
    "exit /b %ERRORLEVEL%",
  ];
  ensureDir(scriptPath);
  fs.writeFileSync(scriptPath, lines.join("\r\n") + "\r\n", "utf8");
  return scriptPath;
}

function safeFileId(name: string): string {
  return name.replace(/[^\w.-]+/g, "_") || "project";
}

function updateCodeRunnerSettings(
  workspaceRoot: string,
  project: DiscoveredProject,
  runScript: string,
  projectDir: string
): void {
  const file = path.join(workspaceRoot, ".vscode", "settings.json");
  let current: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) {
      current = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    current = {};
  }

  // chcp 已在 run-*.cmd 内；此处禁止外层再套引号，否则会拆成 call "path" 的残段
  const scriptCmd = `cmd.exe /c call ${qPath(runScript)}`;
  const executorMap = {
    ...((current["code-runner.executorMap"] as Record<string, string> | undefined) ?? {}),
    cpp: scriptCmd,
    c: scriptCmd,
    cc: scriptCmd,
    cxx: scriptCmd,
  };

  const rel = path.relative(workspaceRoot, projectDir).replace(/\\/g, "/");
  const globPrefix = rel && rel !== "." ? `${rel}/**` : "**";
  const byGlob = {
    ...((current["code-runner.executorMapByGlob"] as Record<string, string> | undefined) ??
      {}),
    [`${globPrefix}/*.{cpp,c,cc,cxx,h,hpp}`]: scriptCmd,
  };

  current["code-runner.runInTerminal"] = false;
  current["code-runner.saveFileBeforeRun"] = true;
  current["code-runner.clearPreviousOutput"] = true;
  current["code-runner.ignoreSelection"] = true;
  current["code-runner.showExecutionMessage"] = true;
  current["code-runner.fileDirectoryAsCwd"] = false;
  current["code-runner.executorMap"] = executorMap;
  current["code-runner.executorMapByGlob"] = byGlob;
  // 终端复用场景下也尽量用 UTF-8
  current["terminal.integrated.env.windows"] = {
    ...((current["terminal.integrated.env.windows"] as Record<string, string> | undefined) ?? {}),
    PYTHONUTF8: "1",
  };

  writeJson(file, current);
}

function updateCppProperties(
  workspaceRoot: string,
  project: DiscoveredProject,
  props: ProjectProperties,
  includeDirs: string[],
  defines: string[],
  compilerPath: string,
  std: string
): void {
  const file = path.join(workspaceRoot, ".vscode", "c_cpp_properties.json");
  let current: {
    configurations?: Array<Record<string, unknown>>;
    version?: number;
  } = { configurations: [], version: 4 };
  try {
    if (fs.existsSync(file)) {
      current = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    // recreate
  }

  const configName = `Smile:${project.name}`;
  const configs = Array.isArray(current.configurations) ? [...current.configurations] : [];
  const nextConfig = {
    name: configName,
    includePath: includeDirs,
    defines,
    compilerPath: compilerPath || undefined,
    cStandard: "c17",
    cppStandard: std.replace("-std=", ""),
    intelliSenseMode: /clang/i.test(compilerPath)
      ? "windows-clang-x64"
      : /g\+\+/i.test(compilerPath) || /gcc|mingw/i.test(props.compiler.name)
        ? "windows-gcc-x64"
        : "windows-msvc-x64",
  };

  const idx = configs.findIndex((c) => c.name === configName);
  if (idx >= 0) {
    configs[idx] = nextConfig;
  } else {
    configs.push(nextConfig);
  }

  writeJson(file, { configurations: configs, version: 4 });
}

function updateLaunchJson(
  workspaceRoot: string,
  project: DiscoveredProject,
  props: ProjectProperties,
  program: string,
  cwd: string,
  debuggerKind: "cppvsdbg" | "cppdbg",
  miDebuggerPath?: string
): void {
  const file = path.join(workspaceRoot, ".vscode", "launch.json");
  let current: { version?: string; configurations?: Array<Record<string, unknown>> } = {
    version: "0.2.0",
    configurations: [],
  };
  try {
    if (fs.existsSync(file)) {
      current = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    // recreate
  }

  const name = `Smile: Debug ${project.name}`;
  const configs = Array.isArray(current.configurations) ? [...current.configurations] : [];
  // 清掉所有历史 Smile 调试项，避免切换工具链后仍运行旧的 MSVC 配置
  const filtered = configs.filter(
    (c) => typeof c.name !== "string" || !MANAGED_DEBUG_RE.test(String(c.name))
  );

  const argList =
    props.debug.commandArguments.trim().length === 0
      ? []
      : props.debug.commandArguments
          .match(/(?:[^\s"]+|"[^"]*")+/g)
          ?.map((a) => a.replace(/^"|"$/g, "")) ?? [props.debug.commandArguments];

  const launch: Record<string, unknown> = {
    name,
    type: debuggerKind,
    request: "launch",
    program,
    args: argList,
    cwd,
    preLaunchTask: `${TASK_PREFIX}${project.name}`,
    stopAtEntry: false,
    console: "integratedTerminal",
  };

  if (debuggerKind === "cppdbg") {
    launch.MIMode = "gdb";
    launch.miDebuggerPath = miDebuggerPath || "gdb";
    launch.setupCommands = [
      {
        description: "Enable pretty-printing for gdb",
        text: "-enable-pretty-printing",
        ignoreFailures: true,
      },
    ];
  }

  writeJson(file, { version: "0.2.0", configurations: [launch, ...filtered] });
}

function updateTasksJson(
  workspaceRoot: string,
  project: DiscoveredProject,
  args: string[],
  command: string,
  cwd: string,
  program: string
): void {
  const file = path.join(workspaceRoot, ".vscode", "tasks.json");
  let current: { version?: string; tasks?: Array<Record<string, unknown>> } = {
    version: "2.0.0",
    tasks: [],
  };
  try {
    if (fs.existsSync(file)) {
      current = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    // recreate
  }

  const buildLabel = `${TASK_PREFIX}${project.name}`;
  const runLabel = `Smile: Run ${project.name}`;
  const tasks = Array.isArray(current.tasks) ? [...current.tasks] : [];

  // 清掉所有 Smile/Smilodon 托管任务
  const filtered = tasks.filter((t) => {
    if (t.detail === MANAGED_DETAIL || t.detail === MANAGED_DETAIL_LEGACY) {
      return false;
    }
    if (typeof t.label === "string" && MANAGED_LABEL_RE.test(t.label)) {
      return false;
    }
    return true;
  });

  const isBatch = /\.(cmd|bat)$/i.test(command);
  const buildCommand = isBatch ? "cmd.exe" : command;
  const buildArgs = isBatch ? ["/c", "call", command, ...args] : args;
  const matcher =
    /g\+\+|clang/i.test(command) || /g\+\+|clang/i.test(buildArgs.join(" "))
      ? "$gcc"
      : "$msCompile";

  const buildTask: Record<string, unknown> = {
    label: buildLabel,
    type: "shell",
    command: buildCommand,
    args: buildArgs,
    options: { cwd },
    problemMatcher: [matcher],
    group: { kind: "build", isDefault: true },
    detail: MANAGED_DETAIL,
  };

  const runTask: Record<string, unknown> = {
    label: runLabel,
    dependsOn: buildLabel,
    type: "shell",
    command: "cmd.exe",
    args: ["/c", "call", program],
    options: { cwd },
    problemMatcher: [],
    group: { kind: "test", isDefault: true },
    detail: MANAGED_DETAIL,
    presentation: { reveal: "always", panel: "dedicated" },
  };

  for (const t of filtered) {
    if (t.group && typeof t.group === "object") {
      const g = t.group as { kind?: string; isDefault?: boolean };
      if (g.kind === "build" || g.kind === "test") {
        t.group = { kind: g.kind, isDefault: false };
      }
    }
  }

  writeJson(file, { version: "2.0.0", tasks: [buildTask, runTask, ...filtered] });
}

function cleanupStaleSmileScripts(workspaceRoot: string, keepFiles: string[]): void {
  const keep = new Set(keepFiles);
  const current = path.resolve(smileRoot(workspaceRoot));
  const dirs = [current, ...legacySmileRoots(workspaceRoot).map((d) => path.resolve(d))];
  for (const dir of new Set(dirs)) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir)) {
      if (!/^(build|run)-.+\.cmd$/i.test(name)) {
        continue;
      }
      // 旧目录下的脚本一律清理；新目录只删多余项
      const isLegacy = dir !== current;
      if (!isLegacy && keep.has(name)) {
        continue;
      }
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // ignore
      }
    }
  }
}

function resolveCmakeTargetExe(
  buildDir: string,
  targetName: string,
  config: string,
  msvcStyle: boolean
): string {
  const exe = `${targetName}.exe`;
  const candidates = msvcStyle
    ? [
        path.join(buildDir, config, exe),
        path.join(buildDir, "bin", config, exe),
        path.join(buildDir, config, targetName, exe),
        path.join(buildDir, exe),
        path.join(buildDir, "bin", exe),
      ]
    : [
        path.join(buildDir, exe),
        path.join(buildDir, "bin", exe),
        path.join(buildDir, config, exe),
        path.join(buildDir, "bin", config, exe),
      ];
  return (
    resolveExistingFile(candidates) ||
    (msvcStyle ? path.join(buildDir, config, exe) : path.join(buildDir, exe))
  );
}

function writeCmakeBuildScript(
  workspaceRoot: string,
  project: DiscoveredProject,
  projectDir: string,
  buildDir: string,
  compiler: { kind: "gcc" | "clang" | "msvc"; command: string },
  config: string,
  platform: string
): string {
  const scriptPath = path.join(
    smileRoot(workspaceRoot),
    `build-${safeFileId(project.id)}.cmd`
  );
  const cmake = resolveCmake();
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "setlocal",
    `cd /d ${qPath(projectDir)}`,
  ];

  if (compiler.kind === "msvc") {
    const arch = platform === "Win32" || /x86/i.test(platform) ? "Win32" : "x64";
    const gen = resolveVsCmakeGenerator();
    lines.push(
      `${qPath(cmake)} -S ${qPath(projectDir)} -B ${qPath(buildDir)} -G ${q(gen)} -A ${arch}`,
      "if errorlevel 1 exit /b 1",
      `${qPath(cmake)} --build ${qPath(buildDir)} --config ${config} --parallel`,
      "exit /b %ERRORLEVEL%"
    );
  } else {
    const binDir = path.dirname(compiler.command);
    const gcc =
      resolveExistingFile([
        path.join(binDir, "gcc.exe"),
        path.join(binDir, "gcc"),
        path.join(binDir, "clang.exe"),
      ]) || "gcc";
    const buildType = /release/i.test(config) ? "Release" : "Debug";
    lines.push(
      `set "PATH=${binDir};%PATH%"`,
      `${qPath(cmake)} -S ${qPath(projectDir)} -B ${qPath(buildDir)} -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=${buildType} -DCMAKE_CXX_COMPILER=${qPath(compiler.command)} -DCMAKE_C_COMPILER=${q(gcc)}`,
      "if errorlevel 1 exit /b 1",
      `${qPath(cmake)} --build ${qPath(buildDir)} --parallel`,
      "exit /b %ERRORLEVEL%"
    );
  }

  ensureDir(scriptPath);
  fs.writeFileSync(scriptPath, lines.join("\r\n") + "\r\n", "utf8");
  return scriptPath;
}

export function syncVsCodeBuildFromProject(
  workspaceRoot: string,
  project: DiscoveredProject,
  props: ProjectProperties
): string {
  const projectDir =
    project.kind === "vcxproj"
      ? path.dirname(project.path)
      : project.kind === "cmake"
        ? project.path
        : workspaceRoot;
  const solutionDir =
    project.kind === "vcxproj"
      ? resolveSolutionDir(projectDir, workspaceRoot)
      : workspaceRoot;
  const projectName = project.name;
  const config = props.configuration.config;
  const platform = props.configuration.platform;

  const macroCtxBase = {
    projectDir,
    solutionDir,
    projectName,
    config,
    platform,
    outDir: "",
    targetFile: "",
  };

  // 默认：CMake 用 build；其余用工程目录。最终都以「输出目录」设置为准。
  const defaultOut =
    project.kind === "cmake"
      ? path.join(projectDir, "build") + path.sep
      : projectDir + path.sep;
  const outDirRaw = expandMacros(props.general.outputDirectory || defaultOut, {
    ...macroCtxBase,
    outDir: defaultOut,
    targetFile: "",
  });
  const outDir = resolveUnder(projectDir, outDirRaw);
  const cmakeBuildDir = outDir;
  const ext = props.advanced.targetFileExtension || ".exe";
  let targetName = expandMacros(props.general.targetFileName || projectName, {
    ...macroCtxBase,
    outDir: outDir + path.sep,
    targetFile: "",
  }).trim();
  // 若目标名被写成路径，只取文件名，避免拼出错误 exe 路径
  targetName = path.basename(targetName.replace(/\\/g, "/"));
  if (!targetName) {
    targetName = projectName;
  }
  const targetExt = ext.startsWith(".") ? ext : `.${ext}`;
  if (/\.(exe|dll|lib)$/i.test(targetName)) {
    targetName = targetName.replace(/\.(exe|dll|lib)$/i, "");
  }
  let targetFile = path.join(outDir, `${targetName}${targetExt}`);

  const ctx = { ...macroCtxBase, outDir: outDir + path.sep, targetFile };

  const intDirRaw = expandMacros(
    props.general.intermediateDirectory ||
      "$(SolutionDir)$(Platform)\\$(Configuration)\\$(Configuration)Info\\",
    ctx
  );
  const intDir = resolveUnder(projectDir, intDirRaw);

  const resolveDebugPath = (value: string, fallback: string): string => {
    const raw = (value || "").trim() || fallback;
    const expanded = expandMacros(raw, ctx);
    if (!expanded || expanded === "$(TargetPath)") {
      return targetFile;
    }
    return path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(projectDir, expanded);
  };

  const debugProgram = resolveDebugPath(props.debug.command, "$(TargetPath)");
  const debugCwd = resolveDebugPath(props.debug.workingDirectory, "$(ProjectDir)");

  const resolveFromProject = (value: string): string => {
    const expanded = expandMacros(value, ctx);
    return path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(projectDir, expanded);
  };

  const includeDirs = splitList(props.cpp.additionalIncludeDirectories).map(resolveFromProject);
  if (!includeDirs.includes(projectDir)) {
    includeDirs.unshift(projectDir);
  }

  const libDirs = splitList(props.cpp.additionalLibraryDirectories).map(resolveFromProject);
  const defines = splitList(props.cpp.preprocessorDefinitions);
  const deps = splitList(props.cpp.additionalDependencies);

  const compiler = resolveCompiler(props);
  const stdFlag = toStdFlag(props.general.languageStandard);

  // CMake：configure + build（MSVC 用 VS 生成器，MinGW64 用 MinGW Makefiles）
  // -B / 产物查找目录 = 展开后的「输出目录」
  if (project.kind === "cmake") {
    const msvcStyle = compiler.kind === "msvc";
    targetFile = resolveCmakeTargetExe(cmakeBuildDir, targetName, config, msvcStyle);
    const cmakeDebugProgram = resolveDebugPath(props.debug.command, "$(TargetPath)");
    // resolveDebugPath 闭包仍用旧 targetFile；若用户未改 command，强制用 cmake 输出
    const program =
      !(props.debug.command || "").trim() ||
      (props.debug.command || "").trim() === "$(TargetPath)"
        ? targetFile
        : cmakeDebugProgram;
    const cwd =
      !(props.debug.workingDirectory || "").trim() ||
      (props.debug.workingDirectory || "").trim() === "$(ProjectDir)"
        ? projectDir
        : resolveDebugPath(props.debug.workingDirectory, "$(ProjectDir)");

    const buildScript = writeCmakeBuildScript(
      workspaceRoot,
      project,
      projectDir,
      cmakeBuildDir,
      compiler,
      config,
      platform
    );
    updateTasksJson(workspaceRoot, project, [], buildScript, projectDir, program);
    updateLaunchJson(
      workspaceRoot,
      project,
      props,
      program,
      cwd,
      msvcStyle ? "cppvsdbg" : "cppdbg",
      msvcStyle
        ? undefined
        : resolveExistingFile([
            path.join(path.dirname(compiler.command), "gdb.exe"),
            path.join(path.dirname(compiler.command), "gdb"),
          ]) || "gdb"
    );
    const runScript = writeRunScript(
      workspaceRoot,
      project,
      buildScript,
      [],
      program,
      cwd
    );
    updateCodeRunnerSettings(workspaceRoot, project, runScript, projectDir);
    updateCppProperties(
      workspaceRoot,
      project,
      props,
      includeDirs,
      defines,
      msvcStyle ? resolveClExe() || "" : compiler.command,
      stdFlag
    );
    cleanupStaleSmileScripts(workspaceRoot, [
      path.basename(buildScript),
      path.basename(runScript),
    ]);
    return `已同步 VS Code 构建/调试/运行: ${TASK_PREFIX}${project.name}（CMake / ${msvcStyle ? "MSVC" : "MinGW64"}）`;
  }

  // MSVC：用 MSBuild；MinGW64：用 g++（含 .vcxproj）
  // 显式传入 SolutionDir/OutDir/IntDir，与侧栏「输出/中间目录」及调试路径一致
  if (project.kind === "vcxproj" && compiler.kind === "msvc") {
    const msbuild = resolveMsbuild();
    const args = [
      project.path,
      `/p:Configuration=${config}`,
      `/p:Platform=${platform === "Win32" ? "Win32" : platform}`,
      msbuildDirProp("SolutionDir", solutionDir),
      msbuildDirProp("OutDir", outDir),
      msbuildDirProp("IntDir", intDir),
    ];
    updateTasksJson(workspaceRoot, project, args, msbuild, projectDir, debugProgram);
    updateLaunchJson(
      workspaceRoot,
      project,
      props,
      debugProgram,
      debugCwd,
      "cppvsdbg"
    );
    const runScript = writeRunScript(
      workspaceRoot,
      project,
      msbuild,
      args,
      debugProgram,
      debugCwd
    );
    updateCodeRunnerSettings(workspaceRoot, project, runScript, projectDir);
    updateCppProperties(
      workspaceRoot,
      project,
      props,
      includeDirs,
      defines,
      "",
      stdFlag
    );
    cleanupStaleSmileScripts(workspaceRoot, [path.basename(runScript)]);
    return `已同步 VS Code 构建/调试/运行: ${TASK_PREFIX}${project.name}（MSVC / MSBuild）`;
  }

  // 无 .vcxproj 的文件夹工程：MSVC 用 vcvars + cl.exe
  if (compiler.kind === "msvc") {
    const vcvars = resolveVcvars(platform);
    if (!vcvars) {
      throw new Error(
        "未找到 vcvars64.bat / Visual Studio C++ 工具集。请安装「使用 C++ 的桌面开发」，或改用 MinGW64。"
      );
    }

    let sources = collectFolderSources(projectDir);
    if (!sources.length) {
      throw new Error(`在 ${projectDir} 下未找到 .cpp/.c 源文件`);
    }

    const intDirSlash = intDir.endsWith("\\") || intDir.endsWith("/") ? intDir : intDir + "\\";

    const isDebug = /debug/i.test(config);
    const clParts: string[] = [
      "cl",
      "/nologo",
      "/EHsc",
      "/W3",
      "/utf-8",
      toStdFlagMsvc(props.general.languageStandard),
    ];
    if (isDebug) {
      clParts.push("/Zi", "/Od", "/MDd");
    } else {
      clParts.push("/O2", "/MD");
    }
    for (const d of includeDirs) {
      clParts.push(`/I${qPath(d)}`);
    }
    for (const d of defines) {
      if (d) {
        clParts.push(`/D${d}`);
      }
    }
    clParts.push(`/Fo${qPath(intDirSlash)}`);
    clParts.push(`/Fe${qPath(targetFile)}`);
    for (const s of sources) {
      clParts.push(qPath(s));
    }

    const linkParts: string[] = [];
    for (const d of libDirs) {
      linkParts.push(`/LIBPATH:${qPath(d)}`);
    }
    for (const lib of deps) {
      const base = path.basename(lib);
      if (base && !base.startsWith("%(")) {
        linkParts.push(base.endsWith(".lib") ? base : `${base}.lib`);
      }
    }
    if (linkParts.length) {
      clParts.push("/link", ...linkParts);
    }

    ensureDir(targetFile);
    ensureDir(path.join(intDirSlash, "dummy"));

    const buildScript = path.join(
      smileRoot(workspaceRoot),
      `build-${safeFileId(project.id)}.cmd`
    );
    const buildLines = [
      "@echo off",
      "chcp 65001 >nul",
      "setlocal",
      `cd /d ${qPath(projectDir)}`,
      `call ${qPath(vcvars)}`,
      "if errorlevel 1 exit /b 1",
      `if not exist ${qPath(outDir)} mkdir ${qPath(outDir)}`,
      `if not exist ${qPath(intDir)} mkdir ${qPath(intDir)}`,
      clParts.join(" "),
      "exit /b %ERRORLEVEL%",
    ];
    ensureDir(buildScript);
    fs.writeFileSync(buildScript, buildLines.join("\r\n") + "\r\n", "utf8");

    updateTasksJson(workspaceRoot, project, [], buildScript, projectDir, debugProgram);
    updateLaunchJson(
      workspaceRoot,
      project,
      props,
      debugProgram,
      debugCwd,
      "cppvsdbg"
    );
    const runScript = writeRunScript(
      workspaceRoot,
      project,
      buildScript,
      [],
      debugProgram,
      debugCwd
    );
    updateCodeRunnerSettings(workspaceRoot, project, runScript, projectDir);
    updateCppProperties(
      workspaceRoot,
      project,
      props,
      includeDirs,
      defines,
      resolveClExe() || "",
      toStdFlag(props.general.languageStandard)
    );
    cleanupStaleSmileScripts(workspaceRoot, [
      path.basename(buildScript),
      path.basename(runScript),
    ]);
    return `已同步 VS Code 构建/调试/运行: ${TASK_PREFIX}${project.name}（MSVC / cl.exe）`;
  }

  let sources =
    project.kind === "vcxproj" ? collectVcxprojSources(project.path) : [];
  if (!sources.length) {
    sources = collectFolderSources(projectDir);
  }
  sources = maybeAddGladSource(projectDir, includeDirs, sources);

  const args: string[] = [
    "-fdiagnostics-color=always",
    "-g",
    "-finput-charset=UTF-8",
    "-fexec-charset=UTF-8",
    stdFlag,
  ];
  for (const d of includeDirs) {
    args.push(`-I${d}`);
  }
  for (const d of defines) {
    args.push(`-D${d}`);
  }
  for (const s of sources) {
    args.push(s);
  }
  for (const d of libDirs) {
    args.push(`-L${d}`);
  }
  for (const lib of deps) {
    if (/glad\.lib$/i.test(lib) && sources.some((s) => /gl\.c$/i.test(s))) {
      continue;
    }
    const flag = libNameToLinkFlag(lib);
    if (flag) {
      args.push(flag);
    }
  }
  if (deps.some((d) => /opengl32/i.test(d)) || sources.some((s) => /glad/i.test(s))) {
    if (!args.includes("-lopengl32")) {
      args.push("-lopengl32");
    }
    if (!args.includes("-lgdi32")) {
      args.push("-lgdi32");
    }
  }

  ensureDir(targetFile);
  args.push("-o", targetFile);

  updateTasksJson(workspaceRoot, project, args, compiler.command, projectDir, debugProgram);

  const gdb =
    resolveExistingFile([
      path.join(path.dirname(compiler.command), "gdb.exe"),
      path.join(path.dirname(compiler.command), "gdb"),
      "E:\\software\\mingw64\\bin\\gdb.exe",
    ]) || "gdb";
  updateLaunchJson(
    workspaceRoot,
    project,
    props,
    debugProgram,
    debugCwd,
    "cppdbg",
    gdb
  );

  const runScript = writeRunScript(
    workspaceRoot,
    project,
    compiler.command,
    args,
    debugProgram,
    debugCwd
  );
  updateCodeRunnerSettings(workspaceRoot, project, runScript, projectDir);

  updateCppProperties(
    workspaceRoot,
    project,
    props,
    includeDirs,
    defines,
    compiler.command,
    stdFlag
  );

  cleanupStaleSmileScripts(workspaceRoot, [path.basename(runScript)]);
  return `已同步 VS Code 构建/调试/运行（${TASK_PREFIX}${project.name}，含 Code Runner）`;
}
