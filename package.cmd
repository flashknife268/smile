@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo 未找到 npm。请先安装 Node.js，并把它加入 PATH。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败。
    pause
    exit /b 1
  )
)

echo 正在打包...
call npm run package
if errorlevel 1 (
  echo 打包失败。
  pause
  exit /b 1
)

echo.
echo 打包完成，vsix 在当前目录。
pause
exit /b 0
