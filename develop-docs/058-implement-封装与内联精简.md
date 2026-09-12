# 058 — 封装与内联精简实施原稿

1. 逐个核对小函数的调用点和副作用，区分转发层、单次局部逻辑与真正业务边界。
2. 删除数据库关闭包装器并同步所有调用；内联单次版本检查、数据查询解析和 sender 登记。
3. 将桌面 bridge 工厂并入 gateway，保留取消、错误和来源限制。
4. 复用资产命令解析器，直接引用 control-input，删除无引用类型。
5. 运行回归与类型/构建检查，记录净减少量；只提交本轮文件，按既有约定 push。

全量验证暴露旧 registry 文件测试的异步副作用：catalogCreate/catalogUpdate 以 void import 触发数据库同步，但测试既没隔离数据库，也没等待导入结束，导致环境销毁后仍加载 Mongoose。只修测试边界：mock 本地数据库同步、显式等待动态导入结束并检查同步调用；不改旧生产实现、不用忽略未处理异常或重跑碰运气掩盖错误。

## 完成记录

- 移除 5 个函数：storeDeleteConnection、graphAssertRevision、apiReadDataQuery、clientTrackSender、apiCreateBridge；原逻辑直接落在 Connection 调用、dispatch、HTTP 路由、IPC 调用登记和 gateway 中。
- 删除 HTTP 中两份资产命令解析分支，使用已存在的 assetsReadCommand；删除 controlReadCommand/controlReadQuery 的转发出口和未使用的 PortableBundle 类型。
- 生产代码净减少 37 行；后端与后端 contracts 从 4,400 → 4,366 行。未新增接口、类、通用 helper 或第三方依赖。
- 保留事务释放、租约、回执、输入校验与 DTO 投影等有独立职责的函数；所有已移除符号在生产与测试代码中均无残留。
- 最终全量测试：43 文件、165 项通过，退出码 0，无未处理错误。旧 registry 专项 2/2 通过。
- vue-tsc --noEmit、Vite renderer/Main/preload 构建、契约文档校验与 git diff --check 通过。

只修改了旧 registry 测试的隔离与等待，没有修改旧后端实现或用户已有未提交文件。没有重新制作安装包或执行安装。
