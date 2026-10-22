# 109 实施 — 网站真实新闻闭环演示

用户已授权在正式网站实际运行。预检Graph、Host、RabbitMQ正常，r108；现有11个Agent及默认模型配置存在。原Owner正常连接后，仅新建独立演示工作区和图。

## 已执行网页流程

- 独立工作区 `29079f5f-451e-4129-b8f2-4715015617d6`，名称“新闻闭环演示 · 嫦娥六号”。原“熊博士”工作区保持。
- 图 `3dce97d0-6f91-4823-9d98-f0f8248f4285`，名称“嫦娥六号 · 新闻拆分到核查结论”；News `2b190ae5-2afa-457c-9a65-f71298b33628` 保存三句演示摘要、三条公开报道链接以及AI可见的证据范围要求。
- 网页配置自动保存，两步 `split-news → verify-claim`，第二步claim端口绑定前步claims，news上下文选择原新闻。只有正常表单写入，没有用API代写运行或模型产物。
- 首轮Run `7ec83099-307a-45eb-b82b-e108fe46c199`：使用@1转换、冻结 `deepseek-v4-flash`，在拆分route阶段失败，WORK_FAILED，0个正式工作接纳。
- 第二轮Run `367363f5-77ab-41ff-ba41-8c4ccf49e42d`：使用@2转换、冻结 `deepseek-flash`，同样在拆分route失败。两次均未生成Claim、Opinion或Verification，当前是1News、0边，不能称为已跑通闭环。

## 模型名称核查与配置操作

初步仅从 `/models` 列表看到 `deepseek-flash`、`deepseek-v4-pro` 而推断旧名不可用，该推断不充分。用户指出V4.1 Flash后，核对[官方当前模型页](https://api-docs.deepseek.com/quick_start/pricing/)和[2026-10-17更新说明](https://api-docs.deepseek.com/updates/)：

- 当前规范API ID为 `deepseek-flash`，对应DeepSeek-V4.1-Flash-1017。
- `deepseek-v4-flash` 仍作为兼容别名被接受，未出现在模型列表不能据此断定失效。
- 因而不能把首轮失败断言为模型名称错误。第二轮规范ID也失败，已进一步证明名称不足以解释实际阻塞。

为使用规范ID，网页只给本演示工作区10个实际使用Agent保存provider/model覆盖，修订为@1，parse保持@0。旧转换引用不可变快照，故又从原包建立 `chongming.fact-checking@2`：dataTypes为空、直接依赖原包@1，只新增split-news@2和verify-claim@2，type refs仍@1、Agent refs为新@1。正式定义校验离线通过后，经网页粘贴检查/发布，工作区版本11。全局/共享库、旧定义/旧Run快照保持，未改变产品代码或服务。

草稿与核对位于 `model-compatible-package.json`、`demo-definitions-v2-validation.json`、`workspace-config-final.json`。先前关于“模型名不可用”的中间判断以本段更正为准。

## 实际阻塞：已配置Key的账户额度

为避免盲重跑，用同服务用户、相同已配置密钥、现有SDK及规范模型做一次有界单turn最小诊断。独立home，不装业务grant、不创建GraphRun；只投影错误码/状态和事件计数，不保留模型正文、原始错误消息或密钥。结果：

- `turn/end.reason.kind=error`，`error.code=QUOTA`，HTTP状态402，安全错误类别insufficient_balance。
- 模型最终输出长度0；SDK进程正常exit0，业务错误经事件返回而没有reject。
- 官方只读账户可用性元数据返回HTTP200、`is_available=false`；没有记录余额数值。
- 自有进程和目录已清理。一次诊断脚本最初argv设错，在启动DSH前退出，未请求模型；修正后的单turn才是实际调用。

安全证据：`test-results/109-production-news/provider-diagnostic.json`。现有执行器未把模型turn错误作为失败原因，而重复三轮后报“未提交”，所以网站只有通用WORK_FAILED；本次没有为排障扩大异常框架或改实现。

当前需要用户给DeepSeek账户补充可用额度或替换有效且有额度的Key，之后才能继续同一份新闻的完整闭环。没有为代付充值操作、没有上传本机Codex认证到服务器，也没有把失败运行伪装成完成。

## 保留状态

网站保留演示图和两轮失败历史，登录只用了现有Owner身份；本机临时登录材料已删除。计划截图 `configured-plan.png`，第二轮真实失败截图 `second-run-failed.png`。没有运行中的模型任务或待清理诊断进程，没有撤销、删除或伪造任何正式产物；未提交/推送或重新部署代码。
