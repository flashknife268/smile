import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { detectCompilers } from "./compilerDetect";
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
    case "C++20":
      return "-std=c++20";
    case "C++23":
      return "-std=c++23";
    default:
      return "-std=c++17";
  }
}

function targetKind(type: string): "exe" | "shared" | "static" {
  if (type.includes("动态") || /dll|shared/i.test(type)) {
    return "shared";
  }
  if (type.includes("静态") || /static|\.lib|\.a\b/i.test(type)) {
    return "static";
  }
  return "exe";
}

function targetExtension(type: string): string {
  const kind = targetKind(type);
  if (kind === "shared") {
    return ".dll";
  }
  if (kind === "static") {
    return ".a";
  }
  return ".exe";
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
  candidates.push(
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "CMake", "bin", "cmake.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "CMake",
      "bin",
      "cmake.exe"
    )
  );
  return resolveExistingFile(candidates) || "cmake";
}

function resolveNinja(): string | undefined {
  try {
    const fromWhere = execFileSync("where.exe", ["ninja"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && fs.existsSync(s));
    if (fromWhere) {
      return fromWhere;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function isMsvcToolchainPath(value: string): boolean {
  return /msbuild|cl\.exe|visual studio|vcvars/i.test(value);
}

function resolveCompiler(props: ProjectProperties): {
  kind: "gcc" | "clang";
  command: string;
} {
  let p = (props.compiler.path || "").trim();
  if (isMsvcToolchainPath(p)) {
    p = "";
  }

  if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const preferClang = props.compiler.name === "Clang";
    const found = resolveExistingFile(
      preferClang
        ? [
            path.join(p, "bin", "clang++.exe"),
            path.join(p, "bin", "clang++"),
            path.join(p, "clang++.exe"),
            path.join(p, "bin", "g++.exe"),
            path.join(p, "bin", "g++"),
          ]
        : [
            path.join(p, "bin", "g++.exe"),
            path.join(p, "bin", "g++"),
            path.join(p, "g++.exe"),
            path.join(p, "bin", "clang++.exe"),
            path.join(p, "bin", "clang++"),
          ]
    );
    if (found) {
      p = found;
    }
  }

  if (p && fs.existsSync(p) && fs.statSync(p).isFile() && !isMsvcToolchainPath(p)) {
    return {
      kind: /clang/i.test(p) || props.compiler.name === "Clang" ? "clang" : "gcc",
      command: p,
    };
  }

  const detected = detectCompilers().find((c) => {
    if (props.compiler.name === "Clang") {
      return c.kind === "clang";
    }
    return c.kind === "gcc";
  }) || detectCompilers().find((c) => c.command);
  if (detected?.command) {
    return { kind: detected.kind, command: detected.command };
  }

  throw new Error("未找到 g++ 或 clang++。请安装 MinGW-w64 或 LLVM，并在工具链里指定路径。");
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
  includeDirs: string[],
  defines: string[],
  compilerPath: string,
  std: string,
  compileCommands?: string
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
  const nextConfig: Record<string, unknown> = {
    name: configName,
    compilerPath: compilerPath || undefined,
    cStandard: "c17",
    cppStandard: std.replace("-std=", ""),
    intelliSenseMode: /clang/i.test(compilerPath) ? "windows-clang-x64" : "windows-gcc-x64",
  };
  if (compileCommands) {
    nextConfig.compileCommands = compileCommands;
  } else {
    nextConfig.includePath = includeDirs;
    nextConfig.defines = defines;
  }

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
    type: "cppdbg",
    request: "launch",
    program,
    args: argList,
    cwd,
    preLaunchTask: `${TASK_PREFIX}${project.name}`,
    stopAtEntry: false,
    console: "integratedTerminal",
    MIMode: "gdb",
    miDebuggerPath: miDebuggerPath || "gdb",
    setupCommands: [
      {
        description: "Enable pretty-printing for gdb",
        text: "-enable-pretty-printing",
        ignoreFailures: true,
      },
    ],
  };

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
  const matcher = "$gcc";

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

function resolveCmakeTargetExe(buildDir: string, targetName: string): string {
  const exe = `${targetName}.exe`;
  const candidates = [
    path.join(buildDir, exe),
    path.join(buildDir, "bin", exe),
    path.join(buildDir, "Debug", exe),
    path.join(buildDir, "Release", exe),
  ];
  return resolveExistingFile(candidates) || path.join(buildDir, exe);
}

function writeCmakeBuildScript(
  workspaceRoot: string,
  project: DiscoveredProject,
  projectDir: string,
  buildDir: string,
  compiler: { kind: "gcc" | "clang"; command: string },
  config: string
): string {
  const scriptPath = path.join(
    smileRoot(workspaceRoot),
    `build-${safeFileId(project.id)}.cmd`
  );
  const cmake = resolveCmake();
  const ninja = resolveNinja();
  const binDir = path.dirname(compiler.command);
  const cc =
    resolveExistingFile([
      path.join(binDir, compiler.kind === "clang" ? "clang.exe" : "gcc.exe"),
      path.join(binDir, compiler.kind === "clang" ? "clang" : "gcc"),
    ]) || (compiler.kind === "clang" ? "clang" : "gcc");
  const buildType = /release/i.test(config) ? "Release" : "Debug";
  const generator = ninja ? "Ninja" : "MinGW Makefiles";
  const pathPrefix = [ninja ? path.dirname(ninja) : "", binDir].filter(Boolean).join(";");
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "setlocal",
    `cd /d ${qPath(projectDir)}`,
    `set "PATH=${pathPrefix};%PATH%"`,
    `${qPath(cmake)} -S ${qPath(projectDir)} -B ${qPath(buildDir)} -G ${q(generator)} -DCMAKE_BUILD_TYPE=${buildType} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_CXX_COMPILER=${qPath(compiler.command)} -DCMAKE_C_COMPILER=${qPath(cc)}`,
    "if errorlevel 1 exit /b 1",
    `${qPath(cmake)} --build ${qPath(buildDir)} --parallel`,
    "exit /b %ERRORLEVEL%",
  ];

  ensureDir(scriptPath);
  fs.writeFileSync(scriptPath, lines.join("\r\n") + "\r\n", "utf8");
  return scriptPath;
}

function resolveGdb(compilerCommand: string): string {
  return (
    resolveExistingFile([
      path.join(path.dirname(compilerCommand), "gdb.exe"),
      path.join(path.dirname(compilerCommand), "gdb"),
    ]) || "gdb"
  );
}

function compileFlags(
  config: string,
  stdFlag: string,
  includeDirs: string[],
  defines: string[]
): string[] {
  const flags = [
    "-fdiagnostics-color=always",
    "-finput-charset=UTF-8",
    "-fexec-charset=UTF-8",
    "-Wall",
    stdFlag,
  ];
  if (/release/i.test(config)) {
    flags.push("-O2", "-DNDEBUG");
  } else {
    flags.push("-g", "-O0");
  }
  for (const dir of includeDirs) {
    flags.push(`-I${dir}`);
  }
  for (const def of defines) {
    if (def) {
      flags.push(`-D${def}`);
    }
  }
  return flags;
}

function writeStaticLibScript(
  workspaceRoot: string,
  project: DiscoveredProject,
  projectDir: string,
  outDir: string,
  compiler: string,
  flags: string[],
  sources: string[],
  targetFile: string
): string {
  const scriptPath = path.join(smileRoot(workspaceRoot), `build-${safeFileId(project.id)}.cmd`);
  const ar =
    resolveExistingFile([
      path.join(path.dirname(compiler), "ar.exe"),
      path.join(path.dirname(compiler), "ar"),
    ]) || "ar";
  const objects: string[] = [];
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "setlocal",
    `cd /d ${qPath(projectDir)}`,
    `if not exist ${qPath(outDir)} mkdir ${qPath(outDir)}`,
  ];
  sources.forEach((source, index) => {
    const obj = path.join(outDir, `${index}_${path.basename(source)}.o`);
    objects.push(obj);
    const flagStr = flags.map(qArg).join(" ");
    lines.push(
      `${qPath(compiler)} -c ${flagStr} -o ${qPath(obj)} ${qPath(source)}`,
      "if errorlevel 1 exit /b 1"
    );
  });
  lines.push(
    `${qPath(ar)} rcs ${qPath(targetFile)} ${objects.map(qPath).join(" ")}`,
    "exit /b %ERRORLEVEL%"
  );
  ensureDir(scriptPath);
  fs.writeFileSync(scriptPath, lines.join("\r\n") + "\r\n", "utf8");
  return scriptPath;
}

export function syncVsCodeBuildFromProject(
  workspaceRoot: string,
  project: DiscoveredProject,
  props: ProjectProperties
): string {
  const projectDir = project.kind === "cmake" ? project.path : workspaceRoot;
  const projectName = project.name;
  const config = props.configuration.config;

  const macroCtxBase = {
    projectDir,
    solutionDir: projectDir,
    projectName,
    config,
    platform: "x64",
    outDir: "",
    targetFile: "",
  };

  const defaultOut = path.join(projectDir, "build") + path.sep;
  const outDirRaw = expandMacros(props.general.outputDirectory || "build", {
    ...macroCtxBase,
    outDir: defaultOut,
    targetFile: "",
  });
  const outDir = resolveUnder(projectDir, outDirRaw);
  let targetName = expandMacros(props.general.targetFileName || projectName, {
    ...macroCtxBase,
    outDir: outDir + path.sep,
    targetFile: "",
  }).trim();
  targetName = path.basename(targetName.replace(/\\/g, "/"));
  if (!targetName) {
    targetName = projectName;
  }
  targetName = targetName.replace(/\.(exe|dll|lib|a)$/i, "");
  const kind = targetKind(props.general.configurationType);
  let targetFile = path.join(outDir, `${targetName}${targetExtension(props.general.configurationType)}`);

  const ctx = { ...macroCtxBase, outDir: outDir + path.sep, targetFile };

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

  const debugCwd = resolveDebugPath(props.debug.workingDirectory, "$(ProjectDir)");

  const resolveFromProject = (value: string): string => {
    const expanded = expandMacros(value, ctx);
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(projectDir, expanded);
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
  const toolchain = compiler.kind === "clang" ? "Clang" : "GCC";
  const gdb = resolveGdb(compiler.command);

  if (project.kind === "cmake") {
    targetFile = resolveCmakeTargetExe(outDir, targetName);
    const program = (props.debug.command || "").trim() ? resolveDebugPath(props.debug.command, "$(TargetPath)") : targetFile;
    const cwd = (props.debug.workingDirectory || "").trim()
      ? resolveDebugPath(props.debug.workingDirectory, "$(ProjectDir)")
      : projectDir;
    const buildScript = writeCmakeBuildScript(
      workspaceRoot,
      project,
      projectDir,
      outDir,
      compiler,
      config
    );
    updateTasksJson(workspaceRoot, project, [], buildScript, projectDir, program);
    updateLaunchJson(workspaceRoot, project, props, program, cwd, gdb);
    const runScript = writeRunScript(workspaceRoot, project, buildScript, [], program, cwd);
    updateCodeRunnerSettings(workspaceRoot, project, runScript, projectDir);
    updateCppProperties(
      workspaceRoot,
      project,
      includeDirs,
      defines,
      compiler.command,
      stdFlag,
      path.join(outDir, "compile_commands.json")
    );
    cleanupStaleSmileScripts(workspaceRoot, [path.basename(buildScript), path.basename(runScript)]);
    return `已同步构建与调试: ${TASK_PREFIX}${project.name}（CMake / ${toolchain}）`;
  }

  const sources = collectFolderSources(projectDir);
  if (!sources.length) {
    updateCppProperties(workspaceRoot, project, includeDirs, defines, compiler.command, stdFlag);
    return `已保存设置。${projectDir} 里还没有 .cpp / .c，放入源文件后再次保存即可构建。`;
  }

  const flags = compileFlags(config, stdFlag, includeDirs, defines);
  ensureDir(path.join(outDir, "dummy"));

  let buildCommand = compiler.command;
  let buildArgs: string[] = [];
  if (kind === "static") {
    buildCommand = writeStaticLibScript(
      workspaceRoot,
      project,
      projectDir,
      outDir,
      compiler.command,
      flags,
      sources,
      targetFile
    );
  } else {
    buildArgs = [...flags];
    if (kind === "shared") {
      buildArgs.push("-shared");
    }
    buildArgs.push(...sources);
    for (const dir of libDirs) {
      buildArgs.push(`-L${dir}`);
    }
    for (const lib of deps) {
      const flag = libNameToLinkFlag(lib);
      if (flag) {
        buildArgs.push(flag);
      }
    }
    buildArgs.push("-o", targetFile);
  }

  const program = (props.debug.command || "").trim()
    ? resolveDebugPath(props.debug.command, "$(TargetPath)")
    : targetFile;
  updateTasksJson(workspaceRoot, project, buildArgs, buildCommand, projectDir, program);
  updateLaunchJson(workspaceRoot, project, props, program, debugCwd, gdb);
  const runScript = writeRunScript(workspaceRoot, project, buildCommand, buildArgs, program, debugCwd);
  updateCodeRunnerSettings(workspaceRoot, project, runScript, projectDir);
  updateCppProperties(workspaceRoot, project, includeDirs, defines, compiler.command, stdFlag);
  cleanupStaleSmileScripts(workspaceRoot, [
    path.basename(runScript),
    ...(kind === "static" ? [path.basename(buildCommand)] : []),
  ]);
  const product = kind === "static" ? "静态库" : kind === "shared" ? "动态库" : "可执行文件";
  return `已同步构建与调试: ${TASK_PREFIX}${project.name}（${toolchain} / ${product}）`;
}
