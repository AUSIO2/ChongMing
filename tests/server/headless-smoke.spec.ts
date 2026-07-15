import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../../electron/api/channels'
import {
  graphDeleteHandlers,
  graphEmit,
  graphOnCompleted,
} from '../../electron/api/graph-events'
import {
  pathsDeleteDataDirOverride,
  pathsReadDataDir,
  pathsUpdateDataDir,
} from '../../electron/shared/paths'
import { cliParseStateIndex } from '../../server/commands'
import { ErrorCode } from '../../electron/shared/errors'

describe('pathsReadDataDir', () => {
  afterEach(() => {
    pathsDeleteDataDirOverride()
    delete process.env.CHONGMING_DATA_DIR
  })

  it('uses override then env', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cm-paths-'))
    try {
      pathsUpdateDataDir(dir)
      expect(pathsReadDataDir()).toBe(dir)
      pathsDeleteDataDirOverride()
      process.env.CHONGMING_DATA_DIR = path.join(dir, 'env')
      expect(pathsReadDataDir()).toBe(path.join(dir, 'env'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('graphEmit', () => {
  afterEach(() => {
    graphDeleteHandlers()
  })

  it('delivers completed to subscribers without a window', () => {
    const seen: unknown[] = []
    const off = graphOnCompleted(p => seen.push(p))
    graphEmit(IPC_CHANNELS.GRAPH_COMPLETED, {
      runId: 'r1',
      mapId: 'm1',
      transitionKey: '1-2',
      parentNodeId: 'n',
      state: {} as never,
    })
    off()
    expect(seen).toHaveLength(1)
    expect((seen[0] as { runId: string }).runId).toBe('r1')
  })
})

describe('cliParseStateIndex', () => {
  it('accepts index and kind aliases', () => {
    expect(cliParseStateIndex('0')).toBe(0)
    expect(cliParseStateIndex('fact')).toBe(2)
    expect(cliParseStateIndex('conclusion')).toBe(3)
  })

  it('rejects invalid', () => {
    try {
      cliParseStateIndex('nope')
      expect.fail('should throw')
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCode.CLI_USAGE)
    }
  })
})
