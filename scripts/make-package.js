/**
 * 打包脚本：生成 ZTools 官方安装包（.zpx = brotli 压缩的 asar）。
 *
 * 产物（写入 packages/）：
 *   - clipboard-history-<version>.asar  未压缩 asar 包体（手动放入插件目录用）
 *   - clipboard-history-<version>.zpx   官方安装包（asar + brotli 压缩，双击或导入即可安装）
 *
 * asar 内只包含插件运行所需文件（不含 test/scripts/README/.gitignore），
 * 文件列表与结构沿用官方安装包约定。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const manifest = require(path.join(ROOT, "plugin.json"));
const version = manifest.version;
const baseName = `clipboard-history-${version}`;
const packagesDir = path.join(ROOT, "packages");

// asar 内包含的运行时文件（相对仓库根）
const RUNTIME_FILES = [
  "LICENSE",
  "app.js",
  "index.html",
  "lib",
  "logo.png",
  "package.json",
  "plugin.json",
  "preload.js",
  "styles.css"
];

function copyInto(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function build() {
  fs.mkdirSync(packagesDir, { recursive: true });

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipboard-pkg-"));
  try {
    RUNTIME_FILES.forEach((rel) => {
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) throw new Error("缺少运行时文件：" + rel);
      copyInto(src, path.join(stageDir, rel));
    });

    const asarPath = path.join(packagesDir, baseName + ".asar");
    const zpxPath = path.join(packagesDir, baseName + ".zpx");

    // 1) 打包 asar（Windows 下 npx 是 .cmd，需要经 shell 调用）
    execFileSync(
      "npx",
      ["--yes", "@electron/asar", "pack", stageDir, asarPath],
      { stdio: "inherit", shell: process.platform === "win32" }
    );

    // 2) brotli 压缩 asar -> zpx
    const asarBuf = fs.readFileSync(asarPath);
    const zpxBuf = zlib.brotliCompressSync(asarBuf);
    fs.writeFileSync(zpxPath, zpxBuf);

    // 3) 校验：zpx 解压应等于 asar
    const back = zlib.brotliDecompressSync(zpxBuf);
    if (!back.equals(asarBuf)) throw new Error("zpx 解压结果与 asar 不一致");

    console.log(`asar 已生成：${asarPath}（${asarBuf.length} 字节）`);
    console.log(`zpx 已生成：${zpxPath}（${zpxBuf.length} 字节）`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

build();
