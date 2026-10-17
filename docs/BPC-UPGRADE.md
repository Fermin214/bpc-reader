# BPC 升级与回退

升级命令从本地解压目录导入 BPC。正式资源保存在 `vendor/bpc/`，校验记录保存在 `assets/bpc.json`。

## 升级步骤

1. 准备 MV3 扩展目录，其中包含 manifest.json、background.js 和 LICENSE。
2. 在 BPC Reader 安装目录预览变化。
3. 确认版本、文件、扩展身份和权限变化。
4. 执行 apply。
5. 保存输出的升级 ID 和回执路径。
6. 运行 verify，再刷新常用文章。

```sh
npm run bpc-update -- inspect --source "<解压目录>"
npm run bpc-update -- apply --source "<解压目录>"
npm run bpc-update -- status
npm run verify
```

将 `<解压目录>` 替换为实际路径。源目录保持只读。相同资源再次 apply 返回 `up_to_date`。

源目录中的完整嵌套 BPC 副本会列入 ignored，并在暂存时排除。上游 custom 等正常资源仍保留。文件复制和哈希使用原始字节。

## 激活前验证

apply 依次执行以下步骤：

1. 检查 MV3、版本格式、许可证和打包 worker。
2. 复制选定资源到升级目录的 candidate。
3. 核对暂存文件的版本、数量和哈希。
4. 使用独立 profile 运行 publisher-smoke。
5. 再次核对候选哈希。
6. 备份当前扩展和原始 bpc.json。
7. 切换目录与校验记录。

publisher-smoke 启动已安装的 Chromium，并实际加载候选 BPC。它检查三站启用状态、session rules、Reuters 本地规则和原创页面正文。Bloomberg 延迟渲染、未知块、缺块及遮罩也参与检查。

验证失败或超时时，命令返回错误，正式资源保持当前版本。validation 目录保存日志和验证回执。

扩展 key 改变时，apply 返回身份变化错误。低版本导入使用 rollback 流程。相同版本但内容变化时，inspect 列出对应提示。

## 运行中的任务与缓存

每个任务固定一份 BPC 快照。升级验证期间，新任务使用当前版本。切换完成后，新任务使用新版本。运行中的任务继续使用原快照。

正文缓存键包含 BPC SHA-256。升级后，新版本使用独立缓存；回退后，原版本尚未过期的缓存可继续使用。现场回归使用 refresh=true。

profile、Cookie、缓存 TTL 和已完成任务保持原有数据。首次安装带快照固定逻辑的 Reader 代码后，重新连接旧 MCP 或 HTTP 进程。此后的 BPC 更新在新任务中生效。

## 回退

1. 运行 status。
2. 选择 `applicable_rollback: true` 的升级记录。
3. 使用该记录 ID 执行回退。

```sh
npm run bpc-update -- rollback <升级记录ID>
```

回退核对当前版本与目标记录，再校验备份。旧版本通过相同浏览器验证后，流程恢复旧扩展和原始校验记录。回退本身也生成新事务并保留切换前的版本。

## 中断恢复

切换过程使用短暂资源锁和事务日志。进程中断后，下次 status、资源校验或新任务会检查日志。

未提交的切换恢复旧资源。已提交且校验一致的切换完成清理。日志或备份校验失败时，流程退出并保留现场。

`.cache/bpc/updates/<id>/` 保存计划、验证日志、备份和回执。`.cache/bpc/runtime/` 保存任务快照。这些目录保留已使用版本，供运行中任务和回退使用。

## 实现与测试

| 文件 | 职责 |
|---|---|
| `src/bpc-assets.mjs` | 资源校验、固定快照和恢复 |
| `src/bpc-update.mjs` | 差异、验证、切换和回退 |
| `scripts/update-bpc.mjs` | 本机管理命令 |
| `scripts/bpc-update-smoke.mjs` | 原创文件事务与恢复测试 |
| `scripts/publisher-smoke.mjs` | 候选扩展的 Chromium 验证 |

测试步骤见 [验证说明](VALIDATION.md)。实际文章回归使用现有读取任务，记录正文哈希、段落首尾和站点完成依据。
