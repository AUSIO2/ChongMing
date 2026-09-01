import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './channels'
import * as workspaceService from './workspace-service'
import * as fileService from './file-service'
import * as dbService from './db-service'
import * as catalogService from './catalog-service'
import * as appService from './app-service'
import * as promptConfigService from './prompt-config-service'
import * as registryService from './agent-registry-service'
import { skillList } from '../skills/registry'
import { catalogReadEntries } from './sub-agent-catalog'
import { mapperService } from '../mapper'
import { errUpdateNormalize, errReadSerialize } from '../shared/errors'
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  UploadLocalAgentsMode,
} from './types'
import type { CatalogWriteInput } from './catalog-service'
import type { MapperCommand, MapperQuery } from '../mapper/types'

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
    IPC_CHANNELS.MAPPER_READ,
    (query: MapperQuery) => mapperService.read(query),
  )

  handle(
    IPC_CHANNELS.MAPPER_DISPATCH,
    (command: MapperCommand) => mapperService.dispatch(command),
  )

  mapperService.watch(event => {
    getWindow()?.webContents.send(IPC_CHANNELS.MAPPER_UPDATED, event)
  })

  handle(IPC_CHANNELS.WORKSPACE_LIST, () => workspaceService.workspaceList())

  handle(
    IPC_CHANNELS.WORKSPACE_GET,
    (workspaceId: string) => workspaceService.workspaceGet(workspaceId),
  )

  handle(
    IPC_CHANNELS.WORKSPACE_CREATE,
    (input: CreateWorkspaceInput) => workspaceService.workspaceCreate(input),
  )

  handle(
    IPC_CHANNELS.WORKSPACE_UPDATE,
    (workspaceId: string, patch: UpdateWorkspaceInput) =>
      workspaceService.workspaceUpdate(workspaceId, patch),
  )

  handle(
    IPC_CHANNELS.WORKSPACE_DELETE,
    (workspaceId: string) => workspaceService.workspaceDelete(workspaceId),
  )

  handle(
    IPC_CHANNELS.WORKSPACE_UPLOAD_LOCAL_AGENTS,
    (workspaceId: string, mode?: UploadLocalAgentsMode) =>
      workspaceService.workspaceUploadLocalAgents(workspaceId, mode),
  )

  handle(
    IPC_CHANNELS.CATALOG_LIST,
    (module: 'split' | 'verify') => catalogReadEntries(module),
  )

  handle(IPC_CHANNELS.CATALOG_LIST_ALL, () => catalogService.catalogListAll())

  handle(
    IPC_CHANNELS.CATALOG_GET,
    (module: 'split' | 'verify', agentName: string) =>
      catalogService.catalogGet(module, agentName),
  )

  handle(
    IPC_CHANNELS.CATALOG_CREATE,
    (module: 'split' | 'verify', input: CatalogWriteInput) =>
      catalogService.catalogCreate(module, input),
  )

  handle(
    IPC_CHANNELS.CATALOG_UPDATE,
    (module: 'split' | 'verify', agentName: string, patch: Partial<CatalogWriteInput>) =>
      catalogService.catalogUpdate(module, agentName, patch),
  )

  handle(
    IPC_CHANNELS.CATALOG_DELETE,
    (module: 'split' | 'verify', agentName: string) =>
      catalogService.catalogDelete(module, agentName),
  )

  handle(IPC_CHANNELS.CATALOG_RELOAD, () => {
    catalogService.catalogReload()
  })

  handle(
    IPC_CHANNELS.FILE_EXPORT_MAP,
    (mapId: string) => fileService.fileExportMap(getWindow, mapId),
  )

  handle(
    IPC_CHANNELS.FILE_EXPORT_WORKSPACE,
    (workspaceId: string) => fileService.fileExportWorkspace(getWindow, workspaceId),
  )

  handle(
    IPC_CHANNELS.FILE_IMPORT_WORKSPACE,
    () => fileService.fileImportWorkspace(getWindow),
  )

  handle(IPC_CHANNELS.DB_GET_SETTINGS, () => dbService.dbGetSettings())

  handle(
    IPC_CHANNELS.DB_SAVE_SETTINGS,
    (uri: string) => dbService.dbSaveSettings(uri),
  )

  handle(IPC_CHANNELS.DB_GET_STATUS, () => dbService.dbGetStatus())

  handle(
    IPC_CHANNELS.DB_TEST_CONNECTION,
    (uri: string) => dbService.dbTestConnection(uri),
  )

  handle(IPC_CHANNELS.DB_RECONNECT, () => dbService.dbReconnect())

  handle(
    IPC_CHANNELS.DB_SWITCH,
    (uri: string) => dbService.dbSwitch(uri),
  )

  handle(IPC_CHANNELS.APP_GET_SETTINGS, () => appService.appGetSettings())

  handle(
    IPC_CHANNELS.APP_SAVE_SETTINGS,
    (input: Parameters<typeof appService.appSaveSettings>[0]) =>
      appService.appSaveSettings(input),
  )

  handle(IPC_CHANNELS.APP_TEST_LLM, () => appService.appTestLlm())

  handle(IPC_CHANNELS.APP_GET_VERSION, () => appService.appGetVersion())

  handle(IPC_CHANNELS.APP_PING_ENDPOINT, () => appService.appPingEndpoint())

  handle(IPC_CHANNELS.APP_SET_TITLE, (title: string) => {
    getWindow()?.setTitle(title)
  })

  handle(IPC_CHANNELS.SKILLS_LIST, () => skillList())

  handle(
    IPC_CHANNELS.PROMPT_VARS_LIST,
    (kind: Parameters<typeof promptConfigService.promptVarsList>[0]) =>
      promptConfigService.promptVarsList(kind),
  )

  handle(IPC_CHANNELS.PROMPT_CONFIG_LIST, () => promptConfigService.promptConfigList())

  handle(
    IPC_CHANNELS.PROMPT_CONFIG_GET,
    (promptPath: string) => promptConfigService.promptConfigGet(promptPath),
  )

  handle(
    IPC_CHANNELS.PROMPT_CONFIG_UPDATE,
    (promptPath: string, patch: Parameters<typeof promptConfigService.promptConfigUpdate>[1]) =>
      promptConfigService.promptConfigUpdate(promptPath, patch),
  )

  handle(IPC_CHANNELS.AGENT_REGISTRY_LIST, () => registryService.registryList())

  handle(
    IPC_CHANNELS.AGENT_REGISTRY_GET,
    (promptPath: string) => registryService.registryGet(promptPath),
  )

  handle(
    IPC_CHANNELS.AGENT_REGISTRY_CREATE,
    (input: Parameters<typeof registryService.registryCreate>[0]) =>
      registryService.registryCreate(input),
  )

  handle(
    IPC_CHANNELS.AGENT_REGISTRY_UPDATE,
    (promptPath: string, patch: Parameters<typeof registryService.registryUpdate>[1]) =>
      registryService.registryUpdate(promptPath, patch),
  )

  handle(
    IPC_CHANNELS.AGENT_REGISTRY_DELETE,
    (promptPath: string) => registryService.registryDelete(promptPath),
  )

  handle(IPC_CHANNELS.AGENT_REGISTRY_RELOAD, () => registryService.registryReload())

  handle(
    IPC_CHANNELS.AGENT_REGISTRY_PREVIEW_OUTPUT,
    (kind: Parameters<typeof registryService.registryPreviewOutput>[0], params?: Parameters<typeof registryService.registryPreviewOutput>[1]) =>
      registryService.registryPreviewOutput(kind, params),
  )

}
