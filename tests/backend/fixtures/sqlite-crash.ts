// 崩溃恢复测试子进程：保留一个已提交记录，并挂起另一个未提交事务等待被终止。
import { sqliteCreatePersistence } from '../../../backend/adapters/storage/sqlite/persistence'

async function sqliteRunCrashFixture() {
  // 先保存已提交记录，再挂起包含另一条记录的事务，供父测试强杀后检查恢复结果。
  const database = sqliteCreatePersistence(process.argv[2])
  const records = database.records<{ _id: string; value: string }>('crash_test')
  await records.insert({ _id: 'committed', value: 'retained' })
  await database.transaction(async /* 保持未提交写入活动、等待父进程强杀的 SQLite 事务会话。 */ session => {
    // 写入尚未提交的数据并发出就绪标记，使父测试能精确在事务中断时终止进程。
    await records.insert({ _id: 'pending', value: 'must roll back' }, session)
    setInterval(() => {
      // 仅维持子进程事件循环，保证未提交事务等待期间进程不会自行退出。
      }, 1000)
    process.stdout.write('transaction-open\n')
    await new Promise(() => {
      // 故意永不结束事务回调，让父进程控制崩溃发生的时机。
      })
  })
}
sqliteRunCrashFixture().catch(/* 夹具自身启动或持久化失败的原始原因。 */ error => {
  // 将夹具启动错误写到标准错误并设置失败退出码，避免误判为预期崩溃。
  console.error(error); process.exitCode = 1 })
