import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './channels'
import * as newsService from './news-service'
import * as graphService from './graph-service'
import { listCatalogEntries } from './sub-agent-catalog'
import { normalizeError, serializeAppError } from '../shared/errors'
import type { ExecutionMode } from '../shared/types'
import type {
  CreateNewsInput,
  GraphStatePatch,
  MapGraphPersist,
  MapRunPersist,
  RestoreRunInput,
  StartSplitInput,
  StartVerifyInput,
  UpdateNewsInput,
} from './types'

type WindowGetter = () => BrowserWindow | null

/** IPC 全局异常捕获：业务抛 AppError，未知错误规范化后序列化给渲染进程。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args)
    } catch (error) {
      throw serializeAppError(normalizeError(error))
    }
  })
}

export function registerIpcHandlers(getWindow: WindowGetter): void {
  handle(
    IPC_CHANNELS.NEWS_CREATE,
    (input: CreateNewsInput) => newsService.createNews(input),
  )

  handle(
    IPC_CHANNELS.NEWS_LIST,
    () => newsService.listNews(),
  )

  handle(
    IPC_CHANNELS.NEWS_GET,
    (newsId: string) => newsService.getNews(newsId),
  )

  handle(
    IPC_CHANNELS.NEWS_UPDATE,
    (newsId: string, patch: UpdateNewsInput) =>
      newsService.updateNews(newsId, patch),
  )

  handle(
    IPC_CHANNELS.NEWS_SAVE_MAP,
    (
      newsId: string,
      data: {
        mapRun?: MapRunPersist | null
        mapGraph?: MapGraphPersist | null
      },
    ) => newsService.saveMapPersistence(newsId, data),
  )

  handle(
    IPC_CHANNELS.CATALOG_LIST,
    (module: 'split' | 'verify') => listCatalogEntries(module),
  )

  handle(
    IPC_CHANNELS.GRAPH_START_SPLIT,
    (input: StartSplitInput) => graphService.startSplit(input, getWindow),
  )

  handle(
    IPC_CHANNELS.GRAPH_START_VERIFY,
    (input: StartVerifyInput) => graphService.startVerify(input, getWindow),
  )

  handle(
    IPC_CHANNELS.GRAPH_RESUME,
    (runId: string, modifications: GraphStatePatch) => {
      graphService.resumeGraph(runId, modifications)
    },
  )

  handle(
    IPC_CHANNELS.GRAPH_SET_MODE,
    async (runId: string, mode: ExecutionMode) => {
      await graphService.setGraphMode(runId, mode)
    },
  )

  handle(
    IPC_CHANNELS.GRAPH_CANCEL,
    (runId: string) => {
      graphService.cancelGraph(runId)
    },
  )

  handle(
    IPC_CHANNELS.GRAPH_GET_ACTIVE_RUN,
    (newsId: string) => graphService.getActiveRun(newsId),
  )

  handle(
    IPC_CHANNELS.GRAPH_RESTORE,
    (input: RestoreRunInput) => graphService.restoreRun(input, getWindow),
  )
}
