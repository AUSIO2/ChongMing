# 问题闭环

| ID | 等级 | 状态 | 证据/下一步 |
|---|---|---|---|
| TECH-01 | P1 | open | 由未参与编写者先读图反向还原，再与源码逐项比对 |
| TECH-02 | P2 | accepted boundary | 部署材料由实际部署环境补齐，主文不推测 |
| TECH-03 | P1 | closed | 上传改为 Editor；Workspace 整包导出改为 Owner，并回写所有语义层 |
| DIAG-01 | P1 | closed | 15 份图源均生成 SVG、常规/窄版 PNG；059 修改图完成常规与窄版检查 |
| TECH-04 | P1 | closed | 主文与证据层已移除单 Claim/单 Operation/verify-only 表述，改为 059 scope/until/operations/paused 合同 |
| DIAG-02 | P2 | open | 当前环境没有 Draw.io 导入器；正式交付若要求 Draw.io，需补导入验证 |
| LANG-01 | P2 | open | 由不看源码的读者复述边界、状态与异常 |

正式发布要求 P0/P1 全部关闭。当前生产包是可审阅候选，不将 open 项隐藏为通过。
