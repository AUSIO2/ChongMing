# DEV-01 独立 DSH SDK 调试

## 业务目标与完成条件
在不进入 Graph/Host 协议时，以本机 HTTP 验证 DSH profile、模型会话与通知流。

## 入口与调用者
backend/main.ts 启动；GET /health；POST /runtime/dsh/run。

## 正常调用链
`dshHttpCreateServer → DshRuntime.run → DeepSeekHarness.run`，把 SDK 通知逐行输出，最后输出 sessionId、finalResponse 和事件集合。

## 分支与异常
请求体仅接受 prompt 与可选 sessionId，最多 1 MiB。headers 已发送后的失败写 NDJSON error；此前失败返回 JSON 400。进程关闭会关闭整个 harness。

## 当前实现边界
它是本机开发能力，不使用用户鉴权、Workspace、lease 或业务 proposal，也不是产品公共 API。

## 源码证据
`backend/main.ts#main`；`backend/dsh-http.ts#dshHttpCreateServer`；`backend/dsh.ts#dshCreateRuntime`。
