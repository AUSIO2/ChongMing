# OPS-01 初始化、诊断与维护

## 业务目标与完成条件
启动图服务，初始化共享配置和管理员，诊断数据库/端点，管理用户 token、本机密钥，并显式修复存量 News 或迁移旧单 Operation Run。

## 入口与调用者
graph-main 进程、GET /health、admin CLI 的 init/user/token/agents/assets/settings/secret/database/endpoint/data.repair 动作。

## 正常调用链
graph-main 读取本机配置与环境变量，连接 Mongo，初始化索引和 seed 必要状态，再监听 loopback。admin CLI 解析 JSON 文件或 stdin，按动作调用 LocalSettings、Auth、Control、Assets 或 repair。`data.migrate-node-runs` 默认只检查，apply 前要求停止 Host 并拒绝仍有有效 lease 的旧 Run。

## 持久化读写
Mongo 所有管理集合；本机 `.chongming-host` 下 settings/secrets JSON 使用 0600 临时文件原子替换和互斥 lock。

## 异常、补偿和并发
Mongo 必须支持事务；database.stage 先测试再保存，不热切连接。配置并发写返回 LOCAL_SETTINGS_BUSY。两种数据 repair 默认 dry-run；旧活动 Run 迁移后保持 paused，不自动执行。

## 源码证据
`backend/graph-main.ts#main`；`backend/admin-main.ts#adminRunCommand`；`backend/local-settings.ts`；`backend/repair.ts#repairUpdateNewsContext`；`backend/auth.ts#initialize`。
