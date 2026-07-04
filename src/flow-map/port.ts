import type { MapAPI } from './api'

let installed: MapAPI | null = null

export function installMapAPI(api: MapAPI): void {
  installed = api
}

export function getMapAPI(): MapAPI {
  if (!installed) {
    throw new Error('Map API not installed. Call installMapAPI() at bootstrap.')
  }
  return installed
}

export function isMapAPIInstalled(): boolean {
  return installed !== null
}

/** 仅测试用：重置全局单例，避免不同用例互相污染。 */
export function __resetMapAPIForTests(): void {
  installed = null
}
