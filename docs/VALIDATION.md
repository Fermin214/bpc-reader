# 验证

测试覆盖资源准备、文章读取、任务恢复、接口和 BPC 升级。自动化页面使用原创夹具，结果保存在 output 中。

## 环境准备

```sh
npm ci
npm run setup
npm run verify
```

验收环境为 Windows 图形桌面。Node.js 和依赖版本由 package.json 与 package-lock.json 定义。BPC 版本和哈希由 assets/bpc.json 定义。

## 自动化检查

| 命令 | 主要检查 |
|---|---|
| `npm run verify` | 外部工作目录启动真实 stdio MCP、七个工具与健康状态 |
| `npm run mvp-smoke` | 批量、去重、缓存、元数据、队列、恢复和 HTTP |
| `npm run publisher-smoke` | 真实 BPC、三站可见正文、延迟渲染和完整性负例 |
| `npm run mcp-smoke` | 工具 schema、发现、任务、正文输出和 MCP 日志 |
| `npm run lease-smoke` | 跨进程排队、崩溃释放与后续获取 |
| `node scripts/site-registry-smoke.mjs` | 原创第四站的发现、读取、HTTP 和 MCP |
| `node scripts/site-depth-smoke.mjs` | 专题、语义空白、遮罩、缺块、预算与人工验证窗口 |
| `node scripts/feed-smoke.mjs` | RSS/Atom、网络预算、去重、日期和发现接口 |
| `node scripts/bpc-update-smoke.mjs` | 升级预览、切换、回退、损坏输入和中断恢复 |

浏览器测试使用独立 profile。RSS 和文件事务测试直接使用 Node。BPC 升级测试中的文件夹具探针用于事务检查；实际候选由 publisher-smoke 加载到 Chromium 验证。

测试成功时输出通过记录。断言失败时进程返回非零退出码，相关输出目录保留诊断。

## 干净源码安装

运行：

```sh
npm run distribution-check
```

需要代理时添加 `-- --proxy http://主机:端口`。

脚本按实际 .gitignore 选择公开源码，再建立临时本地 Git 仓库和干净检出。检出目录包含中文和空格。检查步骤包括：

1. 安装锁定依赖。
2. 下载匹配 Chromium。
3. 初始化内置 BPC。
4. 再次初始化，并核对 profile ID。
5. 生成当前安装的 MCP 配置。
6. 从外部工作目录连接真实 stdio MCP。
7. 执行 MCP 浏览器端到端夹具。
8. 保存回执并清理临时安装。

## 真实文章回归

1. 在三个媒体中各选一篇代表文章。
2. 根据变更范围补充专题、短文或付费模板。
3. 使用 refresh=true，将结果写入新的输出目录。
4. 逐篇记录 status、正文哈希、段落首尾和完成依据。
5. 对比变更前后的正文与元数据。
6. 对有变化的结果检查页面证据，记录具体原因。
7. 保留任务 ID、URL 和诊断路径。

站点验证使用工具窗口。MCP 的分析输入选择 summarizable=true 文章。日期范围任务按返回的 published_at 筛选。

## 文档检查

英文说明采用 [ASD-STE100](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf) 的短句、主动语态和一致术语规则。操作句最多 20 个英文词，说明句最多 25 个英文词。每段围绕一个主题。

项目技术名词包括 article body、browser profile、reading job、site adapter、cache、BPC 和 MCP。命令、字段名和路径保持源码中的拼写。中文说明使用同一术语表述功能与步骤。

发布前核对两版 README、相对链接和命令示例。用户文档直接说明行为、条件和操作步骤。

## 本机材料

.cache 保存浏览器、会话和缓存。output 保存正文与回执。.local-history 保存调查、计划和历史检查点。这些目录由 Git 忽略。

公开源码保留可复现的自动化测试。历史调查和阶段报告保留在本机归档。
