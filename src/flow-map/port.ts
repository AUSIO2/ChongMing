import { AppError, ErrorCode } from '../../electron/shared/errors'
import type { MapAPI } from './api'

let installed: MapAPI | null = null

export function installMapAPI(api: MapAPI): void {
  installed = api
}

export function getMapAPI(): MapAPI {
  if (!installed) {
    throw new AppError(
      ErrorCode.MAP_API_NOT_INSTALLED,
      'Map API not installed. Call installMapAPI() at bootstrap.',
    )
  }
  return installed
}

export function isMapAPIInstalled(): boolean {
  return installed !== null
}
