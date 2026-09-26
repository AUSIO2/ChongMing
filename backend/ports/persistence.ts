import type { Readable } from 'node:stream'
import type { GraphStore } from './graph-store'

export interface StorageSession { inTransaction(): boolean }
export type RecordFilter = Record<string, string | number | boolean | null | string[]>
export interface StorageRecords<T extends { _id: string }> {
  get(id: string, session?: StorageSession | null): Promise<T | null>
  first(filter: RecordFilter, session?: StorageSession | null): Promise<T | null>
  count(filter?: RecordFilter, session?: StorageSession | null): Promise<number>
  list(filter?: RecordFilter, session?: StorageSession | null): Promise<T[]>
  insert(document: T, session?: StorageSession | null): Promise<void>
  replace(document: T, session?: StorageSession | null): Promise<void>
  change(id: string, update: (document: T) => T | null, session?: StorageSession | null): Promise<T | null>
  index(fields: string[], options?: { unique?: boolean; sparse?: boolean }): Promise<void>
}
export interface StorageBlobs {
  write(source: AsyncIterable<Uint8Array>, filename: string): Promise<string>
  read(id: string): Readable
  remove(id: string): Promise<boolean>
}
export interface Persistence {
  records<T extends { _id: string }>(name: string): StorageRecords<T>
  transaction<T>(callback: (session: StorageSession) => Promise<T>): Promise<T>
  initialize(): Promise<void>
  now(): Promise<number>
  graph(session?: StorageSession | null): GraphStore
  blobs: StorageBlobs
}

export interface StorageChange { table: string; id: string }
export interface PersistenceEvents { subscribe(listener: (changes: StorageChange[]) => void): () => void }
