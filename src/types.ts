export type ConfigType = "可执行文件" | "动态库" | "静态库";
export type LanguageStandard = "C++14" | "C++17" | "C++20";
export type BuildType = "Debug" | "Release";
export type CompilerName = "GCC" | "Clang";

export interface BuildConfiguration {
  name: string;
  platform: string;
}

export interface ProjectProperties {
  compiler: {
    name: CompilerName;
    path: string;
  };
  configuration: {
    config: BuildType;
    platform: string;
    configurations: BuildConfiguration[];
  };
  general: {
    /** 构建目录。CMake 用作 -B，直接编译时产物也放这里。 */
    outputDirectory: string;
    targetFileName: string;
    configurationType: ConfigType;
    languageStandard: LanguageStandard;
  };
  debug: {
    command: string;
    commandArguments: string;
    workingDirectory: string;
  };
  cpp: {
    additionalIncludeDirectories: string;
    additionalLibraryDirectories: string;
    additionalDependencies: string;
    preprocessorDefinitions: string;
  };
}

export interface KeybindingItem {
  id: string;
  label: string;
  command: string;
  key: string;
  when?: string;
}

export interface CppColorItem {
  id: string;
  label: string;
  category: string;
  /** TextMate scopes */
  scope?: string | string[];
  /** Semantic token(s), e.g. "class:cpp" or ["class:cpp","class:c"] */
  semantic?: string | string[];
  color: string;
  bold?: boolean;
  italic?: boolean;
}

export type VisualEffectId = "none" | "acrylic";

export type VisualEffectOpacityMap = {
  acrylic: number;
};

export const VISUAL_EFFECT_DEFS: { id: VisualEffectId; label: string }[] = [
  { id: "none", label: "无" },
  { id: "acrylic", label: "亚克力" },
];

export const DEFAULT_VISUAL_EFFECT_OPACITY: VisualEffectOpacityMap = {
  acrylic: 70,
};

export const DEFAULT_CONFIGURATIONS: BuildConfiguration[] = [
  { name: "Debug", platform: "x64" },
  { name: "Release", platform: "x64" },
];

export const DEFAULT_PROJECT: ProjectProperties = {
  compiler: {
    name: "GCC",
    path: "",
  },
  configuration: {
    config: "Debug",
    platform: "x64",
    configurations: structuredClone(DEFAULT_CONFIGURATIONS),
  },
  general: {
    outputDirectory: "build",
    targetFileName: "",
    configurationType: "可执行文件",
    languageStandard: "C++17",
  },
  debug: {
    command: "",
    commandArguments: "",
    workingDirectory: "",
  },
  cpp: {
    additionalIncludeDirectories: "",
    additionalLibraryDirectories: "",
    additionalDependencies: "",
    preprocessorDefinitions: "",
  },
};

/** Synced from user's keybindings.json (C++ / editing related) */
export const KEYBINDING_DEFS: Omit<KeybindingItem, "key">[] = [
  { id: "goToDefinition", label: "转到定义", command: "editor.action.revealDefinition" },
  { id: "createDeclaration", label: "创建声明/定义", command: "C_Cpp.CreateDeclarationOrDefinition" },
  { id: "switchHeaderSource", label: "切换头文件/源文件", command: "C_Cpp.SwitchHeaderSource" },
  { id: "navigateForward", label: "向前导航", command: "workbench.action.navigateForward" },
  { id: "navigateBack", label: "向后导航", command: "workbench.action.navigateBack" },
  { id: "find", label: "查找", command: "actions.find" },
  { id: "goToSymbol", label: "转到所有（符号）", command: "workbench.action.showAllSymbols" },
  { id: "findReferences", label: "查找引用", command: "editor.action.goToReferences" },
  { id: "formatSelection", label: "格式化选定内容", command: "editor.action.formatSelection" },
  { id: "build", label: "生成/生成任务", command: "workbench.action.tasks.build" },
  { id: "deleteLine", label: "删除行", command: "editor.action.deleteLines" },
  { id: "copyLine", label: "复制行", command: "editor.action.copyLinesDownAction" },
  { id: "moveLineUp", label: "将选定行上移", command: "editor.action.moveLinesUpAction" },
  { id: "moveLineDown", label: "将选定行下移", command: "editor.action.moveLinesDownAction" },
];

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  goToDefinition: "Alt+E",
  createDeclaration: "Alt+W",
  switchHeaderSource: "Alt+Q",
  navigateForward: "Alt+Right",
  navigateBack: "Alt+Left",
  find: "Ctrl+F",
  goToSymbol: "Ctrl+T",
  findReferences: "Alt+R",
  formatSelection: "Alt+S",
  build: "F6",
  deleteLine: "Alt+D",
  copyLine: "Ctrl+D",
  moveLineUp: "Alt+Up",
  moveLineDown: "Alt+Down",
};

