# Implement: 无头 CLI 部署

对应设计：[043-无头CLI部署.md](./043-无头CLI部署.md)

## 任务清单

- [x] `paths.ts` + app/db/client-identity 解耦
- [x] `graph-events.ts` + `sendToRenderer` 双写
- [x] `inprocess-api.ts`：`apiBuildInprocess`
- [x] `server/bootstrap.ts` / `errors.ts` / `commands.ts` / `cli.ts`
- [x] MapAPI `addRootNews` / `addRootClaim` 透传 content
- [x] `package.json` headless 脚本
- [x] 冒烟测试（events + paths；commands 输出契约）
- [x] typecheck / 相关单测
