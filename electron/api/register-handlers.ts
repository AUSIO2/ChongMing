import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './channels'
import * as newsService from './news-service'
import * as graphService from './graph-service'
import { listCatalogEntries } from './sub-agent-catalog'
import type { ExecutionMode } from '../shared/types'
import type {
  CreateNewsInput,
  GraphStatePatch,
  StartSplitInput,
  StartVerifyInput,
  UpdateNewsInput,
} from './types'

type WindowGetter = () => BrowserWindow | null

export function registerIpcHandlers(getWindow: WindowGetter): void {
  ipcMain.handle(
    IPC_CHANNELS.NEWS_CREATE,
    (_event, input: CreateNewsInput) => newsService.createNews(input),
  )

  ipcMain.handle(
    IPC_CHANNELS.NEWS_LIST,
    () => newsService.listNews(),
  )

  ipcMain.handle(
    IPC_CHANNELS.NEWS_GET,
    (_event, newsId: string) => newsService.getNews(newsId),
  )

  ipcMain.handle(
    IPC_CHANNELS.NEWS_UPDATE,
    (_event, newsId: string, patch: UpdateNewsInput) =>
      newsService.updateNews(newsId, patch),
  )

  ipcMain.handle(
    IPC_CHANNELS.CATALOG_LIST,
    (_event, module: 'split' | 'verify') => listCatalogEntries(module),
  )

  ipcMain.handle(
    IPC_CHANNELS.GRAPH_START_SPLIT,
    (_event, input: StartSplitInput) =>
      graphService.startSplit(input, getWindow),
  )

  ipcMain.handle(
    IPC_CHANNELS.GRAPH_START_VERIFY,
    (_event, input: StartVerifyInput) =>
      graphService.startVerify(input, getWindow),
  )

  ipcMain.handle(
    IPC_CHANNELS.GRAPH_RESUME,
    (_event, runId: string, modifications: GraphStatePatch) => {
      graphService.resumeGraph(runId, modifications)
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.GRAPH_SET_MODE,
    async (_event, runId: string, mode: ExecutionMode) => {
      await graphService.setGraphMode(runId, mode)
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.GRAPH_CANCEL,
    (_event, runId: string) => {
      graphService.cancelGraph(runId)
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.GRAPH_GET_ACTIVE_RUN,
    (_event, newsId: string) => graphService.getActiveRun(newsId),
  )
}
