import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientSetIdForTest } from '../../electron/shared/client-identity'
import {
  dbCreate,
  dbDelete,
  MapModel,
  WorkspaceModel,
} from '../../electron/shared/database'
import { ErrorCode } from '../../electron/shared/errors'
import {
  mapDocumentCommit,
  mapDocumentCreate,
  mapDocumentDelete,
  mapDocumentList,
  mapDocumentRead,
} from '../../electron/mapper/document'

const WORKSPACE_ID = 'mapper-document-workspace'

describe('Mapper document CRUD', () => {
  beforeAll(async () => {
    clientSetIdForTest('mapper-document-client')
    await dbCreate('memory')
    await WorkspaceModel.create({ _id: WORKSPACE_ID, name: 'Mapper' })
  })

  afterAll(async () => {
    await MapModel.deleteMany({ workspaceId: WORKSPACE_ID })
    await WorkspaceModel.deleteOne({ _id: WORKSPACE_ID })
    clientSetIdForTest(null)
    await dbDelete()
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  })

  it('creates, reads, lists, commits and deletes a canonical document', async () => {
    const created = await mapDocumentCreate({
      workspaceId: WORKSPACE_ID,
      name: 'First',
    })
    expect(created).toMatchObject({ name: 'First', revision: 0 })
    expect(await mapDocumentList(WORKSPACE_ID)).toEqual([
      expect.objectContaining({ id: created.id, newsCount: 0, claimCount: 0 }),
    ])

    created.news.push({ id: 'news:default', content: 'hello', context: {} })
    const updated = await mapDocumentCommit(created, 0)
    expect(updated.revision).toBe(1)
    expect((await mapDocumentRead(created.id))?.news[0]?.content).toBe('hello')

    await expect(mapDocumentCommit(created, 0)).rejects.toMatchObject({
      code: ErrorCode.MAP_REVISION_CONFLICT,
    })

    await mapDocumentDelete(created.id)
    expect(await mapDocumentRead(created.id)).toBeNull()
  })
})
