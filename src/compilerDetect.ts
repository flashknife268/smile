import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type CompilerKind = "msvc" | "mingw64" | "gcc" | "clang";

export interface DetectedCompiler {
  kind: CompilerKind;
  /** Smile UI 中的编译器名称 */
  name: "MSVC" | "MinGW64" | "GCC" | "Clang";
  /** 写入项目属性的路径（目录或可执行文件） */
  path: string;
  /** 实际编译器可执行文件（若有） */
  command?: string;
  version?: string;
  label: string;
}

function existsFile(p: string): boolean {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p: string): boolean {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function uniqByPath(items: DetectedCompiler[]): DetectedCompiler[] {
  const seen = new Set<string>();
  const out: DetectedCompiler[] = [];
  for (const item of items) {
    const key = path.normalize(item.path).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function readVersion(exe: string, args: string[] = ["--version"]): string | undefined {
  try {
    const out = execFileSync(exe, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const line = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (!line) {
      return undefined;
    }
    const m =
      /(\d+\.\d+(?:\.\d+)?)/.exec(line) ||
      /version\s+(\d+\.\d+(?:\.\d+)?)/i.exec(line);
    return m?.[1] ?? line.slice(0, 48);
  } catch {
    return undefined;
  }
}

function whichAll(command: string): string[] {
  try {
    const out = execFileSync("where.exe", [command], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && existsFile(s));
  } catch {
    return [];
  }
}

function pushMingwRoot(roots: string[], root: string): void {
  if (!root || !existsDir(root)) {
    return;
  }
  const gpp = path.join(root, "bin", "g++.exe");
  const gppAlt = path.join(root, "bin", "g++");
  if (existsFile(gpp) || existsFile(gppAlt)) {
    roots.push(path.normalize(root));
  }
}

function discoverMingwRoots(): string[] {
  const roots: string[] = [];
  const home = os.homedir();
  const drives = ["C", "D", "E", "F"];
  const baseNames = [
    "mingw64",
    "mingw-w64",
    "MinGW",
    "mingw",
    path.join("msys64", "mingw64"),
    path.join("msys64", "ucrt64"),
    path.join("msys64", "clang64"),
    path.join("msys2", "mingw64"),
    path.join("msys2", "ucrt64"),
    path.join("tools", "mingw64"),
    path.join("software", "mingw64"),
    path.join("dev", "mingw64"),
  ];

  for (const drive of drives) {
    for (const name of baseNames) {
      pushMingwRoot(roots, `${drive}:\\${name}`);
      pushMingwRoot(roots, `${drive}:\\Program Files\\${name}`);
      pushMingwRoot(roots, `${drive}:\\Program Files (x86)\\${name}`);
    }
    // winlibs / zig-style layouts
    pushMingwRoot(roots, `${drive}:\\mingw64`);
  }

  const envRoots = [
    process.env.MINGW_HOME,
    process.env.MINGW64_HOME,
    process.env.MSYSTEM_PREFIX,
    process.env.GCC_PATH,
  ].filter(Boolean) as string[];
  for (const r of envRoots) {
    pushMingwRoot(roots, r);
    pushMingwRoot(roots, path.dirname(r));
    // if env points to bin
    if (/[\\/]bin$/i.test(r)) {
      pushMingwRoot(roots, path.dirname(r));
    }
  }

  for (const gpp of whichAll("g++.exe").concat(whichAll("g++"))) {
    const bin = path.dirname(gpp);
    const root = path.dirname(bin);
    if (/mingw|msys|ucrt64|clang64/i.test(gpp)) {
      pushMingwRoot(roots, root);
    }
  }

  const scoop = [
    path.join(home, "scoop", "apps", "mingw", "current"),
    path.join(home, "scoop", "apps", "gcc", "current"),
    path.join(home, "scoop", "apps", "llvm", "current"),
  ];
  for (const r of scoop) {
    pushMingwRoot(roots, r);
  }

  // Nested mingw-w64 installs: Program Files/mingw-w64/x86_64-*-posix-seh/mingw64
  for (const drive of ["C", "D", "E"]) {
    const base = `${drive}:\\Program Files\\mingw-w64`;
    if (!existsDir(base)) {
      continue;
    }
    try {
      for (const entry of fs.readdirSync(base)) {
        pushMingwRoot(roots, path.join(base, entry, "mingw64"));
        pushMingwRoot(roots, path.join(base, entry));
      }
    } catch {
      // ignore
    }
  }

  return [...new Set(roots.map((r) => path.normalize(r)))];
}

function detectMingwAndGcc(): DetectedCompiler[] {
  const out: DetectedCompiler[] = [];
  for (const root of discoverMingwRoots()) {
    const command =
      [path.join(root, "bin", "g++.exe"), path.join(root, "bin", "g++")].find(existsFile) ||
      "";
    if (!command) {
      continue;
    }
    const version = readVersion(command);
    const isMingw = /mingw|msys|ucrt64|clang64/i.test(root) || /mingw|msys/i.test(command);
    out.push({
      kind: isMingw ? "mingw64" : "gcc",
      name: isMingw ? "MinGW64" : "GCC",
      path: root,
      command,
      version,
      label: `${isMingw ? "MinGW64" : "GCC"}${version ? ` ${version}` : ""} — ${root}`,
    });
  }

  // Bare g++ on PATH that isn't under a known mingw root
  for (const command of whichAll("g++.exe").concat(whichAll("g++"))) {
    const already = out.some(
      (c) =>
        c.command && path.normalize(c.command).toLowerCase() === path.normalize(command).toLowerCase()
    );
    if (already) {
      continue;
    }
    const version = readVersion(command);
    const isMingw = /mingw|msys|ucrt64/i.test(command);
    out.push({
      kind: isMingw ? "mingw64" : "gcc",
      name: isMingw ? "MinGW64" : "GCC",
      path: command,
      command,
      version,
      label: `${isMingw ? "MinGW64" : "GCC"}${version ? ` ${version}` : ""} — ${command}`,
    });
  }
  return out;
}

function detectClang(): DetectedCompiler[] {
  const out: DetectedCompiler[] = [];
  const candidates = [
    ...whichAll("clang++.exe"),
    ...whichAll("clang++"),
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "LLVM", "bin", "clang++.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "LLVM",
      "bin",
      "clang++.exe"
    ),
    "C:\\msys64\\clang64\\bin\\clang++.exe",
    "D:\\msys64\\clang64\\bin\\clang++.exe",
    "E:\\msys64\\clang64\\bin\\clang++.exe",
  ];

  for (const command of candidates) {
    if (!existsFile(command)) {
      continue;
    }
    const version = readVersion(command);
    const root = path.dirname(path.dirname(command));
    out.push({
      kind: "clang",
      name: "Clang",
      path: command,
      command,
      version,
      label: `Clang${version ? ` ${version}` : ""} — ${command}`,
    });
    void root;
  }
  return out;
}

function detectMsvc(): DetectedCompiler[] {
  const out: DetectedCompiler[] = [];
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );

  if (existsFile(vswhere)) {
    try {
      const installs = execFileSync(
        vswhere,
        ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
        { encoding: "utf8", timeout: 8000, windowsHide: true }
      )
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const install of installs) {
        const msbuild = path.join(install, "MSBuild", "Current", "Bin", "MSBuild.exe");
        if (!existsFile(msbuild)) {
          continue;
        }
        let version: string | undefined;
        try {
          const ver = execFileSync(
            vswhere,
            ["-latest", "-property", "catalog_productDisplayVersion"],
            { encoding: "utf8", timeout: 5000, windowsHide: true }
          ).trim();
          version = ver || undefined;
        } catch {
          version = undefined;
        }
        out.push({
          kind: "msvc",
          name: "MSVC",
          path: msbuild,
          command: msbuild,
          version,
          label: `MSVC${version ? ` ${version}` : ""} — ${msbuild}`,
        });
      }

      const msbuilds = execFileSync(
        vswhere,
        ["-latest", "-requires", "Microsoft.Component.MSBuild", "-find", "MSBuild\\**\\Bin\\MSBuild.exe"],
        { encoding: "utf8", timeout: 8000, windowsHide: true }
      )
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => existsFile(s));
      for (const msbuild of msbuilds) {
        out.push({
          kind: "msvc",
          name: "MSVC",
          path: msbuild,
          command: msbuild,
          label: `MSVC — ${msbuild}`,
        });
      }
    } catch {
      // fall through
    }
  }

  const fallbacks = [
    process.env.MSBUILD_PATH,
    "E:\\software\\vs2026\\MSBuild\\Current\\Bin\\MSBuild.exe",
    "D:\\software\\vs2026\\MSBuild\\Current\\Bin\\MSBuild.exe",
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
    path.join(
      process.env["ProgramFiles"] || "C:\\Program Files",
      "Microsoft Visual Studio",
      "2022",
      "Enterprise",
      "MSBuild",
      "Current",
      "Bin",
      "MSBuild.exe"
    ),
  ].filter(Boolean) as string[];

  for (const msbuild of fallbacks) {
    if (existsFile(msbuild)) {
      out.push({
        kind: "msvc",
        name: "MSVC",
        path: msbuild,
        command: msbuild,
        label: `MSVC — ${msbuild}`,
      });
    }
  }

  return out;
}

