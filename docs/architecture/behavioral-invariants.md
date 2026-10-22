# 业务不变式

本文记录现行实现在重构时必须保持的跨模块行为。具体字段以 [`contracts`](../../contracts) 为准，模块归属与入口以 [`ARCHITECTURE.md`](../../ARCHITECTURE.md) 为准，代码表达规则见 [`coding.md`](../../coding.md)。

## 部署边界

- 独立本机模式使用 SQLite、进程内通知和一个内置 Host，不要求 MongoDB 或 RabbitMQ。协作模式使用 MongoDB、RabbitMQ、Graph API 和一个或多个 Host。
- 两种部署共用图、定义、权限、Run、Work、Review 和 Receipt 规则；适配器差异不得演变成两套业务语义。
- UI、CLI 和 Electron Main 只通过公共客户端契约访问业务服务。Graph Server 不加载 DSH，协作 Host 不加载 Mongo 存储实现。

## 数据与执行身份

- `GraphNode` 由 `id/revision/typeId/typeVersion/payload` 表达；工作区发布不可变数据类型和转换定义。默认事实核查包是一个定义包，不是核心图的固定联合类型。
- `successor` 扩展结构闭包；`reference` 不扩展闭包，但它及 payload 中的节点引用会进入版本摘要。
- Map、分支、Run、Operation、Work、Review、租约和 Receipt 使用各自稳定身份。DSH Session 只是一次执行尝试的本机上下文，不是分布式业务身份。
- Run 冻结转换、输入版本、Agent、工具、schema 和依赖。已接受产物从持久收据恢复，未提交尝试可用新 DSH Session 重跑。

## 分支、租约与原子提交

- 协作模式修改既有分支时同时校验分支内容证明和 `holder/fence`。创建完全独立的新根可使用 `expectedVersion: null`，仍检查新根与当前占有冲突，但不需要预先领取不存在的分支。父子分支、共享后继或多根范围交叉时互斥，不相交分支可并行。
- `ownershipRevision` 与图内容 `revision` 分开。领取、续租和释放不伪造内容变更，但 SSE 仍必须传递新的占有基线。
- 协作模式的 `run.start` 原子消费编辑租约；本机 `clientLeases: none` 模式不读取或删除客户端编辑租约。两种模式都建立持久 Run 范围占有，拒绝重叠范围，并允许不相交范围在同一 Map 中同时运行。
- 暂停只撤销所属 Run 的 Work 授权；取消、接管、失租或 fence 更新后，旧 grant 不得提交结果或失败。已接受收据仍能证明原结果。
- 最终写入在存储条件中重新检查内容版本、占有代次、范围和授权，不只依赖服务层的先读快照。

## 鉴权、幂等与慢 I/O

- 公共请求先建立当前身份和资源权限，再以用户隔离的 `requestId`查找 Receipt；猜中他人请求身份不得获得结果。
- 合法重放先于新的 revision 冲突判定。同一 `requestId` 只能对应同一 method 和输入摘要；换输入必须返回幂等冲突。
- 模型、网络、文件流和 DSH 子进程等慢 I/O 不得在用户数据库事务中长时运行。未知提交结果使用原请求身份重试，不以新 ID 猜测。
- 资产上传/导入的提交结果不确定时，不得删除可能已被收据引用的 blob；重试由幂等身份裁决。

## 消息、客户端与旧响应

- RabbitMQ 通知是至少一次的唤醒信号，不是业务事实本身。模型尝试可能重跑，但已接受产物必须由 Receipt 和 grant/fence 保证幂等。
- SSE 先建立经过鉴权的完整基线，再接受后续序列。撤权、订阅失效和断线都必须结束当前流。
- 界面切换连接、工作区、Map、证据条目或模式时必须切换请求代次并取消旧工作。旧成功和旧失败都不得覆盖新视图。
- 关闭窗口、切换 Map 或 CLI 退出不等于取消后端 Run；取消必须使用明确业务命令。

## 验证责任

[`tests/backend`](../../tests/backend) 验证图、存储、消息、Host 和 DSH 语义；[`tests/client`](../../tests/client) 验证公共客户端、界面状态和过期结果隔离；[`tests/apps`](../../tests/apps) 验证运行入口。历史测试数、文件数和旧函数清单不是现行覆盖标准。
