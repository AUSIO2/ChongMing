# 098 — 现行文档与数据维护入口收敛实施记录

对应[设计](./098-现行文档与数据维护入口收敛.md)。

## 执行清单

- [x] 建立稳定的架构不变式、故障处理和数据维护文档。
- [x] 删除 50 份失效阶段稿、历史目标契约和一次性覆盖快照。
- [x] 更新 README、`ARCHITECTURE.md`、`coding.md`、测试导航和仍保留的相关实施记录。
- [x] 调整 `data.repair-news-context` 的调用顺序，补真实 CLI 无副作用预览回归。
- [x] 完成链接、专项、全量和构建验证，隔离两份 `096` 未提交文档。

## 结果

### 文档收敛

- 新建 `docs/README.md`、`docs/architecture/behavioral-invariants.md`、`docs/operations/fault-handling.md` 和 `docs/operations/data-migrations.md`。稳定文档不再以阶段号作为现行契约入口。
- 删除 50 份、7,592 行已失效的 `050`–`060`、`068`、`071`、`072`、`075`、`076` 和 `078` 工件。其中 `052` 的历史索引、目标 TypeScript 契约、示例与自检脚本一并删除，没有搬到现行 `scripts` 伪装为生产检查。
- README 只导航现行主题文档和仍有用的用户手册；`tests/README.md` 改为当前目录、命令和回归边界，删去过时用例数与阶段报告。
- 仍保留的 `073`/`074` 记录不再把已删除的重构计划当成现行入口。个人目录中已不存在的 design skill 绝对链接从 `coding.md` 移除。
- 已忽略的 `docs/.DS_Store` 移至废纸篓 `/Users/xiong/.Trash/ChongMing-docs-DS_Store-20261017`。

### 数据维护边界

- `data.repair-news-context` 现在与 `data.migrate-branches` 一样在应用初始化前单独路由。默认预览只读取目标图集合，不创建无关索引、管理状态或要求整个应用事务初始化。
- 真实 admin 子进程回归对比预览前后 Mongo 集合名，同时验证 `{ matchedMaps: 1, modifiedMaps: 0 }`。
- 审计只读确认当前默认 Mongo 的相关集合为空，但它是 standalone 且旧桌面配置还指向未核验的 legacy 库。本轮没有连接该远程库，没有执行任何 apply，也不以本机空库证明全部部署已迁移。
- `branch-migration.ts` 和 Mongo `maintenance.ts` 继续保留。SQLite 预览会打开并可能初始化数据库文件，文档明确要求先停机并在完整备份副本上预览。

### 验证结果

- 迁移/修复专项：2 个测试文件、21 项全部通过。
- Markdown：78 份现存 Markdown 的相对链接全部可解析；被删文档链接和 `052` 命令引用为 0。
- `npm run test:boundaries`：127 个模块、117 个运行消息文件通过。
- `node develop-docs/064-校验入口.mjs` 和 `node develop-docs/077-校验数据定义.mjs` 通过。
- `npm test`：70 个测试文件、471 项全部通过。只出现 Node `node:sqlite` 实验性警告和故障夹具预期的诊断写入退路。
- `npm run build:check` 通过类型、边界、资源准备、Vite、Electron 和 macOS arm64 DMG；仍有已知大 chunk 警告，本机无有效 Developer ID，未签名。
- `git diff --check` 通过。两份 `096` 与实施前快照完全一致，未纳入本轮差异。

## 恢复

本轮实施前快照为 `refs/codex/workspace-snapshots/20261017-before-contract-doc-cleanup`。被删文档也可从本轮提交的父提交单独恢复；不需要回退用户数据。
