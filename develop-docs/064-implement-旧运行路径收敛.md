# 064 — 旧运行路径收敛实施原稿

编码前创建。
1. 记录新入口依赖闭包和旧代码清单，完整归档旧文件与修改。
2. 将CLI替换为共享client的认证读写、SSE及文件命令，帮助离线可用。
3. 删除不可达旧源码/专属测试/依赖，收敛构建与类型配置。
4. 用真实隔离API验证CLI及新架构回归，完成构建与引用审计，更新操作说明和剩余边界。

## 完成记录（2026-09-13）

- 新CLI复用client/api：离线help、read/dispatch/watch、上传下载。用户Token与Host Token分离，写操作显式request-id，下载wx防覆盖；中止watch不取消后台Run。
- 删除146个旧文件中的旧Mapper/AgentLoop、API/Main/preload、共享Mongo/模型工具、旧UI和配置，以及专属测试；server/cli.ts原位重写，其余当前client-*与src/main可达的31个文件全部保留。新增CLI4项集成测试。
- 卸载LangChain三项、LangSmith及无用renderer插件，共移除22个安装包。服务端仍保留DSH/Mongo/MQ依赖；桌面安装包排除node_modules，Main仅依赖Electron和Node内置模块。
- 更新类型引用、test:map脚本、测试配置、env示例、CLI文档、当前模块命名表。用户原有coding规范正文约束保留。
- CLI幂等回归暴露map.create已有问题：Mongo重复insert使事务中止，随后读收据触发事务重试。图服务先读已有Map/收据再插入，避免重复创建路径进入已中止事务；不靠延长CLI超时掩盖。
- 052检查切换到历史审计索引，冻结43个旧API方法、15个旧Mapper命令及源码哈希/行数。仍验证历史映射、独立目标契约及链接；514个旧源码链接明确计作历史引用，不宣称源码还存在。
- 050第六阶段的运行路径清理完成；旧Mongo集合未修改。旧Mapper数据导入器、本地服务自动托管仍需后续单独实施。

## 归档与恢复

完整备份位于：
/Users/xiong/.codex/backups/chongming-064-5_aaoo36

其中legacy-source.tar.gz及legacy-identity.tar.gz保存删除前的完整文件（含未提交内容）；manifest.json记录SHA256；worktree.patch记录本轮删除前整个工作区的git差异，status.txt记录状态。主归档逐文件读取校验通过后才删除源码。仅在需要恢复时向另一个空目录解包查看，避免覆盖当前实现。生产项目不引用备份，不保留旧代码兼容路径。

## 验证结果

- CLI专项4项通过：帮助/参数失败不连DB、真实API权限和revision、同request-id创建重放、SSE暂停/恢复、SIGINT后Run继续、资产文件往返与不覆盖。
- 全量31文件/229项通过。相对063的54文件/281项，退役24个旧实现专属测试文件（56项），新增当前CLI1文件/4项；现有backend/client/Electron客户端测试全部保留。
- vue-tsc、build:check通过，产出arm64 DMG；无发行签名，未安装或发布。
- 安装包app.asar实查19项、3,314,072字节；node_modules和旧运行源码项均为0。Main的外部引用仅electron、node:path、node:url、node:fs/promises、node:crypto、url。
- 064入口依赖闭包审计通过：CLI7文件、Main10、preload7、Renderer31；均不加载backend或Mongo/AMQP/DSH依赖。
- 052历史审计与目标契约检查通过（547链接，其中514历史源码链接）；无凭据环境直接运行headless --help成功，git diff --check通过。
- 测试自动清理临时Mongo/RabbitMQ/文件，不操作用户数据库；保留工作区原有的其余未提交修改，未提交或推送。
