# 安装与 MCP 注册

## 环境

| 项目 | 要求 |
|---|---|
| Node.js | 推荐 24.15.0 或更高的 24.x；完整范围见 package.json |
| npm | 使用当前 Node.js 配套版本 |
| 网络 | 用于依赖、Chromium 下载和网站访问 |
| 桌面 | 图形桌面，用于工具窗口和站点验证 |
| 验收环境 | Windows |

## 安装步骤

1. 获取源码并进入目录。

   ```sh
   git clone https://github.com/Fermin214/bpc-reader.git BPC-Reader
   cd BPC-Reader
   ```

2. 按锁文件安装依赖。

   ```sh
   npm ci
   ```

3. 准备 Chromium、内置 BPC 和专用会话。

   ```sh
   npm run setup
   ```

4. 验证 stdio MCP 连接和七个工具。

   ```sh
   npm run verify
   ```

Windows 执行策略阻止 npm 时，使用 `npm.cmd`。setup 成功后返回 `status: ready`，并写入本机 MCP 配置。

需要代理时，运行：

```sh
npm run setup -- --proxy http://主机:端口
```

将地址替换为当前可用代理。setup 将它写入工具设置。恢复直连时使用 `--no-proxy`。

`--skip-init` 准备浏览器资源并返回 `runtime_prepared`。随后运行完整 setup，即可初始化浏览器会话。

## 注册 MCP

1. 生成当前安装的配置。

   ```sh
   node scripts/mcp-config.mjs
   ```

2. 将输出合并到 Agent 的 MCP 设置。
3. 保留其他服务。
4. 重新连接 MCP。
5. 在 Agent 中调用 `reader_health`，确认 `status: ready`。

配置格式如下。实际路径使用脚本输出。

```json
{
  "mcpServers": {
    "bpc_reader": {
      "command": "<Node可执行文件的绝对路径>",
      "args": ["<安装目录>/src/mcp-cli.mjs"]
    }
  }
}
```

入口使用绝对路径，因此可从其他工作目录启动。安装目录改变后，重新生成配置。支持超时设置的客户端可使用 30 秒启动预算和 700 秒工具预算。

MCP 使用 stdio 直接运行。Agent 的安装与调用步骤见 [使用技能](../skills/bpc-reader/SKILL.md)。CLI 用法见 [CLI 说明](CLI.md)。

## 交给 Agent 安装

将下面的提示词交给 Agent：

> 从 [GitHub 仓库](https://github.com/Fermin214/bpc-reader.git) 安装 BPC Reader。先阅读 README.md、docs/INSTALL.md 和 skills/bpc-reader/SKILL.md。选择持久的独立目录。执行 npm ci、npm run setup 和 npm run verify。根据当前网络配置代理。将生成的 bpc_reader 配置合并到 MCP 设置，保留其他服务。重新连接后调用 reader_health。报告安装位置、调用方式和验证结果。

## 本机数据

| 位置 | 内容 |
|---|---|
| `.cache/browsers/` | 匹配的 Chromium |
| `.cache/profiles/` | 工具专用 profile 和站点会话 |
| `.cache/reader/settings.json` | 会话、驱动、代理、端口和缓存设置 |
| `.cache/reader/mcp.json` | 当前安装的 MCP 配置 |
| `.cache/reader/` | 正文缓存与任务 |
| `.cache/bpc/` | 扩展快照、升级备份和回执 |
| `output/` | 正文、诊断和测试结果 |

这些目录由 Git 忽略。源码更新时保留它们，即可复用会话和历史任务。

## 更新

Reader 源码更新前，先完成当前任务，再更新源码。随后执行 `npm ci`、`npm run setup` 和 `npm run verify`，并重新连接 MCP 或 HTTP 进程。

仅更新 BPC 时，使用 [BPC 升级流程](BPC-UPGRADE.md)。新任务会读取新的扩展快照。

## 常见操作

- Node.js 版本不符：切换到 package.json 支持的版本，再执行 npm ci。
- Chromium 下载失败：核对当前网络和 setup 的代理地址。
- 网站要求验证：使用 `interactive=true`，在工具窗口中完成验证。
- MCP 工具列表仍是旧版：重新连接该 MCP 服务，再调用 reader_health。
- 资源校验失败：通过 bpc-update 查看状态、升级或回退，并保留对应回执。
