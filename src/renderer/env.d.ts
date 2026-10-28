import type { QdoApi } from '../shared/api'

declare global {
  interface Window {
    qdo: QdoApi
  }
}

export {}
