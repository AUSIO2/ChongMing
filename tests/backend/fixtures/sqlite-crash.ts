import { sqliteCreatePersistence } from '../../../backend/adapters/storage/sqlite/persistence'

async function sqliteRunCrashFixture() {
  const database = sqliteCreatePersistence(process.argv[2])
  const records = database.records<{ _id: string; value: string }>('crash_test')
  await records.insert({ _id: 'committed', value: 'retained' })
  await database.transaction(async session => {
    await records.insert({ _id: 'pending', value: 'must roll back' }, session)
    setInterval(() => {}, 1000)
    process.stdout.write('transaction-open\n')
    await new Promise(() => {})
  })
}
sqliteRunCrashFixture().catch(error => { console.error(error); process.exitCode = 1 })
