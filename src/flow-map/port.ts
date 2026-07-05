import { AppError, ErrorCode } from '../../electron/shared/errors'
import type { MapAPI } from './api'

let installed: MapAPI | null = null

export function portRegisterApi(api: MapAPI): void {
  installed = api
}

export function portReadApi(): MapAPI {
  if (!installed) {
    throw new AppError(
      ErrorCode.MAP_API_NOT_INSTALLED,
      'Map API not installed. Call portRegisterApi() at bootstrap.',
    )
  }
  return installed
}

export function portIsInstalled(): boolean {
  return installed !== null
}
