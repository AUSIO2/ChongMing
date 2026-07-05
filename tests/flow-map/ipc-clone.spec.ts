import { describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { dbCreate, MapModel } from '../../electron/shared/database'
import { serialReadMap } from '../../electron/api/serialize'

const MAP_ID = '75ea53f9-b06c-42f9-9a0f-27bf0e396697'

describe('ipc clone', () => {
  it('serialReadMap output is structured-cloneable', async () => {
    await dbCreate(process.env.MONGO_URI ?? 'mongodb://localhost:27017/chongming')
    const doc = await MapModel.findById(MAP_ID)
    expect(doc).toBeTruthy()

    const lean = await MapModel.findById(MAP_ID).lean()
    const displayLean = serialReadMap(lean!)
    expect(() => structuredClone(displayLean)).not.toThrow()

    const display = serialReadMap(doc!)
    expect(() => structuredClone(display)).not.toThrow()

    await mongoose.disconnect()
  })
})
