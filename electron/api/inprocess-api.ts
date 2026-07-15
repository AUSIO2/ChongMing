import { AppError, ErrorCode } from '../shared/errors'
import * as mapService from './map-service'
import * as workspaceService from './workspace-service'
import * as catalogService from './catalog-service'
import { catalogReadEntries } from './sub-agent-catalog'
import * as graphService from './graph-service'
import {
  mapLeaseHeartbeat,
  mapLeaseRelease,
  mapLeaseStatus,
  mapLeaseTryAcquire,
} from './map-lease'
import {
  graphOnCompleted,
  graphOnError,
  graphOnInterrupted,
  graphOnProgress,
  graphOnState,
} from './graph-events'
import type { ElectronAPI } from './types'

type WindowGetter = () => null | {
  webContents: { send: (channel: string, payload: unknown) => void }
}

function apiUnsupported(name: string): never {
  throw new AppError(
    ErrorCode.INTERNAL_ERROR,
    `in-process ElectronAPI: ${name} is not available in headless mode`,
  )
}

/** 进程内组装 ElectronAPI，供 adapterBuildIpc / CLI 使用（无 IPC）。 */
export function apiBuildInprocess(
  getWindow: WindowGetter = () => null,
): ElectronAPI {
  return {
    map: {
      create: input => mapService.mapCreate(input),
      list: workspaceId => mapService.mapReadIndex(workspaceId),
      get: mapId => mapService.mapRead(mapId),
      update: (mapId, patch) => mapService.mapUpdate(mapId, patch),
      delete: mapId => mapService.mapDelete(mapId),
      saveMapPersistence: (mapId, data) =>
        mapService.mapUpdatePersistMap(mapId, data),
      readAllClaims: mapId => mapService.mapReadAllClaims(mapId),
      tryAcquireLease: mapId => mapLeaseTryAcquire(mapId),
      heartbeatLease: mapId => mapLeaseHeartbeat(mapId),
      releaseLease: mapId => mapLeaseRelease(mapId),
      leaseStatus: mapId => mapLeaseStatus(mapId),
    },
    workspace: {
      list: () => workspaceService.workspaceList(),
      get: workspaceId => workspaceService.workspaceGet(workspaceId),
      create: input => workspaceService.workspaceCreate(input),
      update: (workspaceId, patch) =>
        workspaceService.workspaceUpdate(workspaceId, patch),
      delete: workspaceId => workspaceService.workspaceDelete(workspaceId),
      uploadLocalAgents: (workspaceId, mode) =>
        workspaceService.workspaceUploadLocalAgents(workspaceId, mode),
    },
    catalog: {
      list: module => Promise.resolve(catalogReadEntries(module)),
      listAll: () => Promise.resolve(catalogService.catalogListAll()),
      get: (module, agentName) =>
        Promise.resolve(catalogService.catalogGet(module, agentName)),
      create: (module, input) =>
        Promise.resolve(catalogService.catalogCreate(module, input)),
      update: (module, agentName, patch) =>
        Promise.resolve(catalogService.catalogUpdate(module, agentName, patch)),
      delete: (module, agentName) => {
        catalogService.catalogDelete(module, agentName)
        return Promise.resolve()
      },
      reload: () => {
        catalogService.catalogReload()
        return Promise.resolve()
      },
    },
    file: {
      exportMap: () => apiUnsupported('file.exportMap'),
      exportWorkspace: () => apiUnsupported('file.exportWorkspace'),
      importWorkspace: () => apiUnsupported('file.importWorkspace'),
    },
    db: {
      getSettings: () => apiUnsupported('db.getSettings'),
      saveSettings: () => apiUnsupported('db.saveSettings'),
      getStatus: () => apiUnsupported('db.getStatus'),
      testConnection: () => apiUnsupported('db.testConnection'),
      reconnect: () => apiUnsupported('db.reconnect'),
      switch: () => apiUnsupported('db.switch'),
    },
    app: {
      getSettings: () => apiUnsupported('app.getSettings'),
      saveSettings: () => apiUnsupported('app.saveSettings'),
      testLlm: () => apiUnsupported('app.testLlm'),
      getVersion: () => Promise.resolve('headless'),
      pingEndpoint: () => apiUnsupported('app.pingEndpoint'),
      setTitle: () => Promise.resolve(),
    },
    skills: {
      list: () => apiUnsupported('skills.list'),
    },
    promptVars: {
      list: () => apiUnsupported('promptVars.list'),
    },
    promptConfig: {
      list: () => apiUnsupported('promptConfig.list'),
      get: () => apiUnsupported('promptConfig.get'),
      update: () => apiUnsupported('promptConfig.update'),
    },
    agentRegistry: {
      list: () => apiUnsupported('agentRegistry.list'),
      get: () => apiUnsupported('agentRegistry.get'),
      create: () => apiUnsupported('agentRegistry.create'),
      update: () => apiUnsupported('agentRegistry.update'),
      delete: () => apiUnsupported('agentRegistry.delete'),
      reload: () => apiUnsupported('agentRegistry.reload'),
      previewOutput: () => apiUnsupported('agentRegistry.previewOutput'),
    },
    graph: {
      runTransition: input =>
        Promise.resolve(graphService.runTransition(input, getWindow)),
      resume: (runId, modifications) => {
        graphService.runUpdateResume(runId, modifications)
        return Promise.resolve()
      },
      setMode: (runId, mode) => graphService.runUpdateMode(runId, mode),
      cancel: runId => {
        graphService.runDeleteSession(runId)
        return Promise.resolve()
      },
      getActiveRun: mapId => Promise.resolve(graphService.runReadSession(mapId)),
      restore: input => graphService.runRestoreSession(input, getWindow),
    },
    events: {
      onInterrupted: cb => graphOnInterrupted(cb),
      onCompleted: cb => graphOnCompleted(cb),
      onError: cb => graphOnError(cb),
      onProgress: cb => graphOnProgress(cb),
      onState: cb => graphOnState(cb),
    },
  }
}
