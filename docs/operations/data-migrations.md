# 显式数据迁移与修复

正常启动不会自动改写旧图。管理命令只处理当前 `graphv3`/`control_workspaces` 和本机 SQLite 格式；更早的 Electron Mapper `maps`/`workspaces` 集合不在它们的作用范围内。

## 共同原则

1. 确认目标库或数据目录，不以默认空库的“0 项”结果代替部署清点。
2. 停止 Graph API、Host 和本机服务，等待已发放 Work 租约过期。
3. 先做完整备份，再预览；保留预览 JSON 作为这一部署的核对记录。
4. 只有 `apply:true` 或 `--apply` 才请求数据内容写入。任何 blocked、活动 Run/租约、版本竞争或无法识别结构都应先解决，不要绕过检查。
5. 应用后再运行一次预览，记录 `matchedMaps: 0`。

## Mongo 分支迁移

配置优先级为 `CHONGMING_MONGO_URI` > `CHONGMING_CONFIG_DIR` 指定目录（默认 `.chongming-host`）中的 `settings.json` > 默认本机 URI。先准备内容为 `{}` 的本地 `preview.json`，用它查看脱敏后的实际目标：

```bash
npm run admin -- settings.read --input /absolute/path/to/preview.json
```

确认目标后，用同一个空 JSON 文件执行只读预览：

```bash
npm run admin -- data.migrate-branches --input /absolute/path/to/preview.json
```

输出中：

- `matchedMaps` 是需要迁移或被阻断的图总数。
- `migratableMaps` 是当前可安全转换的数量。
- `activeRuns`/`blockedMaps` 必须先清零或逐项解释。
- 预览中 `modifiedMaps` 必须为 0。

确认备份、停机和预览后，用内容为 `{"apply":true}` 的另一个本地 JSON 文件执行：

```bash
npm run admin -- data.migrate-branches --input /absolute/path/to/apply.json
```

写入使用事务和最终 CAS，因此 Mongo 必须是 replica set 或 mongos。一个问题图会阻止整批应用，工作区定义也不会提前安装。

## 早期 News context 修复

早期 Mongo 图可能因 Mongoose 序列化省略空 `News.context`。分支迁移要求 legacy News 的 `context` 是对象；遇到该阻断时，先运行专用修复预览：

```bash
npm run admin -- data.repair-news-context --input /absolute/path/to/preview.json
```

预览只读取 `graphv3` 并返回 `matchedMaps/modifiedMaps`；不初始化应用集合。确认后使用同样的 `apply.json`：

```bash
npm run admin -- data.repair-news-context --input /absolute/path/to/apply.json
```

写入只给未删除图中缺少的旧 `data.kind: news` 补 `context: {}`，不覆盖已有上下文或现行通用节点；每张被修复的图推进一次 revision。完成后再预览分支迁移。

## SQLite 分支迁移

SQLite “预览”不会改写图记录，但打开持久层可能创建目录、数据库、表/索引、WAL 或版本元数据。因此不要把一个猜测路径当成严格只读检查，也不要用误创的空库报告“无需迁移”。

停止服务后，完整复制数据目录，包括 SQLite 主文件、`-wal`/`-shm` 及 `assets`。先对备份副本预览：

```bash
npm run local:serve -- --directory /absolute/path/to/backup-copy --migrate-branches
```

确认后对明确的目标目录应用：

```bash
npm run local:serve -- --directory /absolute/path/to/data --migrate-branches --apply
```

迁移模式会获取 SQLite 独占锁，不启动 API 或 Host。

## 迁移能力的退役门槛

只有同时满足以下条件，才能讨论删除显式迁移入口：

- 已清点所有部署的 `graphv3` 和 SQLite 数据，并保留各自 `matchedMaps: 0` 证据。
- 产品版本明确宣布不再支持旧开发数据，且回退策略不再需要该入口。
- 即使删除写入迁移器，仍保留当前数据需要的历史 Run 归档、migration 元数据和 `legacyArchive` 读取语义。

实现与回归：[`branch-migration.ts`](../../backend/adapters/storage/branch-migration.ts)、[`maintenance.ts`](../../backend/adapters/storage/mongo/maintenance.ts)、[`branch-migration.spec.ts`](../../tests/backend/adapters/storage/branch-migration.spec.ts) 和 [`maintenance.spec.ts`](../../tests/backend/adapters/storage/maintenance.spec.ts)。
