import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './channels'
import * as mapService from './map-service'
import * as graphService from './graph-service'
import { catalogReadEntries } from './sub-agent-catalog'
import { errUpdateNormalize, errReadSerialize } from '../shared/errors'
import type { ExecutionMode } from '../shared/types'
import type {
  CreateMapInput,
  GraphStatePatch,
  MapGraphPersist,
  MapRunPersist,
  RestoreRunInput,
  StartTransitionInput,
  UpdateMapInput,
} from './types'

type WindowGetter = () => BrowserWindow | null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args)
    } catch (error) {
      throw errReadSerialize(errUpdateNormalize(error))
    }
  })
}

export function handlerRegisterIpc(getWindow: WindowGetter): void {
  handle(
    IPC_CHANNELS.MAP_CREATE,
    (input: CreateMapInput) => mapService.mapCreate(input),
  )

  handle(
    IPC_CHANNELS.MAP_LIST,
    () => mapService.mapReadIndex(),
  )

  handle(
    IPC_CHANNELS.MAP_GET,
    (mapId: string) => mapService.mapRead(mapId),
  )

  handle(
    IPC_CHANNELS.MAP_UPDATE,
    (mapId: string, patch: UpdateMapInput) =>
      mapService.mapUpdate(mapId, patch),
  )

  handle(
    IPC_CHANNELS.MAP_DELETE,
    (mapId: string) => mapService.mapDelete(mapId),
  )

  handle(
    IPC_CHANNELS.MAP_SAVE,
    (
      mapId: string,
      data: {
        mapRun?: MapRunPersist | null
        mapGraph?: MapGraphPersist | null
      },
    ) => mapService.mapUpdatePersistMap(mapId, data),
  )

  handle(
    IPC_CHANNELS.CATALOG_LIST,
    (module: 'split' | 'verify') => catalogReadEntries(module),
  )

  handle(
    IPC_CHANNELS.GRAPH_RUN_TRANSITION,
    (input: StartTransitionInput) => graphService.runTransition(input, getWindow),
  )

  handle(
    IPC_CHANNELS.GRAPH_RESUME,
    (runId: string, modifications: GraphStatePatch) => {
      graphService.runUpdateResume(runId, modifications)
    },
  )

  handle(
    IPC_CHANNELS.GRAPH_SET_MODE,
    async (runId: string, mode: ExecutionMode) => {
      await graphService.runUpdateMode(runId, mode)
    },
  )

  handle(
    IPC_CHANNELS.GRAPH_CANCEL,
    (runId: string) => {
      graphService.runDeleteSession(runId)
    },
  )

  handle(
    IPC_CHANNELS.GRAPH_GET_ACTIVE_RUN,
    (mapId: string) => graphService.runReadSession(mapId),
  )

  handle(
    IPC_CHANNELS.GRAPH_RESTORE,
    (input: RestoreRunInput) => graphService.runRestoreSession(input, getWindow),
  )
}
