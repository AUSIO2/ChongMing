import mongoose from 'mongoose'
import { MongoClient } from 'mongodb'

// dynamic import ts via vitest's vite - use compiled approach
// load via spawning vitest on a temp spec instead

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// Use mongodb raw + manual check first
const uri = 'mongodb://localhost:27017/chongming'
const client = new MongoClient(uri)
await client.connect()
const id = '75ea53f9-b06c-42f9-9a0f-27bf0e396697'
const doc = await client.db().collection('maps').findOne({ _id: id })
try {
  structuredClone(doc)
  console.log('raw mongo doc: clone OK')
} catch (e) {
  console.log('raw mongo doc: clone FAIL', e.message)
}

function walk(obj, path = '') {
  if (obj === null || typeof obj !== 'object') return
  const tag = Object.prototype.toString.call(obj)
  if (tag === '[object Date]') console.log('Date at', path)
  if (tag === '[object Map]') console.log('Map at', path)
  if (tag !== '[object Object]' && tag !== '[object Array]' && tag !== '[object Date]') {
    console.log('special at', path, tag)
  }
  if (Array.isArray(obj)) obj.forEach((v, i) => walk(v, `${path}[${i}]`))
  else for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k)
}

walk(doc)
await client.close()
