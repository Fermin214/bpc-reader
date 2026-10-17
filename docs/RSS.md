# 按需 RSS 发现

RSS 返回候选 URL 和发现元数据。调用方选择链接后，再使用 read、batch 或 MCP 阅读任务取得正文。每次发现使用源的当前条目窗口。

## 来源目录

`feed_ids` 选择具体来源。`sites` 选择媒体的栏目源。作者源通过自己的 ID 单独选择。

| ID | 内容 |
|---|---|
| `bloomberg-technology` | Bloomberg Technology |
| `bloomberg-markets` | Bloomberg Markets |
| `bloomberg-businessweek` | Bloomberg Businessweek |
| `bloomberg-industries` | Bloomberg Industries |
| `bloomberg-jason-schreier` | Jason Schreier 作者源 |
| `wsj-technology` | WSJ Technology |
| `wsj-business` | WSJ US Business |
| `wsj-world` | WSJ World |
| `wsj-markets` | WSJ Markets |
| `wsj-opinion` | WSJ Opinion |

无参数调用返回目录，其中包含来源 URL 和媒体信息。选择 Reuters 时，结果中的来源状态为 `unavailable`。各次请求分别记录源的响应状态。

## CLI

```sh
npm run reader -- rss
npm run reader -- rss --feeds bloomberg-jason-schreier --keywords "Grand Theft Auto" --limit 20
npm run reader -- rss --feeds bloomberg-technology,wsj-technology --keywords gaming --keywords Xbox
```

`--keywords` 可重复，每项按普通词或词组匹配。任一项出现在标题或摘要中，条目就通过关键词条件。

CLI 的 limit 默认 5，范围为 1～20。`--timeout` 设置此次发现的总预算，默认 30000 毫秒，范围为 1000～60000 毫秒。选定文章后，另行调用读取命令。

## HTTP 与 MCP

HTTP 使用 `POST /rss-discover`。MCP 使用 `discover_feed_articles`。两者使用相同请求字段：

```json
{
  "feed_ids": ["bloomberg-jason-schreier", "wsj-technology"],
  "keywords": ["gaming", "Xbox"],
  "from": "2026-10-01",
  "to": "2026-10-17",
  "limit": 20,
  "timeoutMs": 30000
}
```

日期是示例值，调用时按任务修改。`{}` 返回目录。HTTP 和 MCP 的 limit 默认 20。`sites` 与 feed_ids 同时提供时，所选源须属于对应媒体。

## 结果

| status | 含义 |
|---|---|
| `ok` | 所选来源均成功解析 |
| `partial` | 部分来源失败，其余候选保留 |
| `error` | 所选来源均未取得可用结果 |

各源的 outcome 区分有效空源、筛选后为空和缺少支持链接。合法 HTTP 请求返回 200，并在 JSON 中给出发现状态。参数错误返回 400。CLI 的 partial 和 error 使用退出码 2。

候选 URL 经过站点准入、跟踪参数清理和去重。limit 应用于去重后的列表。重复条目的全部来源保存在 provenance 中。

## 日期与正文

`from` 和 `to` 按 UTC 日筛选，包含起止日。候选筛选使用 feed 发布日期；日期缺失的条目单独计数。

选出的 URL 进入阅读任务后，调用方按原日期范围复核文章 published_at。符合日期且 summarizable=true 的文章可用于该时间范围的分析。

feed 的标题、摘要、作者和日期属于发现元数据。正文、正文作者和文章发布日期来自后续页面读取。频道语言保存在来源信息中。

## 传输与记录

RSS 使用 ReaderEngine 的代理设置和独立 Node HTTP(S) Agent。每次最多并行获取两个源。传输上限为 2 MiB，解压后上限为 4 MiB。重定向使用各来源的允许列表，总预算覆盖全部获取步骤。

XML 解析器读取条目数据。DTD、实体声明、HTML 响应和格式错误会产生对应错误。每次请求直接获取当前源；304 响应按缺少缓存正文处理。

`output/feed-discovery/` 保存 discovery_id、源状态、XML 快照和 discovery.json。记录发现 ID、选定 URL 和后续阅读任务 ID，即可复查整条流程。