/**
 * Synced from user's settings.json:
 * editor.tokenColorCustomizations + editor.semanticTokenColorCustomizations (C/C++)
 */
export const CPP_COLOR_DEFS: CppColorItem[] = [
  // 常规
  {
    id: "comment",
    label: "注释",
    category: "常规",
    // 实际 TextMate 多为 comment.line / comment.block；source.* comment 选择器经常打不赢主题默认规则
    scope: [
      "comment",
      "comment.line",
      "comment.line.double-slash",
      "comment.line.double-slash.cpp",
      "comment.line.double-slash.c",
      "comment.line.double-slash.clike",
      "comment.block",
      "comment.block.cpp",
      "comment.block.c",
      "comment.block.documentation",
      "comment.block.documentation.cpp",
      "comment.block.documentation.c",
      "punctuation.definition.comment",
      "punctuation.definition.comment.cpp",
      "punctuation.definition.comment.c",
      "source.cpp comment",
      "source.c comment",
    ],
    semantic: ["comment:cpp", "comment:c", "comment"],
    color: "#57A64A",
  },
  {
    id: "keyword",
    label: "关键字",
    category: "常规",
    // 含 bool 等基本类型，以及 sizeof（否则会落到「运算符」灰）
    scope: [
      "source.cpp keyword",
      "source.c keyword",
      "source.cpp storage.type",
      "source.c storage.type",
      "source.cpp storage.type.cpp",
      "source.c storage.type.c",
      "source.cpp storage.type.basic",
      "source.c storage.type.basic",
      "storage.type.primitive",
      "storage.type.primitive.cpp",
      "storage.type.primitive.c",
      "storage.type.built-in.primitive",
      "storage.type.built-in.primitive.cpp",
      "storage.type.built-in.primitive.c",
      "source.cpp storage.modifier",
      "source.c storage.modifier",
      "source.cpp storage.modifier.cpp",
      "source.c storage.modifier.c",
      "keyword.operator.sizeof",
      "keyword.operator.sizeof.cpp",
      "keyword.operator.sizeof.c",
      "source.cpp keyword.operator.sizeof",
      "source.c keyword.operator.sizeof",
      // true / false
      "constant.language.boolean",
      "constant.language.boolean.cpp",
      "constant.language.boolean.c",
      "constant.language.true",
      "constant.language.true.cpp",
      "constant.language.false",
      "constant.language.false.cpp",
      "source.cpp constant.language.true",
      "source.c constant.language.true",
      "source.cpp constant.language.false",
      "source.c constant.language.false",
      "source.cpp constant.language.boolean",
      "source.c constant.language.boolean",
    ],
    semantic: ["keyword:cpp", "keyword:c", "newOperator:cpp", "newOperator:c"],
    color: "#569CD6",
  },
  {
    id: "keywordControl",
    label: "控制流关键字",
    category: "常规",
    scope: ["source.cpp keyword.control", "source.c keyword.control"],
    semantic: ["keyword.control:cpp", "keyword.control:c"],
    color: "#D8A0DF",
  },
  {
    id: "operator",
    label: "运算符",
    category: "常规",
    scope: ["source.cpp keyword.operator", "source.c keyword.operator"],
    semantic: ["operator:cpp", "operator:c", "memberOperatorOverload:cpp", "memberOperatorOverload:c"],
    color: "#B4B4B4",
  },
  {
    id: "overloadedOperator",
    label: "重载运算符",
    category: "常规",
    scope: [
      "source.cpp entity.name.function.operator",
      "source.c entity.name.function.operator",
      "source.cpp entity.name.function.operator.cpp",
      "source.c entity.name.function.operator.c",
    ],
    semantic: ["operatorOverload:cpp", "operatorOverload:c"],
    color: "#DCDCAA",
  },
  {
    id: "punctuation",
    label: "标点",
    category: "常规",
    scope: ["source.cpp punctuation", "source.c punctuation"],
    color: "#DCDCDC",
  },
  {
    id: "stringQuote",
    label: "引号",
    category: "常规",
    // 字符串规则会盖住引号，需单独、靠后写入
    scope: [
      "punctuation.definition.string",
      "punctuation.definition.string.begin",
      "punctuation.definition.string.end",
      "punctuation.definition.string.begin.cpp",
      "punctuation.definition.string.end.cpp",
      "punctuation.definition.string.begin.c",
      "punctuation.definition.string.end.c",
      "punctuation.definition.string.cpp",
      "punctuation.definition.string.c",
      "source.cpp punctuation.definition.string",
      "source.c punctuation.definition.string",
    ],
    color: "#DCDCDC",
  },

  // 字面量
  {
    id: "number",
    label: "数字",
    category: "字面量",
    // 普通数字用 constant.numeric；带 f/ull 等后缀的字面量走 custom-literal.number
    scope: [
      "constant.numeric",
      "constant.numeric.cpp",
      "constant.numeric.c",
      "constant.numeric.integer",
      "constant.numeric.float",
      "constant.numeric.hex",
      "constant.numeric.octal",
      "constant.numeric.binary",
      "constant.numeric.decimal",
      "entity.name.operator.custom-literal.number",
      "source.cpp constant.numeric",
      "source.c constant.numeric",
    ],
    semantic: ["number:cpp", "number:c", "numberLiteral:cpp", "numberLiteral:c"],
    color: "#B5CEA8",
  },
  {
    id: "string",
    label: "字符串 / include",
    category: "字面量",
    scope: [
      "source.cpp string",
      "source.c string",
      "source.cpp meta.include",
      "source.c meta.include",
    ],
    semantic: ["string:cpp", "string:c", "stringLiteral:cpp", "stringLiteral:c"],
    color: "#408080",
  },
  {
    id: "stringEscape",
    label: "字符串转义字符",
    category: "字面量",
    scope: [
      "source.cpp constant.character.escape",
      "source.c constant.character.escape",
    ],
    color: "#FFD68F",
  },
  {
    id: "customLiteral",
    label: "自定义字面量",
    category: "字面量",
    semantic: ["customLiteral:cpp", "customLiteral:c"],
    color: "#DADADA",
  },
  {
    id: "nullptr",
    label: "nullptr",
    category: "字面量",
    // C++ grammar: language_constants → constant.language.nullptr.cpp
    // (不是 keyword，所以改「关键字」不会生效)
    scope: [
      "constant.language.nullptr",
      "constant.language.nullptr.cpp",
      "constant.language.nullptr.c",
      "source.cpp constant.language.nullptr",
      "source.c constant.language.nullptr",
      "source.cpp constant.language.nullptr.cpp",
      "source.c constant.language.nullptr.c",
    ],
    color: "#569CD6",
  },

  // 类型与符号
  {
    id: "namespace",
    label: "命名空间",
    category: "类型与符号",
    scope: [
      "source.cpp entity.name.namespace",
      "source.c entity.name.namespace",
      "source.cpp entity.name.namespace.cpp",
      "source.c entity.name.namespace.c",
    ],
    semantic: ["namespace:cpp", "namespace:c"],
    color: "#408080",
  },
  {
    id: "valueType",
    label: "值类型 / 模板类型",
    category: "类型与符号",
    scope: [
      "source.cpp entity.name.type.class.value.cpp",
      "source.c entity.name.type.class.value.c",
      "source.cpp entity.name.type.value.cpp",
      "source.c entity.name.type.value.c",
    ],
    semantic: ["valueType:cpp", "valueType:c", "templateType:cpp", "templateType:c"],
    color: "#05C3BA",
  },
  {
    id: "typeName",
    label: "类型 / 类 / 结构体 / 枚举",
    category: "类型与符号",
    scope: [
      "source.cpp entity.name.type",
      "source.c entity.name.type",
      "source.cpp entity.name.type.cpp",
      "source.c entity.name.type.c",
      "source.cpp entity.name.type.class",
      "source.c entity.name.type.class",
      "source.cpp entity.name.type.class.cpp",
      "source.c entity.name.type.class.c",
      "source.cpp entity.name.type.struct",
      "source.c entity.name.type.struct",
      "source.cpp entity.name.type.enum",
      "source.c entity.name.type.enum",
      "source.cpp entity.name.type.enum.cpp",
      "source.c entity.name.type.enum.c",
      "source.cpp entity.name.type.interface",
      "source.c entity.name.type.interface",
      "source.cpp entity.name.type.template",
      "source.c entity.name.type.template",
      "source.cpp support.type.cpp",
      "source.c support.type.c",
      "source.cpp support.class.cpp",
      "source.c support.class.c",
    ],
    semantic: [
      "type:cpp",
      "type:c",
      "class:cpp",
      "class:c",
      "struct:cpp",
      "struct:c",
      "enum:cpp",
      "enum:c",
      "interface:cpp",
      "interface:c",
      "referenceType:cpp",
      "referenceType:c",
      "genericType:cpp",
      "genericType:c",
      "typeParameter:cpp",
      "typeParameter:c",
    ],
    color: "#569CD6",
  },
  {
    id: "enumMember",
    label: "枚举成员",
    category: "类型与符号",
    scope: [
      "source.cpp variable.other.enummember.cpp",
      "source.c variable.other.enummember.c",
    ],
    semantic: ["enumMember:cpp", "enumMember:c"],
    color: "#569CD6",
  },
  {
    id: "moduleName",
    label: "模块名",
    category: "类型与符号",
    scope: [
      "source.cpp entity.name.type.module",
      "source.c entity.name.type.module",
    ],
    color: "#4EC9B0",
  },

  // 函数
  {
    id: "functionName",
    label: "函数 / 方法",
    category: "函数",
    scope: [
      "source.cpp entity.name.function",
      "source.c entity.name.function",
      "source.cpp entity.name.function.cpp",
      "source.c entity.name.function.c",
      "source.cpp entity.name.function.member",
      "source.c entity.name.function.member",
      "source.cpp entity.name.function.member.cpp",
      "source.c entity.name.function.member.c",
      "source.cpp entity.name.function.templated.cpp",
      "source.c entity.name.function.templated.c",
    ],
    semantic: [
      "function:cpp",
      "function:c",
      "method:cpp",
      "method:c",
      "templateFunction:cpp",
      "templateFunction:c",
    ],
    color: "#A0825A",
  },

  // 变量与成员
  {
    id: "parameter",
    label: "参数（TextMate）",
    category: "变量与成员",
    scope: [
      "source.cpp variable.parameter",
      "source.c variable.parameter",
      "source.cpp variable.parameter.cpp",
      "source.c variable.parameter.c",
    ],
    color: "#8C8C8C",
  },
  {
    id: "parameterSemantic",
    label: "参数（语义）",
    category: "变量与成员",
    semantic: ["parameter:cpp", "parameter:c"],
    color: "#C8C8C8",
  },
  {
    id: "memberField",
    label: "成员属性",
    category: "变量与成员",
    scope: [
      "source.cpp variable.other.property",
      "source.c variable.other.property",
      "source.cpp variable.other.property.cpp",
      "source.c variable.other.property.c",
      "source.cpp variable.other.constant.property.cpp",
      "source.c variable.other.constant.property.c",
    ],
    semantic: ["property:cpp", "property:c"],
    color: "#8C8C8C",
  },
  {
    id: "globalVariable",
    label: "全局变量",
    category: "变量与成员",
    scope: [
      "source.cpp variable.other.global.cpp",
      "source.c variable.other.global.c",
    ],
    semantic: ["variable.global:cpp", "variable.global:c"],
    color: "#5A5A5A",
  },
  {
    id: "localVariable",
    label: "局部 / 普通变量",
    category: "变量与成员",
    scope: [
      "source.cpp variable.other.local",
      "source.c variable.other.local",
      "source.cpp variable.other.local.cpp",
      "source.c variable.other.local.c",
      "source.cpp variable.other.readwrite",
      "source.c variable.other.readwrite",
      "source.cpp variable.other.readwrite.cpp",
      "source.c variable.other.readwrite.c",
      "source.cpp variable.other",
      "source.c variable.other",
      "source.cpp entity.name.variable.cpp",
      "source.c entity.name.variable.c",
    ],
    semantic: [
      "variable:cpp",
      "variable:c",
      "variable.local:cpp",
      "variable.local:c",
    ],
    color: "#8C8C8C",
  },
  {
    id: "staticVariable",
    label: "静态变量 / 静态属性 / 事件",
    category: "变量与成员",
    semantic: [
      "variable.static:cpp",
      "variable.static:c",
      "property.static:cpp",
      "property.static:c",
      "event:cpp",
      "event:c",
    ],
    color: "#C8C8C8",
  },
  {
    id: "label",
    label: "标签名",
    category: "变量与成员",
    scope: [
      "source.cpp entity.name.label",
      "source.c entity.name.label",
      "source.cpp entity.name.label.cpp",
      "source.c entity.name.label.c",
    ],
    semantic: ["label:cpp", "label:c"],
    color: "#C8C8C8",
  },

  // 预处理器
  {
    id: "macroName",
    label: "宏",
    category: "预处理器",
    semantic: ["macro:cpp", "macro:c"],
    color: "#3D6D8E",
  },
  {
    id: "preprocessorText",
    label: "预处理文本",
    category: "预处理器",
    scope: ["source.cpp meta.preprocessor", "source.c meta.preprocessor"],
    color: "#DCDCDC",
  },
  {
    id: "preprocessorKeyword",
    label: "预处理指令",
    category: "预处理器",
    scope: [
      "source.cpp keyword.control.import",
      "source.c keyword.control.import",
      "source.cpp keyword.control.directive",
      "source.c keyword.control.directive",
      "source.cpp keyword.control.directive.include.cpp",
      "source.c keyword.control.directive.include.c",
    ],
    color: "#9B9B9B",
  },

  // 扩展
  {
    id: "attribute",
    label: "属性 [[...]]",
    category: "扩展",
    // meta.attribute 本身着色弱；括号/名字用更具体的 scope
    scope: [
      "meta.attribute",
      "meta.attribute.cpp",
      "meta.attribute.c",
      "source.cpp meta.attribute",
      "source.c meta.attribute",
      "entity.other.attribute",
      "entity.other.attribute.cpp",
      "entity.other.attribute.c",
      "entity.other.attribute-name",
      "entity.other.attribute-name.cpp",
      "entity.other.attribute-name.c",
      "punctuation.definition.annotation",
      "punctuation.definition.annotation.cpp",
      "punctuation.definition.annotation.c",
      "punctuation.section.attribute",
      "punctuation.section.attribute.begin",
      "punctuation.section.attribute.end",
      "punctuation.definition.attribute",
      "punctuation.definition.attribute.cpp",
      "punctuation.definition.attribute.begin",
      "punctuation.definition.attribute.end",
      "storage.type.attribute",
      "support.other.attribute",
    ],
    semantic: ["decorator:cpp", "decorator:c"],
    color: "#4EC9B0",
  },
];

/** Bump when shipping a forced sync of user defaults into globalState */
export const SMILE_SYNC_VERSION = 8;
