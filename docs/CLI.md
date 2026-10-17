# CLI 与本机 HTTP

## 命令入口

在安装目录运行 `npm run reader -- ...`。从其他目录调用时，使用 Node 和入口的绝对路径：

```sh
node <安装目录>/src/managed-cli.mjs --help
```

下面的 `<文章URL>`、`<任务ID>` 和目录是占位值。调用前替换为实际值。

```sh
npm run reader -- init
npm run reader -- search "game industry" --sites bloomberg.com,reuters.com,wsj.com --limit 5
npm run reader -- search "game industry" --sites wsj.com --limit 5 --read --interactive
npm run reader -- read "<文章URL>" --interactive
npm run reader -- batch --input articles.json --refresh
npm run reader -- rss
npm run reader -- jobs
npm run reader -- jobs <任务ID>
npm run reader -- resume <任务ID> --retry-failed
```

`articles.json` 使用 HTTPS URL 数组：

```json
["<文章URL1>", "<文章URL2>"]
```

## 读取与搜索参数

| 参数 | 作用 |
|---|---|
| `--session name` | 选择工具专用会话 |
| `--proxy http://主机:端口` | 设置本次调用的代理 |
| `--driver chromium\|chromium-cdp` | 选择浏览器驱动 |
| `--out folder` | 指定本次输出目录 |
| `--refresh` | 重新获取正文 |
| `--no-cache` | 禁用本次正文缓存 |
| `--cache-ttl 24` | 设置正文缓存时长，单位为小时 |
| `--timeout 90000` | 设置单篇预算，单位为毫秒 |
| `--interactive` | 保留工具窗口，供人工完成站点验证 |
| `--reference article.json` | 使用同一 URL 的历史读取结果核对首尾和段落数 |

默认设置来自 `.cache/reader/settings.json`。普通读取的 timeout 范围为 10000～180000 毫秒。交互读取的上限为 600000 毫秒。

搜索使用 `--sites`、`--from`、`--to` 和 `--limit`。日期格式为 YYYY-MM-DD，按 UTC 日解释。limit 范围为 1～20，默认 5。添加 `--read` 后，任务继续读取候选并按文章发布日期筛选。

RSS 参数和来源见 [RSS 说明](RSS.md)。

## 输出与退出码

JSON 结果写入 stdout，进度写入 stderr。任务和正文默认保存在 `output/reader/<任务ID>/`。

| 退出码 | 含义 |
|---|---|
| 0 | 命令成功 |
| 1 | 配置或初始化失败 |
| 2 | 单篇为 partial、blocked、error，或批量包含这些结果 |

批量的 `state: completed` 表示队列已处理完。逐篇结果仍使用各自的 status。

## 本机 HTTP

启动服务：

```sh
npm run reader -- serve --port 8787
```

服务监听 `127.0.0.1`。请求使用 `Content-Type: application/json`，JSON 上限为 64 KiB。服务接受本机 Host 和同源 Origin。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 检查资源与会话 |
| GET | `/jobs` | 列出任务 |
| GET | `/jobs/<任务ID>` | 读取任务状态 |
| POST | `/read` | 读取单篇 |
| POST | `/search` | 发现文章链接 |
| POST | `/search-read` | 搜索并读取文章 |
| POST | `/jobs` | 提交异步任务，返回 202 |
| POST | `/jobs/<任务ID>/resume` | 恢复任务，返回 202 |
| POST | `/rss-discover` | 列目录或按需获取 RSS 候选 |

单篇请求示例：

```json
{
  "url": "<文章URL>",
  "refresh": true,
  "interactive": true,
  "timeoutMs": 90000
}
```

批量请求使用 `urls` 数组；主题任务使用 `search` 对象。异步响应中的 `status_url` 用于后续轮询。

HTTP 使用服务端默认输出目录。参数错误返回 400；正文结果使用 JSON 中的 status。RSS 请求字段见 [RSS 说明](RSS.md)。

## BPC 管理命令

`npm run bpc-update` 提供 inspect、apply、status 和 rollback。操作步骤见 [BPC 升级说明](BPC-UPGRADE.md)。
