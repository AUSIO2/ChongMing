/**
 * 共享 LangGraph checkpointer：优先官方 MongoDBSaver（同库），否则 MemorySaver。
 */
import mongoose from 'mongoose'
import { MemorySaver } from '@langchain/langgraph'
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'

let saver: BaseCheckpointSaver | null = null
let setupPromise: Promise<void> | null = null

/** 在 connectDB 之后调用一次。 */
export async function ckptCreate(): Promise<void> {
  if (setupPromise) return setupPromise
  setupPromise = (async () => {
    if (mongoose.connection.readyState === 1) {
      try {
        // mongoose 与 checkpoint-mongodb 可能绑定不同 mongodb 类型版本
        const client = mongoose.connection.getClient() as unknown as ConstructorParameters<
          typeof MongoDBSaver
        >[0]['client']
        const dbName = mongoose.connection.name
        const mongo = new MongoDBSaver({
          client,
          dbName,
          checkpointCollectionName: 'langgraph_checkpoints',
          checkpointWritesCollectionName: 'langgraph_checkpoint_writes',
        })
        await mongo.setup()
        saver = mongo
        console.log(`[checkpointer] MongoDBSaver ready db=${dbName}`)
        return
      } catch (e) {
        console.warn('[checkpointer] MongoDBSaver 初始化失败，回退 MemorySaver', e)
      }
    }
    saver = new MemorySaver()
    console.log('[checkpointer] 使用 MemorySaver')
  })()
  return setupPromise
}

export function ckptRead(): BaseCheckpointSaver {
  if (!saver) {
    saver = new MemorySaver()
  }
  return saver
}

export async function ckptDeleteThread(threadId: string): Promise<void> {
  const cp = ckptRead()
  if (typeof cp.deleteThread === 'function') {
    await cp.deleteThread(threadId)
  }
}
