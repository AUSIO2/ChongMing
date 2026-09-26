# 073 — 文件树与模块命名整理实施记录

## 实施顺序

1. 保存当前工作区快照，确认旧文件和目标文件不冲突。
2. 根据迁移表机械移动文件，按真实文件位置重写所有运行/测试引用。
3. 更新入口、构建、校验脚本及现行文档，给主要module编写简短导航说明。
4. 检查代码语法除路径外保持，完成类型、测试、入口隔离和打包验证。
5. 更新072的实施前置条件，内部深模块重构仍为后续阶段。

状态：文件树与命名整理完成；072内部重构仍待实施。

## 实际变更

- 按[迁移表](./073-文件迁移表.json)移动/重命名103个文件，107个文件中的394处路径引用已同步。
- backend/core不再存在。现有代码归入application、modules/graph、workspace、identity、assets、shared、ports、adapters和execution。
- 原apps/server拆为graph-server与execution-host，独立本机为local-server，诊断入口为dsh-diagnostics；桌面文件名直接表达main、preload、IPC、连接、凭据和本机子进程。
- UI按features中的graph、run、workspace、agents、assets、settings、management归组；会话和传输分列state、transport；测试目录按后端模块和运行端对应归类。
- package命令、Vite入口、DSH资源复制、测试子进程/mock路径、架构/入口校验同步更新；没有旧路径shim或重导出。
- ARCHITECTURE.md展示真实文件树及“从哪里开始读”映射；新增backend/README.md和apps/README.md，更新tests说明、coding.md及072前置条件和路径。

## 行为保持证据

150个TS/JS/Vue及维护脚本在迁移前后进行AST结构对照，只允许登记的文件路径文字变化；Vue的template/style正文也保持。迁移后再次核对目标哈希，150项全部匹配。

业务导出函数、命令与字段、租约/事务算法、数据库集合、状态推导和错误文案未改。脚本校验规则与入口/命令路径单独更新，不纳入“业务表达式未变”的错误归类。

## 验证结果

- npx vue-tsc --noEmit通过。
- npm run test:boundaries通过：76个模块、58个本机依赖闭包文件、80个运行时消息扫描文件。
- 064入口检查通过：CLI、Main、preload、UI依赖闭包分别为12/17/8/34个文件。
- 052历史契约检查通过：9个查询、25个命令、547个本地链接（其中517个历史归档链接）；历史来源索引未重写。
- 首次npm test：254通过、3个SSE用例创建连接时返回503。消息模块单独复验12/12通过；未修改业务或测试逻辑后再次npm test，38个文件、257个测试全部通过。503对应消息连接不可用分支，初次断连根因未进一步确认，保留该记录而不将复跑等同于修复了一个逻辑缺陷。
- npm run build:check通过：类型、边界、Vite、macOS arm64 DMG。产物未签名，沿用本机无有效Developer ID的现状。
- npm run test:desktop-runtime通过：随包Node、SQLite、DSH、重启、父IPC断开及相邻插件资源定位。
- 迁移表103项均确认旧路径不存在、目标存在；9份当前导航/计划文档的链接检查通过；git diff --check通过。

## 恢复信息

移动前完整工作区快照：/Users/xiong/.codex/backups/chongming-073.9WDINe/workspace-before.tar.gz。

同目录保存一次性迁移脚本及migration-proof.json。它们位于仓库外，仅作恢复与审计，不作为运行依赖。旧空目录已移除，文件可从快照恢复；用户数据库和本机运行数据未删除。未创建提交或推送。
