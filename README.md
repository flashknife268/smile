![Smile](screenshot.jpg)

# Smile

面向 VS Code 的扩展，按 Visual Studio 的习惯做 C/C++ 项目集成：配置项目属性、设置字体与语法颜色、编辑快捷键。

配方：聪明的右脑 + AI + 懒惰的左脑

寄语：AI写的代码，开源只有一个目的，让有相同需求的小伙伴有个参考和基础

另：有bug自己改，我就是这么迪奥

## 构建

```bash
npm install
npm run compile
npm run package
```

- `compile`：编译 TypeScript 到 `out/`
- `package`：打出 `smile-1.0.0.vsix`，可在扩展面板选择 “Install from VSIX…” 安装

需要 Node.js，编辑器版本 `^1.85.0`。

## 许可证

MIT
