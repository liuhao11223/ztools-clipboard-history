# 剪切板（ZTools 插件）

一个面向 [ZTools](https://github.com/ZToolsCenter/ZTools) 的本地剪贴板历史与常用文字插件。核心交互参考本地项目 `D:\剪切板\clipboard-tool`，并按 ZTools 插件运行环境/能力边界做了适配。

## 功能

- **剪贴板历史**：插件打开期间轮询系统剪贴板，自动记录文本与图片（受大小/数量限制），相同文本去重并置顶。
- **主搜索框集成（mainPush）**：在 ZTools 主搜索框直接输入关键词，可检索已保存的剪贴板历史并选择结果进行复制/粘贴（无需先进入插件界面）。
- **插件内搜索与管理**：插件界面不包含独立头部搜索框；进入插件后使用 ZTools 主/子搜索框输入关键词，实时过滤剪贴板历史与常用文字。
  - 历史/常用文字：**单击复制**，**双击粘贴**到上次光标位置（通过 ZTools 提供的粘贴/隐藏 API，环境不支持时回退为复制/隐藏）。
  - 历史项支持删除；插件打开即自动记录，无手动开关。
- **主题**：标题栏右侧可切换 **浅色 / 深色 / 跟随系统** 主题（图标按钮，选择会记住）。
- **常用文字（Snippets）**：按分组管理常用文本，支持新增、编辑、删除、分组切换；分组支持新增、双击重命名，鼠标悬停分组名显示删除图标（默认分组除外）。
- **同步到 ZTools「我的数据」**：常用文字会同步写入插件数据库 `ztools.db`（文档前缀 `snippet/`，`type: "clipboard-snippet"`），在插件打开/加载及收藏或分组变更保存后自动同步，便于在 ZTools「我的数据」中查看与管理。本地 JSON 与数据库记录冲突时**以时间戳最新的记录为准**：数据库中更新的记录会回填到本地，本地更新的记录覆盖数据库，本地删除记录写入删除标记并从数据库移除。
- **本地持久化**：历史/收藏/分组/设置保存为本地 JSON。

> 适配说明：为适配 ZTools 插件能力边界，本插件未包含原参考项目中的全局热键唤起、跨窗口自动粘贴辅助程序（focus-watcher/ui-helper）、GitHub 同步、托盘等 Electron 主进程能力。插件界面内实时采集在**打开期间**进行；主搜索框结果基于**已保存**的本地历史记录（需先打开过插件并完成采集/保存）。

## 目录结构

- [plugin.json](plugin.json) — 插件清单与命令入口（`clipboard-history` 打开界面，`clipboard-search` 主搜索推送）
- [index.html](index.html) / [app.js](app.js) / [styles.css](styles.css) — 插件 UI 与交互
- [preload.js](preload.js) — 预加载桥接（剪贴板读写、JSON 存储、`onMainPush` 主搜索）
- [lib/core.js](lib/core.js) — 纯逻辑（UMD，Node/浏览器共用，便于测试）
- [scripts/make-logo.js](scripts/make-logo.js) — 生成 [logo.png](logo.png)
- [test/core.test.js](test/core.test.js) — 核心逻辑单元测试
- [scripts/make-package.js](scripts/make-package.js) — 打包脚本（生成 `.asar` 与 `.zpx` 安装包）
- [packages/](packages/) — 打包好的安装包（`.zpx` 官方安装包 / `.asar` 包体）

## 开发

环境：Node.js（用于测试、生成图标与打包）。

```bash
npm test       # node --test test/core.test.js
npm run logo   # 生成 logo.png
npm run package # 生成 packages/ 下的 .asar 与 .zpx（.zpx = asar + brotli 压缩）
```

## 在 ZTools 中安装/使用

### 方式一：官方安装包（推荐）

`packages/` 内提供打包好的安装包：

- [`packages/clipboard-history-1.0.4.zpx`](packages/clipboard-history-1.0.4.zpx) — ZTools 官方安装包（asar + brotli 压缩，双击或导入即可安装）
- [`packages/clipboard-history-1.0.4.asar`](packages/clipboard-history-1.0.4.asar) — 未压缩的 asar 包体（手动放入插件目录用）
- 历史版本：[`packages/clipboard-history-1.0.3.zpx`](packages/clipboard-history-1.0.3.zpx) / [`packages/clipboard-history-1.0.3.asar`](packages/clipboard-history-1.0.3.asar)、[`packages/clipboard-history-1.0.2.zpx`](packages/clipboard-history-1.0.2.zpx) / [`packages/clipboard-history-1.0.2.asar`](packages/clipboard-history-1.0.2.asar)

1. 下载并双击 `packages/clipboard-history-1.0.4.zpx`，或在 ZTools 插件页选择「导入本地插件」指向该文件。
2. 在弹出的安装页点击「安装」。
3. 打开插件：在 ZTools 输入 `剪切板` / `剪切板历史` / `clipboard` / `clipboard history`。
4. 插件内过滤：进入插件后直接在 ZTools 主/子搜索框输入关键词。
5. 主搜索直达：在 ZTools 主搜索框直接输入关键词，匹配并选择“剪切板历史”结果进行复制/粘贴。

### 方式二：源码目录安装（本地开发）

1. 确保插件目录包含 `plugin.json`、`index.html`、`preload.js`、`logo.png` 等文件。
2. 按 ZTools 本地开发插件方式安装并注册本目录（可将目录 junction 到 `~/.ztools/plugins-dev/<name>` 并在 `~/.ztools/lmdb/device` 的 `ZTOOLS/plugins` 中登记；安装/注册后重启或重新加载 ZTools）。
3. 打开插件：在 ZTools 输入 `剪切板` / `剪切板历史` / `clipboard` / `clipboard history`。
4. 插件内过滤：进入插件后直接在 ZTools 主/子搜索框输入关键词。
5. 主搜索直达：在 ZTools 主搜索框直接输入关键词，匹配并选择“剪切板历史”结果进行复制/粘贴。

> 修改 `plugin.json`（如 `mainPush`/命令）或首次注册后，通常需要重启或重新加载 ZTools 才能生效。

## 数据

- **本地 JSON**：`$ZTOOLS_DATA_ROOT/clipboard-history-plugin.json` 或 `~/.ztools/clipboard-history-plugin.json`
  - 结构：`{ history, snippets, groups, settings }`（由 `lib/core.js` 的 `normalizeState` 规范化）
- **ZTools「我的数据」**：常用文字同步为 `ztools.db` 文档（`_id: "snippet/<id>"`, `type: "clipboard-snippet"`，含标题/文本/标签/分组/时间等字段）；冲突由 `lib/core.js` 的 `resolveSyncConflict` 按 `updatedAt/createdAt/ts` 取最新记录，本地删除以 `settings.deleted` 删除标记参与判定
- **同步机制**：`app.js` 打开/保存后触发同步，先比对本地与库记录，再按最新记录合并并写库；删除标记（`settings.deleted`）不会随普通保存丢失

## 参考

- 功能与交互参考：`D:\剪切板\clipboard-tool`
- 适配目标：ZTools 插件（`plugin.json` + `preload` + UI/`mainPush`）

## License

[MIT](LICENSE)
