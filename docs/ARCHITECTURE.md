# 架构

BPC Reader 的基础流程是发现链接、读取页面、提取可见正文和保存结果。CLI、stdio MCP 与本机 HTTP 共用 ReaderEngine。调用方负责选文和分析。

## 调用链

```text
CLI / MCP / HTTP
  → ReaderEngine
  → 发现候选：浏览器搜索或按需 RSS
  → URL 规范化与去重
  → 成功正文缓存
  → 专用 Chromium + 任务固定的 BPC 快照
  → 站点事实、可见正文与完成依据
  → Readability + Turndown
  → JSON / Markdown / 持久任务
```

RSS 返回候选后，调用方将 URL 交给现有阅读任务。缓存命中时，URL 阅读任务直接使用保存的成功正文。

## 模块

| 模块 | 职责 |
|---|---|
| [reader-engine.mjs](../src/reader-engine.mjs) | 任务、会话队列、去重、缓存和恢复 |
| [discovery.mjs](../src/discovery.mjs) | 浏览器搜索与出版方站内搜索 |
| [feed-discovery.mjs](../src/feed-discovery.mjs) | RSS 获取、解析、筛选和来源记录 |
| [managed-reader.mjs](../src/managed-reader.mjs) | 浏览器资源、单篇读取与结果保存 |
| [browser.mjs](../src/browser.mjs) | Chromium、BPC 配置、页面采集和预算 |
| [native-chrome.mjs](../src/native-chrome.mjs) | Windows 原生 Chromium/CDP 启动 |
| [page-state.mjs](../src/page-state.mjs) | 通用页面事实与就绪状态 |
| [site-registry.mjs](../src/site-registry.mjs) | 静态站点组合与查找 |
| [sites/](../src/sites/) | URL 规则、RSS 目录、站点事实、正文和完成依据 |
| [extract.mjs](../src/extract.mjs) | Readability、Turndown 与页面元数据 |
| [reader-storage.mjs](../src/reader-storage.mjs) | JSON 持久化与成功正文缓存 |
| [reader-lease.mjs](../src/reader-lease.mjs) | 跨进程互斥 |
| [bpc-assets.mjs](../src/bpc-assets.mjs) | 资源校验、固定快照和中断恢复 |
| [bpc-update.mjs](../src/bpc-update.mjs) | 本地候选验证、备份、激活和回退 |

CLI、HTTP 和 MCP 模块负责参数与协议转换。核心流程保留在 ReaderEngine 和读取模块中。

## 静态站点模块

默认注册表包含 WSJ、Reuters 和 Bloomberg。每个模块定义：

- 站点身份、文章 URL 和 URL 规范化规则。
- 浏览器搜索地址与搜索就绪函数。
- BPC 域名及工具本地规则。
- RSS 来源目录。
- 页面事实采集函数。
- 可见正文导出函数。
- 站点完成依据。

注册表在代码中显式组合。新增站点时，先实现独立模块，再加入注册表并运行站点测试。MCP 网站参数从同一注册表生成。

`scripts/fixtures/fourth-site.mjs` 提供原创模拟站点。扩展测试显式注册它，并检查发现、读取、HTTP 和 MCP 行为。生产注册表仍使用三个媒体模块。

浏览器内函数通过 `page.evaluate` 执行。函数使用页面 API 和显式传入的数据。Node 侧函数处理参数、文件及结果分类。

## 正文与元数据

站点模块从渲染后的可见 DOM 导出编辑正文。Readability 和 Turndown 处理该导出文档。

`extractMetadata` 从渲染页面读取标题、日期、作者和语言。读取模块按现有字段优先级补齐缺失值。主文章匹配存在歧义时，对应字段保留为空。

WSJ 使用编辑段落和文章局部文末。Reuters 使用段落与出版方结束信号。Bloomberg 常规模板核对正文块结构；独立专题使用专门的正文根、canonical、已知块和局部编辑署名。

Bloomberg 的 Node 侧 `validateStructure` 在初始 HTML 可用时核对正文块标签序列。站点证据记录在 `diagnostics.site_evidence`。专题结果的 warnings 记录文本范围和省略的组件。

读取模块综合导出路径、站点完成依据、访问状态和引用条件，给出 ok、partial、blocked 或 error。MCP 根据 status 和日期选择决定 summarizable 及正文输出。

## 任务、缓存与会话

同一会话的任务串行执行。Windows 使用命名管道互斥，进程退出后由操作系统释放。批次按需启动浏览器，并在文章之间复用。

任务逐篇保存。恢复时保留完成项，继续处理待办项。调用方通过 retry_failed 选择重试失败项。

缓存只保存 ok 结果。缓存键包含规范化 URL、会话与驱动、适配器版本、站点规则、BPC 哈希及引用条件。默认 TTL 为 24 小时，当前适配器版本为 `visible-article-7`。

刷新任务使用当前代码和资源重新读取。已完成任务保留原始证据。

## BPC 资源

`vendor/bpc/` 保存上游扩展。`assets/bpc.json` 保存版本、来源、文件数和原始字节哈希。`.gitattributes` 保持扩展文件的原始字节。

每个阅读任务先校验资源，再固定到 `.cache/bpc/runtime/<sha256>/`。缓存键和浏览器使用同一个固定版本。资源锁只覆盖校验、固定快照和切换步骤。

升级命令在独立目录验证候选，通过后备份并切换正式资源。事务日志用于恢复中断的切换。运行中的任务继续使用原快照。详细操作见 [BPC 升级说明](BPC-UPGRADE.md)。

Reuters 本地规则位于站点模块，由 site-adaptations 汇总并记录哈希。Bloomberg 延迟页面通过 BPC 自身生命周期触发处理。浏览器使用工具配置的固定规则。

## 相关说明

[安装](INSTALL.md) · [CLI 与 HTTP](CLI.md) · [MCP](MCP.md) · [RSS](RSS.md) · [验证](VALIDATION.md)
