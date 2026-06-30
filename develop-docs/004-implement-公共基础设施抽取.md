# 公共基础设施抽取 - 实施计划

## 待修改文件清单

### [NEW] [types.ts](file:///Users/xiong/ChongMing/electron/shared/types.ts)
- 新建共享类型定义文件，定义 `Confidence`, `Priority`, `SubAgentConfig`, `RouteInstruction`, `NewsContext` 等通用类型。

### [MOVE] [database.ts](file:///Users/xiong/ChongMing/electron/shared/database.ts)
- 从 `fact-extractor/database.ts` 移动到 `shared/database.ts`。

### [MOVE] [prompt-loader.ts](file:///Users/xiong/ChongMing/electron/shared/prompt-loader.ts)
- 从 `fact-extractor/prompt-loader.ts` 移动到 `shared/prompt-loader.ts`。

### [MODIFY] [types.ts](file:///Users/xiong/ChongMing/electron/fact-extractor/types.ts)
- 重构为仅导出拆分模块专有类型，从 `shared/types` 导入并重导出共享类型。

### [MODIFY] [extractor.ts](file:///Users/xiong/ChongMing/electron/fact-extractor/extractor.ts)
- 修改 `NewsModel` 和 `prompt-loader` 导入路径至 `../shared/database` 和 `../shared/prompt-loader`。

### [MODIFY] [index.ts](file:///Users/xiong/ChongMing/electron/fact-extractor/index.ts)
- 修改数据库和 prompt-loader 导出路径。

### [MODIFY] [types.ts](file:///Users/xiong/ChongMing/electron/fact-verifier/types.ts)
- 从 `shared/types` 导入共享类型，删除对 `fact-extractor/types` 的直接跨模块依赖。

### [MODIFY] [verifier.ts](file:///Users/xiong/ChongMing/electron/fact-verifier/verifier.ts)
- 调整导入路径以使用 `shared/` 下的数据库和 prompt-loader。

## 验证方法
- 运行 `npx tsc --noEmit` 确保整个项目编译通过。
