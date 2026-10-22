# 现行文档导航

本目录只放置需要随现行实现继续维护的主题文档。`develop-docs` 中的编号文档是设计与实施记录，可以解释某次变更，但不自动成为当前接口或运维契约。

## 架构

- [模块、依赖与运行入口](../ARCHITECTURE.md)
- [业务不变式](./architecture/behavioral-invariants.md)
- [开发规范](../coding.md)

## 运维

- [故障处理与诊断](./operations/fault-handling.md)
- [显式数据迁移与修复](./operations/data-migrations.md)
- [独立本机运行](../develop-docs/065-本机运行说明.md)
- [桌面本机模式](../develop-docs/066-桌面本机模式说明.md)
- [CLI 使用手册](../develop-docs/077-CLI使用手册.md)

对外数据结构的最终依据是 [`contracts`](../contracts)，运行行为的最终依据是当前实现与自动化测试。文档与两者冲突时，先修正文档或明确修改协议，不保留暗中兼容。
