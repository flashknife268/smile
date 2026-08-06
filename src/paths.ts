import * as fs from "fs";
import * as path from "path";

/** 当前布局：.vscode/.smile */
export function smileRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".vscode", ".smile");
}

export function smileProjectsDir(workspaceRoot: string): string {
  return path.join(smileRoot(workspaceRoot), "projects");
}

export function smileProjectJson(workspaceRoot: string, id: string): string {
  return path.join(smileProjectsDir(workspaceRoot), `${id}.json`);
}

/** 旧布局（仅兼容读取）：.vscode/.smilodon、工作区根 .smilodon / .smile */
export function legacySmileRoots(workspaceRoot: string): string[] {
  return [
    path.join(workspaceRoot, ".vscode", ".smilodon"),
    path.join(workspaceRoot, ".smilodon"),
    path.join(workspaceRoot, ".smile"),
  ];
}

/** @deprecated 使用 legacySmileRoots；保留单根兼容旧调用点 */
export function legacySmileRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".smilodon");
}

export function resolveExistingSmileJson(workspaceRoot: string, id: string): string | undefined {
  const candidates = [
    smileProjectJson(workspaceRoot, id),
    ...legacySmileRoots(workspaceRoot).map((root) => path.join(root, "projects", `${id}.json`)),
  ];
  if (id === "workspace") {
    candidates.push(
      path.join(smileRoot(workspaceRoot), "project.json"),
      ...legacySmileRoots(workspaceRoot).map((root) => path.join(root, "project.json"))
    );
  }
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return file;
    }
  }
  return undefined;
}

/** 把旧目录迁移到 .vscode/.smile（若目标尚不存在） */
export function migrateSmileDir(workspaceRoot: string): void {
  const newRoot = smileRoot(workspaceRoot);
  const copyRecursive = (src: string, dest: string): void => {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      for (const name of fs.readdirSync(src)) {
        copyRecursive(path.join(src, name), path.join(dest, name));
      }
      return;
    }
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  };
  for (const oldRoot of legacySmileRoots(workspaceRoot)) {
    if (!fs.existsSync(oldRoot) || path.resolve(oldRoot) === path.resolve(newRoot)) {
      continue;
    }
    try {
      copyRecursive(oldRoot, newRoot);
    } catch {
      // 迁移失败时仍可写新路径
    }
  }
}
