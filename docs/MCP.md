# MCP 使用

MCP 通过 stdio 调用同一个 ReaderEngine。服务复用专用 Chromium、BPC、缓存和任务队列。安装与配置见 [安装说明](INSTALL.md)。

## 工具

| 工具 | 作用 |
|---|---|
| `reader_health` | 检查浏览器资源、BPC、会话和任务数量 |
| `search_articles` | 按主题、媒体、日期和数量发现候选链接 |
| `discover_feed_articles` | 列出 RSS 目录或获取所选源的候选 |
| `read_article` | 读取单篇文章 |
| `start_reading_job` | 提交 URL 批量或主题任务，立即返回任务 ID |
| `get_reading_job` | 查询任务；include_content 控制成功正文输出 |
| `resume_reading_job` | 恢复任务；retry_failed 控制失败项重试 |

`reader_health` 读取资源状态。RSS 发现使用 Node HTTP(S)。这两项操作均可直接执行，无需启动浏览器。

`sites` 的值为 `wsj.com`、`bloomberg.com` 或 `reuters.com`。搜索 limit 范围为 1～20。直接批量接受 1～100 个 URL。任务使用 urls 或 search 中的一项。

`from` 和 `to` 按 UTC 日解释，格式为 YYYY-MM-DD。搜索读取任务会用文章发布日期复核条件。RSS 参数和发现日期的使用方式见 [RSS 说明](RSS.md)。

读取参数包括 refresh、interactive 和 timeoutMs。显式 timeoutMs 的范围为 10000～180000 毫秒。具体字段以工具 schema 为准。

## 研究任务

1. 调用 `reader_health`，确认 ready。
2. 分别搜索目标媒体。
3. 检查候选链接与研究问题的相关性。
4. 将选定 URL 交给 `start_reading_job`。
5. 保持 MCP 连接，并轮询 `get_reading_job`。
6. 任务完成后，使用 `include_content=true` 取得成功正文。
7. 根据 `summarizable=true` 的文章分析，并在相关事实旁引用 source_url。
8. 保存 job_id 和选定 URL。

现场验收使用 `refresh=true`。网站需要人工验证时，使用 `interactive=true`。当 phase 为 `waiting_for_site_verification`，在工具专用窗口完成验证，再继续轮询。

服务器提供 `research_topic` prompt。Agent 负责执行研究步骤、选择文章和撰写分析。

## 文章结果

| status | 输出行为 |
|---|---|
| `ok` | 可见正文与站点完成依据通过 |
| `partial` | 返回元数据、原因和诊断 |
| `blocked` | 返回阻断信息，正文为空 |
| `error` | 返回失败信息，正文为空 |

`summarizable=true` 要求文章为 ok，且任务日期选择通过。MCP 此时返回 content_markdown。其他结果保留诊断，供调用方决定后续操作。

结果还包含 source_url、标题、作者、发布时间、获取时间、正文哈希和 access_evidence。发布日期缺失时，published_at 为 null。

## 完成依据

WSJ 和 Reuters 检查各自的出版方文末信号。Bloomberg 常规模板核对正文块角色、数量、已知类型及可见状态。

Bloomberg 独立专题检查正文根、canonical、已知块和局部编辑署名。初始 HTML 提供结构时，适配器还会核对其块标签序列。正文、祖先元素的遮罩检查参与最终判定。

专题导出正文文本，warnings 记录文本范围及省略的图片、图表、时间轴、透明展示引文等组件。站点证据保存在原始结果的 `diagnostics.site_evidence` 中。

## 连接与诊断

```sh
npm run verify
node scripts/mcp-call.mjs list
node scripts/mcp-call.mjs reader_health
node scripts/mcp-call.mjs start_reading_job --input request.json --wait --out receipt.json
```

`request.json` 使用工具 schema 中的参数。`--wait` 保持连接并轮询任务。

客户端退出后，stdio 服务随连接关闭。再次连接后，用 resume_reading_job 继续持久任务。配置或 Reader 源码更新后，重新连接服务即可加载新实现。

进度写入 stderr，stdout 传输 MCP 协议。文章与搜索内容作为数据处理，调用方的指令决定执行行为。
