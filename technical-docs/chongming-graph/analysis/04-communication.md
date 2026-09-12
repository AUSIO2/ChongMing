# 通信证据

## 用户 HTTP

公开 JSON 接口只有 `/api/v1/query` 和 `/api/v1/command`，以 method 区分契约；上传、下载和导出使用独立流式路径。用户接口以 Bearer 用户 token 鉴权。JSON 请求最大 1 MiB，客户端响应最大 16 MiB；资产和 bundle 上限 64 MiB。

## Host 与图服务

Host 周期性向 `/internal/v1/work` 发 claim；持有 grant 后并行续租并运行 DSH。内部接口用独立 Bearer token。claim/read/renew/release/fail 的数据字段见 `GraphWorkCommand`。请求超时由 Host 使用 AbortSignal 控制；临时领取失败回到轮询，工作执行中的权限丢失会中止 DSH。

## DSH 业务插件与图服务

每个工作生成临时 DSH patch，注入不可变 grant、Operation kind、冻结配置、批准 route 和 persona。插件按 parse、split 或 verify 生成不同 proposal schema，只暴露 `data_read`、`data_propose` 及当前 slot 允许的自定义工具。data 接口还需要 work-id、holder 和 fence headers；模型参数中不包含这些授权字段。

## Source 正文读取

parse Operation 首次执行时，图服务读取共享 Asset 或公开 HTTP(S) URL，并把正文保存到 Operation。URL 读取拒绝凭证、重定向、私网/本机地址和 DNS 重绑定，固定校验后的连接地址；只接受 UTF-8 文本、Markdown、HTML、JSON，最多 1 MiB、总时限 10 秒。

## DSH SDK

`DshRuntime` 通过官方 SDK 启动本机 DSH 子进程并接收 JSON-RPC 通知。图服务不保存完整通知流，只保存业务 proposal 和最终状态。独立开发端点 `/runtime/dsh/run` 才把通知与结果输出为 NDJSON。

## 持久化基础设施

MongoDB 副本集提供事务和多数写；GridFS 存放资产字节。没有 MQ、Redis、定时框架或外部对象存储通信。模型/工具网络由 DSH provider/plugin 负责，图服务只认 provider/tool 逻辑名，不包含第三方内部协议。
