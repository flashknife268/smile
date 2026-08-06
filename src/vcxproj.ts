import * as fs from "fs";
import {
  BuildConfiguration,
  CharacterSet,
  ConfigType,
  DEFAULT_PROJECT,
  LanguageStandard,
  MfcUsage,
  PrecompiledHeader,
  ProjectProperties,
} from "./types";

/** Read/write Visual Studio C++ (.vcxproj) MSBuild properties without duplicating groups. */

type GroupHit = {
  start: number;
  end: number;
  openTag: string;
  inner: string;
  kind: "configuration" | "path" | "other";
};

/** Belong in Label="Configuration" PropertyGroup (before Cpp.props). */
const CONFIG_TAGS = new Set([
  "ConfigurationType",
  "CharacterSet",
  "UseOfMFC",
  "UseDebugLibraries",
  "PlatformToolset",
  "WholeProgramOptimization",
]);

/** Belong in the later per-config PropertyGroup (after Cpp.props). */
const PATH_TAGS = new Set(["OutDir", "IntDir", "TargetName", "TargetExt"]);

const DEBUGGER_TAGS = [
  "LocalDebuggerCommand",
  "LocalDebuggerCommandArguments",
  "LocalDebuggerWorkingDirectory",
  "DebuggerFlavor",
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function conditionOf(config: string, platform: string): string {
  return `'$(Configuration)|$(Platform)'=='${config}|${platform}'`;
}

function listConfigurations(xml: string): BuildConfiguration[] {
  const found = new Map<string, BuildConfiguration>();
  const re = /ProjectConfiguration\s+Include="([^"|]+)\|([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    found.set(`${m[1]}|${m[2]}`, { name: m[1], platform: m[2] });
  }
  if (!found.size) {
    return structuredClone(DEFAULT_PROJECT.configuration.configurations);
  }
  return [...found.values()];
}

function propsImportIndex(xml: string): number {
  const i = xml.indexOf('Project="$(VCTargetsPath)\\Microsoft.Cpp.props"');
  return i >= 0 ? i : xml.length;
}

function classifyGroup(openTag: string, inner: string, start: number, propsIdx: number): GroupHit["kind"] {
  if (/Label\s*=\s*"Configuration"/i.test(openTag)) {
    return "configuration";
  }
  // Heuristic: early groups with toolset/config type are configuration pages
  if (
    start < propsIdx &&
    (/<PlatformToolset[\s>]/i.test(inner) || /<ConfigurationType[\s>]/i.test(inner))
  ) {
    return "configuration";
  }
  if (start >= propsIdx || /<OutDir[\s>]/i.test(inner) || /<IntDir[\s>]/i.test(inner)) {
    return "path";
  }
  return "other";
}

function findAllGroups(
  xml: string,
  tag: "PropertyGroup" | "ItemDefinitionGroup",
  config: string,
  platform: string
): GroupHit[] {
  const cond = conditionOf(config, platform);
  const propsIdx = propsImportIndex(xml);
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi");
  const hits: GroupHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || "";
    if (!attrs.includes(cond)) {
      continue;
    }
    const openTag = `<${tag}${attrs}>`;
    const inner = m[2];
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      openTag,
      inner,
      kind:
        tag === "PropertyGroup"
          ? classifyGroup(openTag, inner, m.index, propsIdx)
          : "other",
    });
  }
  return hits;
}

function getTagValue(inner: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(inner);
  return m ? unescapeXml(m[1].trim()) : undefined;
}

