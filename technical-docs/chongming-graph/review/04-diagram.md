# 图表技术审查

| Diagram | 图源 | Commit/Scope/Trace/Code/Reconstruction | 语法与静态产物 | 语义 |
|---|---|---|---|---|
| S-01/S-02/D-01/ST-01 | Mermaid | 辅助图含 Commit/Scope；无 trace 的全局图不伪造 | `.mmd` 均生成 SVG、1600px PNG、1000px 窄版 PNG | 与分析模型一致 |
| UC-01/02/03 | Mermaid sequence | 完整 | 三种产物生成成功 | 与各 trace 一致 |
| UC-04-A/B/C | Mermaid sequence | 完整 | 按 059 快照重新生成三种产物 | 范围派生、Source/DSH 执行、Operation 审核和暂停恢复拆分无漏续接 |
| UC-04-D | Mermaid flowchart | Commit/Scope/Trace/Code/Reconstruction 完整 | 三种产物生成成功 | Source→News→Claim→Verification、until、复用与空结果一致 |
| UC-05/06 | Mermaid sequence | 完整 | 三种产物生成成功 | 字节准备、事务发布和补偿可见 |
| OPS-01/DEV-01 | Mermaid sequence | 完整 | 三种产物生成成功 | 运维/开发边界分离 |

图源为唯一真源；共 15 份 `.mmd`、15 份 SVG、15 份常规 PNG 和 15 份窄版 PNG，同名一一对应。059 新增/修改图已检查常规与窄版，静态渲染通过。当前环境没有 Draw.io 导入器，未把“未验证”写成通过。
