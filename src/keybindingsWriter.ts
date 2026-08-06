import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_KEYBINDINGS, KEYBINDING_DEFS } from "./types";

interface KeybindingEntry {
  key?: string;
  command?: string;
  when?: string;
  args?: unknown;
}

const MANAGED_COMMANDS = new Set(KEYBINDING_DEFS.map((d) => d.command));

export function resolveUserKeybindingsPath(): string | undefined {
  const appData = process.env.APPDATA;
  if (!appData) {
    return undefined;
  }
  const preferred = vscode.env.appName.toLowerCase().includes("cursor") ? "Cursor" : "Code";
  const candidates = [preferred, "Code", "Cursor", "Code - Insiders"];
  for (const folder of candidates) {
    const dir = path.join(appData, folder, "User");
    if (fs.existsSync(dir)) {
      return path.join(dir, "keybindings.json");
    }
  }
  return undefined;
}

function stripJsonc(raw: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let quote: string | null = null;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < raw.length) {
        out += raw[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function readKeybindings(filePath: string): KeybindingEntry[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(stripJsonc(raw));
    return Array.isArray(parsed) ? (parsed as KeybindingEntry[]) : [];
  } catch {
    return [];
  }
}

function toVscodeKey(key: string): string {
  return key
    .trim()
    .split("+")
    .map((part) => {
      const p = part.trim();
      const lower = p.toLowerCase();
      if (lower === "ctrl" || lower === "control") {
        return "ctrl";
      }
      if (lower === "alt") {
        return "alt";
      }
      if (lower === "shift") {
        return "shift";
      }
      if (lower === "meta" || lower === "cmd" || lower === "win") {
        return "meta";
      }
      if (/^f\d{1,2}$/i.test(p)) {
        return p.toLowerCase();
      }
      const special: Record<string, string> = {
        up: "up",
        down: "down",
        left: "left",
        right: "right",
        space: "space",
        escape: "escape",
        esc: "escape",
        enter: "enter",
        tab: "tab",
        backspace: "backspace",
        delete: "delete",
        home: "home",
        end: "end",
        pageup: "pageup",
        pagedown: "pagedown",
      };
      if (special[lower]) {
        return special[lower];
      }
      return lower.length === 1 ? lower : lower;
    })
    .join("+");
}

export async function writeUserKeybindings(keys: Record<string, string>): Promise<string> {
  const filePath = resolveUserKeybindingsPath();
  if (!filePath) {
    throw new Error("找不到用户 keybindings.json 路径");
  }

  const existing = readKeybindings(filePath);
  const kept = existing.filter((item) => {
    if (!item.command) {
      return true;
    }
    const cmd = item.command.startsWith("-") ? item.command.slice(1) : item.command;
    return !MANAGED_COMMANDS.has(cmd);
  });

  const additions: KeybindingEntry[] = KEYBINDING_DEFS.map((def) => ({
    key: toVscodeKey(keys[def.id] ?? DEFAULT_KEYBINDINGS[def.id]),
    command: def.command,
  }));

  const next = [...kept, ...additions];
  const content =
    "// 将键绑定放在此文件中以覆盖默认值\n" +
    "// Smile 管理的快捷键位于文件末尾，可通过扩展重新写入\n" +
    JSON.stringify(next, null, 4) +
    "\n";

  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}
