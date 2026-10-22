# 080 — 清理旧 Graph 配置与兼容契约实施记录

日期：2026-09-30。设计见 [080](./080-清理旧Graph配置与兼容契约.md)。

## 起点

保留 079 已有未提交拆分及调用方迁移。基线类型、边界与 61 个专项测试已通过。

## 已完成

1. 删除公共 GraphRunConfiguration、GraphSeedConfiguration 和 control.configuration()。工作区模块拥有 WorkspaceSeedInput/WorkspaceSeedConfiguration，默认常量改为 DEFAULT_WORKSPACE_SEED，本机装配输入明确为 seedConfiguration。
2. seedReadInput 必须收到完整 parse/split/verify 阶段；删除补齐阶段的默认回退。旧配置和 LegacyGraphRouteSlot 由存储迁移模块私有定义，保留历史验证规则与离线迁移能力。
3. 工作区测试改用 executionCatalog()，按 id+version 验证内容；保留 CRUD、权限、共享设置、不可变版本及快照隔离断言。初始化夹具显式提供完整阶段，旧迁移夹具继续构造缺阶段旧输入。
4. GraphRun 区分 GraphCurrentRun 与终态归档，当前运行必须具有 branchState 和 maxAgentSlots。七个仅本文件使用的辅助类型取消导出。
5. 删除 review.update 残留及旧配置错误消息/客户端错误映射，客户端方法白名单使用 satisfies 约束到现行输入契约。ClusterSettings 不再通过旧运行配置索引工具类型。
6. 六个 Graph 契约文件的公开类型由 51 个收窄为 44 个；原有七个辅助结构保留为文件内类型，新增的 GraphCurrentRun 表达真实执行前提。

## 验证结果

- 类型与架构/消息边界检查通过；旧类型名、旧配置方法及失效命令的运行源码引用已清零。
- 首轮 9 个文件、85 个测试：84 通过，1 个迁移后的测试断言失败。原因是空工作区仍保留基础数据包，不是 packages 为空；改为检查 Agent/转换为空且基础数据类型仍存在，没有修改生产行为。
- 新增 3 个初始化边界测试，覆盖缺阶段拒绝、输入隔离、跨阶段身份冲突和工具约束。
- `npm test`：53 个文件、302 个测试全部通过，包含 Mongo/RabbitMQ、DSH、SQLite、本机、桌面进程、客户端及旧数据迁移回归。
- 收尾时简化运行状态缩窄、删除旧错误声明并补齐测试夹具类型；相关 6 个文件、59 个测试再次全部通过。
- `vue-tsc --noEmit`、`npm run test:boundaries` 与 `git diff --check` 最终通过。
- 对本次重点修改的工作区、种子、旧迁移测试额外执行 `tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --resolveJsonModule`，最终通过。首次手工命令未带项目使用的 strict，导致 unknown 缩窄诊断；同时发现测试原有 Mongo 字符串主键/数组 schema 缺失及新旧夹具形状分离后的 parse 字段赋值问题。改用 strict 并给测试集合声明真实字段类型，历史可选字段通过 Object.assign 显式构造，未放宽生产输入验证。
- 未执行桌面安装包构建或手动 UI 验收。