function setTagValue(inner: string, tag: string, value: string): string {
  const re = new RegExp(`\\s*<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "i");
  const replacement = `\n    <${tag}>${escapeXml(value)}</${tag}>`;
  if (re.test(inner)) {
    return inner.replace(re, replacement);
  }
  return `${inner.replace(/\s*$/, "")}${replacement}\n  `;
}

function removeTag(inner: string, tag: string): string {
  return inner.replace(new RegExp(`\\s*<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
}

function removeTags(inner: string, tags: string[]): string {
  let next = inner;
  for (const tag of tags) {
    next = removeTag(next, tag);
  }
  return next;
}

function replaceGroup(xml: string, hit: GroupHit, inner: string, closeTag: string): string {
  return xml.slice(0, hit.start) + `${hit.openTag}${inner}${closeTag}` + xml.slice(hit.end);
}

function getClCompileValue(
  xml: string,
  tag: string,
  config: string,
  platform: string
): string | undefined {
  const group = findAllGroups(xml, "ItemDefinitionGroup", config, platform)[0];
  if (!group) {
    return undefined;
  }
  const cl = /<ClCompile\b[^>]*>([\s\S]*?)<\/ClCompile>/i.exec(group.inner);
  return cl ? getTagValue(cl[1], tag) : undefined;
}

function getLinkValue(
  xml: string,
  tag: string,
  config: string,
  platform: string
): string | undefined {
  const group = findAllGroups(xml, "ItemDefinitionGroup", config, platform)[0];
  if (!group) {
    return undefined;
  }
  const link = /<Link\b[^>]*>([\s\S]*?)<\/Link>/i.exec(group.inner);
  return link ? getTagValue(link[1], tag) : undefined;
}

function ensureConfigurationGroup(xml: string, config: string, platform: string): string {
  const hits = findAllGroups(xml, "PropertyGroup", config, platform);
  if (hits.some((h) => h.kind === "configuration")) {
    return xml;
  }
  const block = `  <PropertyGroup Condition="${conditionOf(config, platform)}" Label="Configuration">
  </PropertyGroup>\n`;
  const anchor = xml.indexOf('<Import Project="$(VCTargetsPath)\\Microsoft.Cpp.Default.props"');
  if (anchor >= 0) {
    const lineEnd = xml.indexOf("\n", anchor);
    return xml.slice(0, lineEnd + 1) + block + xml.slice(lineEnd + 1);
  }
  return xml.replace("</Project>", `${block}</Project>`);
}

function ensurePathGroup(xml: string, config: string, platform: string): string {
  const hits = findAllGroups(xml, "PropertyGroup", config, platform);
  if (hits.some((h) => h.kind === "path")) {
    return xml;
  }
  const block = `  <PropertyGroup Condition="${conditionOf(config, platform)}">
  </PropertyGroup>\n`;
  const anchor = xml.indexOf('Project="$(VCTargetsPath)\\Microsoft.Cpp.props"');
  if (anchor >= 0) {
    const close = xml.indexOf("/>", anchor);
    const lineEnd = xml.indexOf("\n", close >= 0 ? close : anchor);
    if (lineEnd >= 0) {
      return xml.slice(0, lineEnd + 1) + block + xml.slice(lineEnd + 1);
    }
  }
  // Fallback: before first ItemDefinitionGroup or </Project>
  const item = xml.indexOf("<ItemDefinitionGroup");
  if (item >= 0) {
    return xml.slice(0, item) + block + xml.slice(item);
  }
  return xml.replace("</Project>", `${block}</Project>`);
}

function stripTagFromOtherGroups(
  xml: string,
  config: string,
  platform: string,
  tag: string,
  keepKind: GroupHit["kind"]
): string {
  let hits = findAllGroups(xml, "PropertyGroup", config, platform);
  // Process from end to start so indices stay valid
  const ordered = [...hits].sort((a, b) => b.start - a.start);
  for (const hit of ordered) {
    if (hit.kind === keepKind) {
      continue;
    }
    if (getTagValue(hit.inner, tag) == null) {
      continue;
    }
    xml = replaceGroup(xml, hit, removeTag(hit.inner, tag), "</PropertyGroup>");
  }
  return xml;
}

function updatePropertyGroupTag(
  xml: string,
  config: string,
  platform: string,
  tag: string,
  value: string
): string {
  const preferConfig = CONFIG_TAGS.has(tag);
  const preferPath = PATH_TAGS.has(tag);
  if (!preferConfig && !preferPath) {
    return xml;
  }

  if (preferConfig) {
    xml = ensureConfigurationGroup(xml, config, platform);
  } else {
    xml = ensurePathGroup(xml, config, platform);
  }

  const keepKind: GroupHit["kind"] = preferConfig ? "configuration" : "path";
  xml = stripTagFromOtherGroups(xml, config, platform, tag, keepKind);

  const hits = findAllGroups(xml, "PropertyGroup", config, platform);
  const target =
    hits.find((h) => h.kind === keepKind) ??
    (preferConfig
      ? hits.find((h) => h.kind === "configuration")
      : hits.find((h) => h.kind === "path"));
  if (!target) {
    return xml;
  }

  const inner = setTagValue(target.inner, tag, value);
  return replaceGroup(xml, target, inner, "</PropertyGroup>");
}

function cleanupDebuggerFromVcxproj(xml: string, config: string, platform: string): string {
  let hits = findAllGroups(xml, "PropertyGroup", config, platform);
  const ordered = [...hits].sort((a, b) => b.start - a.start);
  for (const hit of ordered) {
    let inner = hit.inner;
    const before = inner;
    inner = removeTags(inner, DEBUGGER_TAGS);
    if (inner !== before) {
      xml = replaceGroup(xml, hit, inner, "</PropertyGroup>");
      hits = findAllGroups(xml, "PropertyGroup", config, platform);
    }
  }
  return xml;
}

function restoreConfigurationLabel(xml: string, config: string, platform: string): string {
  const hits = findAllGroups(xml, "PropertyGroup", config, platform);
  for (const hit of hits) {
    if (hit.kind !== "configuration") {
      continue;
    }
    if (/Label\s*=\s*"Configuration"/i.test(hit.openTag)) {
      continue;
    }
    const openTag = hit.openTag.replace(
      /<PropertyGroup(\s+)/i,
      '<PropertyGroup Label="Configuration"$1'
    );
    xml =
      xml.slice(0, hit.start) +
      `${openTag}${hit.inner}</PropertyGroup>` +
      xml.slice(hit.end);
    break;
  }
  return xml;
}

function updateItemChild(
  xml: string,
  config: string,
  platform: string,
  parent: "ClCompile" | "Link",
  tag: string,
  value: string
): string {
  let hits = findAllGroups(xml, "ItemDefinitionGroup", config, platform);
  if (!hits.length) {
    const block = `  <ItemDefinitionGroup Condition="${conditionOf(config, platform)}">
    <ClCompile>
    </ClCompile>
    <Link>
    </Link>
  </ItemDefinitionGroup>\n`;
    xml = xml.replace("</Project>", `${block}</Project>`);
    hits = findAllGroups(xml, "ItemDefinitionGroup", config, platform);
  }
  const group = hits[0];
  if (!group) {
    return xml;
  }

  const parentRe = new RegExp(`<(${parent})\\b([^>]*)>([\\s\\S]*?)</${parent}>`, "i");
  let inner = group.inner;
  const pm = parentRe.exec(inner);
  if (pm) {
    const childInner = setTagValue(pm[3], tag, value);
    inner =
      inner.slice(0, pm.index) +
      `<${pm[1]}${pm[2]}>${childInner}</${pm[1]}>` +
      inner.slice(pm.index + pm[0].length);
  } else {
    inner += `\n    <${parent}>\n      <${tag}>${escapeXml(value)}</${tag}>\n    </${parent}>\n  `;
  }
  return replaceGroup(xml, group, inner, "</ItemDefinitionGroup>");
}

function mapConfigurationType(v?: string): ConfigType {
  switch (v) {
    case "DynamicLibrary":
      return "动态库 (.dll)";
    case "StaticLibrary":
      return "静态库 (.lib)";
    case "Utility":
      return "实用工具";
    default:
      return "应用程序 (.exe)";
  }
}

function toConfigurationType(v: ConfigType): string {
  switch (v) {
    case "动态库 (.dll)":
      return "DynamicLibrary";
    case "静态库 (.lib)":
      return "StaticLibrary";
    case "实用工具":
      return "Utility";
    default:
      return "Application";
  }
}

function mapCharacterSet(v?: string): CharacterSet {
  switch (v) {
    case "MultiByte":
      return "多字节字符集";
    case "NotSet":
      return "未设置";
    default:
      return "Unicode";
  }
}

function toCharacterSet(v: CharacterSet): string {
  switch (v) {
    case "多字节字符集":
      return "MultiByte";
    case "未设置":
      return "NotSet";
    default:
      return "Unicode";
  }
}

function mapMfc(v?: string): MfcUsage {
  switch ((v || "").toLowerCase()) {
    case "static":
      return "在静态库中使用 MFC";
    case "dynamic":
      return "在共享 DLL 中使用 MFC";
    default:
      return "使用标准 Windows 库";
  }
}

function toMfc(v: MfcUsage): string {
  switch (v) {
    case "在静态库中使用 MFC":
      return "Static";
    case "在共享 DLL 中使用 MFC":
      return "Dynamic";
    default:
      return "false";
  }
}

function mapLang(v?: string): LanguageStandard {
  switch (v) {
    case "stdcpp14":
      return "C++14";
    case "stdcpp17":
      return "C++17";
    case "stdcpp20":
      return "C++20";
    case "stdcpp23":
      return "C++23";
    case "stdcpplatest":
      return "最新";
    default:
      return "默认";
  }
}

function toLang(v: LanguageStandard): string {
  switch (v) {
    case "C++14":
      return "stdcpp14";
    case "C++17":
      return "stdcpp17";
    case "C++20":
      return "stdcpp20";
    case "C++23":
      return "stdcpp23";
    case "最新":
      return "stdcpplatest";
    default:
      return "";
  }
}

function mapPch(v?: string): PrecompiledHeader {
  switch (v) {
    case "Use":
      return "使用";
    case "Create":
      return "创建";
    default:
      return "不使用";
  }
}

function toPch(v: PrecompiledHeader): string {
  switch (v) {
    case "使用":
      return "Use";
    case "创建":
      return "Create";
    default:
      return "NotUsing";
  }
}

function firstProp(
  xml: string,
  config: string,
  platform: string,
  tag: string
): string | undefined {
  for (const hit of findAllGroups(xml, "PropertyGroup", config, platform)) {
    const v = getTagValue(hit.inner, tag);
    if (v != null) {
      return v;
    }
  }
  return undefined;
}

function writeUserDebugger(vcxprojPath: string, props: ProjectProperties): void {
  const userPath = `${vcxprojPath}.user`;
  const { config, platform } = props.configuration;
  const cond = conditionOf(config, platform);
  let xml = fs.existsSync(userPath)
    ? fs.readFileSync(userPath, "utf8")
    : `<?xml version="1.0" encoding="utf-8"?>\n<Project ToolsVersion="Current" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n</Project>\n`;

  const hits = findAllGroups(xml, "PropertyGroup", config, platform);
  if (hits[0]) {
    let inner = hits[0].inner;
    inner = setTagValue(inner, "LocalDebuggerCommand", props.debug.command);
    inner = setTagValue(inner, "LocalDebuggerCommandArguments", props.debug.commandArguments);
    inner = setTagValue(inner, "LocalDebuggerWorkingDirectory", props.debug.workingDirectory);
    if (!/DebuggerFlavor/i.test(inner)) {
      inner = setTagValue(inner, "DebuggerFlavor", "WindowsLocalDebugger");
    }
    xml = replaceGroup(xml, hits[0], inner, "</PropertyGroup>");
  } else {
    const body = `
    <LocalDebuggerCommand>${escapeXml(props.debug.command)}</LocalDebuggerCommand>
    <LocalDebuggerCommandArguments>${escapeXml(props.debug.commandArguments)}</LocalDebuggerCommandArguments>
    <LocalDebuggerWorkingDirectory>${escapeXml(props.debug.workingDirectory)}</LocalDebuggerWorkingDirectory>
    <DebuggerFlavor>WindowsLocalDebugger</DebuggerFlavor>
  `;
    const block = `  <PropertyGroup Condition="${cond}">${body}</PropertyGroup>\n`;
    xml = xml.includes("</Project>")
      ? xml.replace("</Project>", `${block}</Project>`)
      : xml + block;
  }
  fs.writeFileSync(userPath, xml, "utf8");
}

export function readVcxproj(filePath: string): ProjectProperties {
  const xml = fs.readFileSync(filePath, "utf8");
  const configurations = listConfigurations(xml);
  const preferred =
    configurations.find((c) => c.name === "Debug" && c.platform === "x64") ??
    configurations[0];
  const config = preferred?.name ?? "Debug";
  const platform = preferred?.platform ?? "x64";

  const props = structuredClone(DEFAULT_PROJECT);
  props.compiler.name = "MSVC";
  props.configuration.config = config;
  props.configuration.platform = platform;
  props.configuration.configurations = configurations;

  props.general.outputDirectory =
    firstProp(xml, config, platform, "OutDir") ?? props.general.outputDirectory;
  props.general.intermediateDirectory =
    firstProp(xml, config, platform, "IntDir") ?? props.general.intermediateDirectory;
  props.general.targetFileName =
    firstProp(xml, config, platform, "TargetName") ?? props.general.targetFileName;
  props.general.configurationType = mapConfigurationType(
    firstProp(xml, config, platform, "ConfigurationType")
  );
  props.advanced.targetFileExtension =
    firstProp(xml, config, platform, "TargetExt") ?? props.advanced.targetFileExtension;
  props.advanced.characterSet = mapCharacterSet(
    firstProp(xml, config, platform, "CharacterSet")
  );
  props.advanced.mfcUsage = mapMfc(firstProp(xml, config, platform, "UseOfMFC"));

  props.general.languageStandard = mapLang(
    getClCompileValue(xml, "LanguageStandard", config, platform)
  );
  props.cpp.additionalIncludeDirectories =
    getClCompileValue(xml, "AdditionalIncludeDirectories", config, platform) ?? "";
  props.cpp.preprocessorDefinitions =
    getClCompileValue(xml, "PreprocessorDefinitions", config, platform) ?? "";
  props.cpp.precompiledHeader = mapPch(
    getClCompileValue(xml, "PrecompiledHeader", config, platform)
  );
  props.cpp.precompiledHeaderFile =
    getClCompileValue(xml, "PrecompiledHeaderFile", config, platform) ?? "pch.h";
  props.cpp.additionalLibraryDirectories =
    getLinkValue(xml, "AdditionalLibraryDirectories", config, platform) ?? "";
  props.cpp.additionalDependencies =
    getLinkValue(xml, "AdditionalDependencies", config, platform) ?? "";

  const userPath = `${filePath}.user`;
  if (fs.existsSync(userPath)) {
    const userXml = fs.readFileSync(userPath, "utf8");
    props.debug.command =
      firstProp(userXml, config, platform, "LocalDebuggerCommand") ?? props.debug.command;
    props.debug.commandArguments =
      firstProp(userXml, config, platform, "LocalDebuggerCommandArguments") ?? "";
    props.debug.workingDirectory =
      firstProp(userXml, config, platform, "LocalDebuggerWorkingDirectory") ??
      props.debug.workingDirectory;
  } else {
    props.debug.command =
      firstProp(xml, config, platform, "LocalDebuggerCommand") ?? props.debug.command;
    props.debug.commandArguments =
      firstProp(xml, config, platform, "LocalDebuggerCommandArguments") ?? "";
    props.debug.workingDirectory =
      firstProp(xml, config, platform, "LocalDebuggerWorkingDirectory") ??
      props.debug.workingDirectory;
  }

  return props;
}

export function writeVcxproj(filePath: string, props: ProjectProperties): void {
  let xml = fs.readFileSync(filePath, "utf8");
  const { config, platform } = props.configuration;

  // Never keep debugger settings inside the main vcxproj
  xml = cleanupDebuggerFromVcxproj(xml, config, platform);
  xml = restoreConfigurationLabel(xml, config, platform);

  xml = updatePropertyGroupTag(
    xml,
    config,
    platform,
    "ConfigurationType",
    toConfigurationType(props.general.configurationType)
  );
  xml = updatePropertyGroupTag(
    xml,
    config,
    platform,
    "CharacterSet",
    toCharacterSet(props.advanced.characterSet)
  );
  xml = updatePropertyGroupTag(xml, config, platform, "UseOfMFC", toMfc(props.advanced.mfcUsage));

  xml = updatePropertyGroupTag(xml, config, platform, "OutDir", props.general.outputDirectory);
  xml = updatePropertyGroupTag(
    xml,
    config,
    platform,
    "IntDir",
    props.general.intermediateDirectory
  );
  xml = updatePropertyGroupTag(xml, config, platform, "TargetName", props.general.targetFileName);
  xml = updatePropertyGroupTag(
    xml,
    config,
    platform,
    "TargetExt",
    props.advanced.targetFileExtension
  );

  // Final pass: path tags must not remain in configuration groups
  for (const tag of PATH_TAGS) {
    xml = stripTagFromOtherGroups(xml, config, platform, tag, "path");
  }
  for (const tag of CONFIG_TAGS) {
    if (tag === "UseOfMFC" || tag === "ConfigurationType" || tag === "CharacterSet") {
      xml = stripTagFromOtherGroups(xml, config, platform, tag, "configuration");
    }
  }
  xml = cleanupDebuggerFromVcxproj(xml, config, platform);

  const lang = toLang(props.general.languageStandard);
  if (lang) {
    xml = updateItemChild(xml, config, platform, "ClCompile", "LanguageStandard", lang);
  }
  xml = updateItemChild(
    xml,
    config,
    platform,
    "ClCompile",
    "AdditionalIncludeDirectories",
    props.cpp.additionalIncludeDirectories
  );
  xml = updateItemChild(
    xml,
    config,
    platform,
    "ClCompile",
    "PreprocessorDefinitions",
    props.cpp.preprocessorDefinitions
  );
  xml = updateItemChild(
    xml,
    config,
    platform,
    "ClCompile",
    "PrecompiledHeader",
    toPch(props.cpp.precompiledHeader)
  );
  if (props.cpp.precompiledHeader !== "不使用") {
    xml = updateItemChild(
      xml,
      config,
      platform,
      "ClCompile",
      "PrecompiledHeaderFile",
      props.cpp.precompiledHeaderFile
    );
  }
  xml = updateItemChild(
    xml,
    config,
    platform,
    "Link",
    "AdditionalLibraryDirectories",
    props.cpp.additionalLibraryDirectories
  );
  xml = updateItemChild(
    xml,
    config,
    platform,
    "Link",
    "AdditionalDependencies",
    props.cpp.additionalDependencies
  );

  fs.writeFileSync(filePath, xml, "utf8");
  writeUserDebugger(filePath, props);
}
