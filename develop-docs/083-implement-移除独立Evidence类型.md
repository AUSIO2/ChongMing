# 083 — 移除独立 Evidence 类型实施记录

日期：2026-10-06。状态：清理实现已验证；默认定义反复恢复，尚未完成持久落盘，暂不发布新版。

## 实施原稿

按 [083 设计](./083-移除独立Evidence类型.md) 清理当前默认事实核查开发定义（保留版本 1，暂不发布新版），删除独立 Evidence 类型，意见使用 `evidenceClaimIds` 引用 Claim。源码、测试、定义示例和现行说明同步；保留历史数据，不运行用户数据库迁移。

当前工作区已有大量未提交实现与文档；本次逐文件叠加修改，不重置、覆盖或提交这些改动。

分工：主线程处理默认定义、发行运行检查、说明、验证与交付；迁移子任务处理 branch-migration 及其测试；测试子任务处理其余 tests；定义示例子任务处理 077 示例与校验。

## 变更与验证

默认定义保留 package/type/transition 版本 1，移除 factcheck.evidence 和 Claim 对它的 successor 许可；Opinion 使用 evidenceClaimIds 引用 Claim，schema、展示提示、投影和引用声明同步。发行运行检查及当前默认测试夹具同步字段；图核心继续使用通用声明式校验。

显式旧 kind 迁移只处理可无损解释的当前五类定义。旧 Evidence 阻断整个迁移批次，Mongo/SQLite 回归确认节点与工作区未被部分改写；通用存量的旧节点、payloadReferences 与冻结定义保持原样。本轮未执行用户数据库迁移。

077 示例删除 Evidence/collect-evidence/research 链，改用独立 News→证据 Claim 来源链及 Opinion context 引用；writing 和 Agent fixture 版本保持原样。README、ARCHITECTURE、测试说明和 Sandbox 对接段已同步，历史审计保持其原版本语义。

最新开发状态验证：

- vue-tsc --noEmit 通过（生产源码/界面/发行脚本，不包含 tests 类型检查）。
- npm run test:boundaries 通过：90 个模块及 93 个运行消息文件。
- node develop-docs/077-校验数据定义.mjs 通过：7 类型、6 转换、15 节点、9 次调用、18 关系与 34 项负例。
- npm run test:desktop-runtime 通过：发行 Node + SQLite + DSH、重启和父进程断连。
- 9 个针对性套件、66 项回归通过：默认定义、graph、branch-revision、asset-v4-integration、branch-migration、dsh-verify、generic-run、management、client/integration。覆盖 Claim 引用、跨分支权限、错误类型、退役类型、导入重映射、两适配器迁移和真实执行闭环。
- git diff --check 通过。

本轮首次管理单元回归因临时版本调整错误失败，修正后通过；迁移专测在默认文件恢复旧内容时有 7 项失败，最新 66 项回归包含迁移套件并全部通过。全量 npm test 曾在文件状态冲突期间启动，后中止（退出 143），未宣称全量套件通过。未执行 build:check、界面人工检查或安装包构建。

## 范围调整

用户要求当前改动较多，暂不发新版；撤回本轮 v2 版本号调整，保留 Evidence 退役和 evidenceClaimIds 引用清理。正式发布时统一确定版本与迁移。首次桌面运行检查因默认资源恢复为旧定义而出现 claim@2 未注册；随范围调整重新同步当前版本并复验，不改动用户存量数据。


## 默认文件恢复调查

默认定义在 13:22:20 和 13:25:19 恢复为 HEAD 内容（17645 字节）。本聊天及子任务、同目录两个活跃聊天的相关工具记录没有第三方原内容回写命令，VSCode Git 日志没有 restore/checkout；现有日志不足以确定写入进程。未凭进程存在或无关通知归因，也未联系或停止其他聊天。

13:30:46 用 apply_patch 重新应用本轮清理，文件为 16092 字节。60 秒目录监控只记录该次已知写入，后续发行运行及 66 项回归后再次确认内容保持一致。暂未复现恢复，不宣称已修复未知回写根因。

13:33:31 默认定义第三次恢复为 HEAD 原内容。此前 66 项回归验证的是清理后的定义，不能表示当前工作区仍保持该状态。已保存 [默认定义补丁](./083-evidence-cleanup.patch)，其余实现与测试改动保留。已请用户在本机终端启动管理员文件写入跟踪，等待明确写入者后重新应用补丁；不会因一段监控稳定就宣称未知回写根因已修复。
