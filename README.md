# BPC Reader

简体中文 | [English](README.en.md)

BPC Reader 为 AI Agent 和其他程序提供文章发现与正文获取能力。它使用专用 Chromium 和内置 BPC，从渲染后的可见页面提取正文，再输出 Markdown 和 JSON。

当前支持 Bloomberg、Reuters 和 The Wall Street Journal（WSJ）。各站点模块定义可读取的页面类型。

## 主要能力

- 按主题搜索文章，或从内置 RSS 来源发现链接。
- 读取单篇文章，或提交可恢复的批量任务。
- 保存来源、作者、发布时间、正文哈希和完整性依据。
- 缓存成功正文，并区分 `ok`、`partial`、`blocked` 和 `error`。
- 通过 CLI、stdio MCP 或本机 HTTP 接入其他程序。
- 从本地 BPC 目录升级扩展，激活前验证，并保留回退备份。

搜索摘要和 RSS 内容用于发现链接。MCP 仅向模型提供 `summarizable=true` 的正文。研究、选文和分析由调用方完成。

## 安装

需要 npm、网络连接和图形桌面。推荐使用 Node.js 24.15.0 或更高的 24.x 版本。完整版本范围见 [package.json](package.json)。验收环境为 Windows 图形桌面。

1. 获取源码并进入目录。

   ```sh
   git clone https://github.com/Fermin214/bpc-reader.git BPC-Reader
   cd BPC-Reader
   ```

2. 安装依赖并准备浏览器。

   ```sh
   npm ci
   npm run setup
   npm run verify
   ```

`setup` 下载匹配的 Chromium，加载内置 BPC，并初始化专用会话。需要代理时，给 setup 添加 `--proxy http://主机:端口`。

Windows 执行策略阻止 `npm` 时，使用 `npm.cmd`。详细步骤见 [安装说明](docs/INSTALL.md)。

## 接入 AI Agent

1. 运行 `npm run mcp-config`，生成当前安装的 MCP 配置。
2. 将输出合并到 Agent 的 MCP 设置，保留其他服务。
3. 重新连接 MCP，并调用 `reader_health`。

也可以把下面的任务交给 Agent：

> 从 [GitHub 仓库](https://github.com/Fermin214/bpc-reader.git) 安装 BPC Reader。先阅读 README.md、docs/INSTALL.md 和 skills/bpc-reader/SKILL.md。使用独立目录和专用浏览器。完成 setup、verify 和 MCP 注册。保留其他 MCP 服务。最后调用 reader_health 并报告结果。

MCP 通过 stdio 直接运行。工具清单、任务轮询和结果语义见 [MCP 说明](docs/MCP.md)。

## 使用 CLI

将 `<文章URL>` 替换为受支持网站的 HTTPS 文章链接。

```sh
npm run reader -- search "game industry" --sites bloomberg.com,reuters.com,wsj.com --limit 5
npm run reader -- read "<文章URL>" --interactive
npm run reader -- rss
npm run reader -- rss --feeds bloomberg-jason-schreier,wsj-technology --keywords gaming --limit 20
```

搜索默认只返回候选链接。RSS 无参数时只列来源目录。批量任务、日期条件和本机 HTTP 见 [CLI 说明](docs/CLI.md)。

## 读取结果

| 状态 | 含义 |
|---|---|
| `ok` | 可见正文和当前站点的完整性检查通过 |
| `partial` | 正文较短、存在缺块，或完成依据不足 |
| `blocked` | 站点验证或访问限制阻止读取 |
| `error` | 导航、超时、运行或提取失败 |

网站要求人工验证时，在工具专用窗口完成验证。

Bloomberg 独立专题导出正文文本。结果中的 `warnings` 说明导出范围与省略的媒体组件。正文取自渲染后的可见段落。RSS 来源见 [RSS 说明](docs/RSS.md)。

## 升级 BPC

将 `<解压目录>` 替换为包含 `manifest.json` 的 MV3 扩展目录。

```sh
npm run bpc-update -- inspect --source "<解压目录>"
npm run bpc-update -- apply --source "<解压目录>"
npm run bpc-update -- status
```

升级流程先验证候选，再备份并切换资源。运行中的任务保留原版本，新任务使用新版。缓存按 BPC 哈希隔离。回退方法见 [BPC 升级说明](docs/BPC-UPGRADE.md)。

## 文档与源码

| 文档 | 内容 |
|---|---|
| [安装](docs/INSTALL.md) | 环境、初始化和 MCP 注册 |
| [CLI 与 HTTP](docs/CLI.md) | 命令、参数和本机接口 |
| [MCP](docs/MCP.md) | 工具、任务和模型正文边界 |
| [RSS](docs/RSS.md) | 内置来源、筛选和发现结果 |
| [架构](docs/ARCHITECTURE.md) | 模块职责、站点扩展和缓存 |
| [BPC 升级](docs/BPC-UPGRADE.md) | 差异预览、验证、切换和回退 |
| [验证](docs/VALIDATION.md) | 可复现的测试及验收范围 |

`src/` 保存运行代码。`scripts/` 保存安装工具和自动化测试。`vendor/bpc/` 保存固定版本的上游扩展，`assets/bpc.json` 保存校验记录。

`.cache/`、`output/` 和 `.local-history/` 只保存本机数据，不进入 Git。它们可能包含浏览器会话、文章正文或本机路径。

## 许可证

BPC Reader 使用 [MIT 许可证](LICENSE)。内置 BPC 来自 [magnolia1234 的项目](https://gitflic.ru/project/magnolia1234/bypass-paywalls-chrome-clean)。上游版权和许可证保留在 [vendor/bpc/LICENSE](vendor/bpc/LICENSE)。