let cachedCompilers: DetectedCompiler[] | undefined;
let cacheAt = 0;
let scanning: Promise<DetectedCompiler[]> | undefined;
const CACHE_TTL_MS = 10 * 60 * 1000;

function scanCompilers(): DetectedCompiler[] {
  // 面板仅提供 MSVC / MinGW64
  return uniqByPath([...detectMsvc(), ...detectMingwAndGcc()]).filter(
    (c) => c.name === "MSVC" || c.name === "MinGW64"
  );
}

/** 同步扫描（仅用于「自动搜索」按钮等显式操作） */
export function detectCompilers(force = false): DetectedCompiler[] {
  if (!force && cachedCompilers && Date.now() - cacheAt < CACHE_TTL_MS) {
    return cachedCompilers;
  }
  cachedCompilers = scanCompilers();
  cacheAt = Date.now();
  return cachedCompilers;
}

/** 启动时用：有缓存才返回，绝不触发扫描 */
export function getCachedCompilers(): DetectedCompiler[] {
  return cachedCompilers ? [...cachedCompilers] : [];
}

/** 后台扫描，完成后推送到 webview；不阻塞 activate/postState */
export function refreshCompilerCacheInBackground(view?: {
  webview: { postMessage(msg: unknown): Thenable<boolean> };
}): void {
  if (cachedCompilers && Date.now() - cacheAt < CACHE_TTL_MS) {
    return;
  }
  if (scanning) {
    return;
  }
  scanning = new Promise((resolve) => {
    setImmediate(() => {
      try {
        const list = scanCompilers();
        cachedCompilers = list;
        cacheAt = Date.now();
        void view?.webview.postMessage({
          type: "compilersDetected",
          compilers: list,
        });
        resolve(list);
      } catch {
        resolve(cachedCompilers ?? []);
      } finally {
        scanning = undefined;
      }
    });
  });
}

export function filterCompilers(
  all: DetectedCompiler[],
  compilerName: string
): DetectedCompiler[] {
  const n = (compilerName || "").toLowerCase();
  if (n.includes("mingw") || n.includes("gcc")) {
    return all.filter((c) => c.name === "MinGW64" || c.kind === "mingw64" || c.kind === "gcc");
  }
  if (n.includes("msvc")) {
    return all.filter((c) => c.kind === "msvc" || c.name === "MSVC");
  }
  return all.filter((c) => c.name === "MSVC" || c.name === "MinGW64");
}

export function preferredPathFor(compilerName: string): string | undefined {
  return filterCompilers(getCachedCompilers().length ? getCachedCompilers() : detectCompilers(), compilerName)[0]
    ?.path;
}
