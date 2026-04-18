type AttendanceImportMeta = ImportMeta & {
  env?: {
    VITE_ATTENDANCE_STREAM_BASE_URL?: string
  }
}

const DEFAULT_ATTENDANCE_STREAM_BASE_URL = '/api/attendance/stream'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export function getAttendanceStreamBaseUrl(overrideBaseUrl?: string): string {
  const explicitBaseUrl = (overrideBaseUrl ?? '').trim()
  if (explicitBaseUrl) {
    return normalizeBaseUrl(explicitBaseUrl)
  }

  const envBaseUrl = ((import.meta as AttendanceImportMeta).env?.VITE_ATTENDANCE_STREAM_BASE_URL ?? '').trim()
  if (envBaseUrl) {
    return normalizeBaseUrl(envBaseUrl)
  }

  return DEFAULT_ATTENDANCE_STREAM_BASE_URL
}

export function buildAttendanceStreamUrl(path: string, overrideBaseUrl?: string): string {
  const baseUrl = getAttendanceStreamBaseUrl(overrideBaseUrl)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}
