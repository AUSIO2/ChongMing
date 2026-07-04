# 011-implement — 用途前缀类型命名

1. 写对照表（见设计文档）
2. 按「长名优先」全局替换类型标识符（避免 `SplitClaim` 吃掉 `SplitClaimDTO`）
3. 更新定义文件：`shared/types`、catalog、extractor/verifier types、api/types、flow-map types/layout/api
4. `vue-tsc --noEmit` + `npm run test:map`
5. 修正遗漏引用

字段名（`routeInstructions` 等）本轮不改。
