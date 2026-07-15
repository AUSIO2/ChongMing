import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { AppEndpointPingDto } from '../../electron/api/types'

const DB_POLL_MS = 15_000
const ENDPOINT_POLL_MS = 60_000
const SLOW_LATENCY_MS = 800

export type EndpointHealth = 'unknown' | 'checking' | 'ok' | 'slow' | 'error'

export interface DbHealthView {
  connected: boolean
  label: string
  title: string
}

function dbFormatLabel(uri: string, connected: boolean, databaseName?: string): DbHealthView {
  if (uri === 'memory') {
    return {
      connected: true,
      label: 'memory',
      title: '内存数据库',
    }
  }
  if (connected) {
    const name = databaseName ?? uri
    return {
      connected: true,
      label: databaseName ? `已连接 · ${databaseName}` : '已连接',
      title: `MongoDB · ${name}`,
    }
  }
  return {
    connected: false,
    label: '未连接',
    title: `MongoDB · ${uri}`,
  }
}

function endpointReadHealth(ping: AppEndpointPingDto | null, checking: boolean): EndpointHealth {
  if (checking) return 'checking'
  if (!ping) return 'unknown'
  if (!ping.ok) return 'error'
  if (ping.latencyMs > SLOW_LATENCY_MS) return 'slow'
  return 'ok'
}

export function useStatusBarHealth() {
  const version = ref('')
  const dbHealth = ref<DbHealthView>({
    connected: false,
    label: '…',
    title: '数据库',
  })
  const endpointPing = ref<AppEndpointPingDto | null>(null)
  const endpointChecking = ref(false)

  const endpointHealth = ref<EndpointHealth>('unknown')

  let dbTimer: ReturnType<typeof setInterval> | null = null
  let endpointTimer: ReturnType<typeof setInterval> | null = null

  async function refreshDb() {
    const status = await window.electronAPI.db.getStatus()
    dbHealth.value = dbFormatLabel(status.uri, status.connected, status.databaseName)
  }

  async function refreshEndpoint() {
    endpointChecking.value = true
    endpointHealth.value = 'checking'
    endpointPing.value = null
    try {
      const ping = await window.electronAPI.app.pingEndpoint()
      endpointPing.value = ping
      endpointHealth.value = endpointReadHealth(ping, false)
    } finally {
      endpointChecking.value = false
    }
  }

  async function refreshVersion() {
    version.value = await window.electronAPI.app.getVersion()
  }

  onMounted(() => {
    void refreshVersion()
    void refreshDb()
    void refreshEndpoint()
    dbTimer = setInterval(() => void refreshDb(), DB_POLL_MS)
    endpointTimer = setInterval(() => void refreshEndpoint(), ENDPOINT_POLL_MS)
  })

  onBeforeUnmount(() => {
    if (dbTimer) clearInterval(dbTimer)
    if (endpointTimer) clearInterval(endpointTimer)
  })

  return {
    version,
    dbHealth,
    endpointPing,
    endpointHealth,
    endpointChecking,
    refreshEndpoint,
  }
}
