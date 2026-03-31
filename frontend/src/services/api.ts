import axios, { AxiosError } from 'axios'
import type {
  AttendanceConfigPayload,
  AttendanceDailyRoomSummary,
  AttendanceHistoryEntry,
  AttendanceMockEventPayload,
  AttendanceSessionReport,
  StudentAttendanceSummary,
  StudentSessionCalendarItem,
  StudentSessionDetailResponse,
  BuildingOverview,
  DeviceCreatePayload,
  DeviceTypeItem,
  FloorSummary,
  Incident,
  IncidentReviewPayload,
  LatestFrameResponse,
  DeviceUpdatePayload,
  RoomDeviceInventoryResponse,
  RoomThresholdConfigItem,
  RoomDeviceStatusAll,
  RoomSummary,
  SessionAnalytics,
  SessionSummary,
  DeviceTogglePayload,
  ThresholdConfigItem,
  ThresholdUpdatePayload,
} from '../types'

export const api = axios.create({
  baseURL: '/api',
  timeout: 12000,
})

let requestInterceptorId: number | null = null
let responseInterceptorId: number | null = null

export function setupApiInterceptors(getToken: () => string | null, onUnauthorized: () => void): void {
  if (requestInterceptorId !== null) {
    api.interceptors.request.eject(requestInterceptorId)
  }

  if (responseInterceptorId !== null) {
    api.interceptors.response.eject(responseInterceptorId)
  }

  requestInterceptorId = api.interceptors.request.use((config) => {
    const token = getToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  })

  responseInterceptorId = api.interceptors.response.use(
    (response) => response,
    (error: AxiosError) => {
      if (error.response?.status === 401) {
        onUnauthorized()
      }
      return Promise.reject(error)
    },
  )
}

function normalizeApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    const detail = (error.response?.data as { detail?: string })?.detail
    return detail ?? error.message
  }
  return 'Unknown request error'
}

export async function getBuildingsOverview(): Promise<BuildingOverview[]> {
  try {
    const { data } = await api.get<BuildingOverview[]>('/buildings/overview')
    return data
  } catch {
    const { data } = await api.get<BuildingOverview[]>('/buildings')
    return data.map((building) => ({
      ...building,
      active_sessions_count: 0,
      total_rooms: 0,
      rooms_online_count: 0,
    }))
  }
}

export async function getBuildingFloors(buildingId: string): Promise<FloorSummary[]> {
  const { data } = await api.get<FloorSummary[]>(`/buildings/${buildingId}/floors`)
  return data
}

export async function getFloorRooms(buildingId: string, floorId: string): Promise<RoomSummary[]> {
  const { data } = await api.get<RoomSummary[]>(`/buildings/${buildingId}/floors/${floorId}/rooms`)
  return data
}

export async function getSessions(params?: {
  mode?: 'NORMAL' | 'TESTING'
  status_filter?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
  room_id?: string
}): Promise<SessionSummary[]> {
  try {
    const { data } = await api.get<SessionSummary[]>('/sessions', { params })
    return data
  } catch (error) {
    throw new Error(normalizeApiError(error))
  }
}

export async function getSessionAnalytics(sessionId: string): Promise<SessionAnalytics> {
  const { data } = await api.get<SessionAnalytics>(`/sessions/${sessionId}/analytics`)
  return data
}

export async function getLatestSessionFrame(sessionId: string): Promise<LatestFrameResponse> {
  const { data } = await api.get<LatestFrameResponse>(`/sessions/${sessionId}/latest-frame`)
  return data
}

export async function getIncidents(params?: { room_id?: string; session_id?: string; reviewed?: boolean }): Promise<Incident[]> {
  const { data } = await api.get<Incident[]>('/incidents', { params })
  return data
}

export async function reviewIncident(incidentId: string, payload: IncidentReviewPayload): Promise<void> {
  await api.post(`/incidents/${incidentId}/review`, payload)
}

export async function getRoomDeviceStates(roomId: string): Promise<RoomDeviceStatusAll> {
  const { data } = await api.get<RoomDeviceStatusAll>(`/rooms/${roomId}/devices/status/all`)
  return data
}

export async function getRoomDevices(roomId: string): Promise<RoomDeviceInventoryResponse> {
  const { data } = await api.get<RoomDeviceInventoryResponse>(`/rooms/${roomId}/devices`)
  return data
}

export async function addRoomDevice(roomId: string, payload: DeviceCreatePayload): Promise<void> {
  await api.post(`/rooms/${roomId}/devices`, payload)
}

export async function updateRoomDevice(roomId: string, deviceId: string, payload: DeviceUpdatePayload): Promise<void> {
  await api.put(`/rooms/${roomId}/devices/${deviceId}`, payload)
}

export async function removeRoomDevice(roomId: string, deviceId: string): Promise<void> {
  await api.delete(`/rooms/${roomId}/devices/${deviceId}`)
}

export async function toggleDevice(roomId: string, deviceId: string, payload: DeviceTogglePayload): Promise<void> {
  await api.post(`/devices/${deviceId}/toggle`, payload, {
    params: { room_id: roomId },
  })
}

export async function changeSessionMode(sessionId: string, mode: 'NORMAL' | 'TESTING'): Promise<void> {
  await api.put(`/sessions/${sessionId}/mode`, { mode })
}

export async function endSession(sessionId: string): Promise<void> {
  await api.post(`/sessions/${sessionId}/end`, {})
}

export async function getDeviceTypes(): Promise<DeviceTypeItem[]> {
  const { data } = await api.get<DeviceTypeItem[]>('/device-types')
  return data
}

export async function getGlobalThresholds(): Promise<ThresholdConfigItem[]> {
  const { data } = await api.get<ThresholdConfigItem[]>('/thresholds/global')
  return data
}

export async function updateGlobalThreshold(deviceTypeCode: string, payload: ThresholdUpdatePayload): Promise<void> {
  await api.put(`/thresholds/global/${deviceTypeCode}`, payload)
}

export async function getRoomThresholds(roomId: string): Promise<RoomThresholdConfigItem[]> {
  const { data } = await api.get<RoomThresholdConfigItem[]>(`/rooms/${roomId}/thresholds`)
  return data
}

export async function updateRoomThreshold(
  roomId: string,
  deviceTypeCode: string,
  payload: ThresholdUpdatePayload,
): Promise<void> {
  await api.put(`/rooms/${roomId}/thresholds/${deviceTypeCode}`, payload)
}

export async function getSessionAttendanceReport(sessionId: string): Promise<AttendanceSessionReport> {
  const { data } = await api.get<AttendanceSessionReport>(`/attendance/sessions/${sessionId}`)
  return data
}

export async function updateAttendanceConfig(sessionId: string, payload: AttendanceConfigPayload): Promise<AttendanceConfigPayload> {
  const { data } = await api.put<AttendanceConfigPayload>(`/attendance/sessions/${sessionId}/config`, payload)
  return data
}

export async function ingestMockAttendanceEvent(sessionId: string, payload: AttendanceMockEventPayload): Promise<void> {
  await api.post(`/attendance/sessions/${sessionId}/events/mock`, payload)
}

export async function exportSessionAttendanceCsv(sessionId: string): Promise<Blob> {
  const { data } = await api.get<Blob>(`/attendance/sessions/${sessionId}/export`, { responseType: 'blob' })
  return data
}

export async function getStudentAttendanceHistory(studentId: string, limit = 30): Promise<AttendanceHistoryEntry[]> {
  const { data } = await api.get<AttendanceHistoryEntry[]>(`/attendance/students/${studentId}/history`, { params: { limit } })
  return data
}

export async function getRoomDailyAttendanceSummary(roomId: string, day?: string): Promise<AttendanceDailyRoomSummary> {
  const params = day ? { day } : undefined
  const { data } = await api.get<AttendanceDailyRoomSummary>(`/attendance/rooms/${roomId}/daily-summary`, { params })
  return data
}

export async function getStudentWeeklySessions(weekStart?: string): Promise<StudentSessionCalendarItem[]> {
  const params = weekStart ? { week_start: weekStart } : undefined
  const { data } = await api.get<StudentSessionCalendarItem[]>('/students/me/sessions', { params })
  return data
}

export async function getStudentSessionDetail(sessionId: string): Promise<StudentSessionDetailResponse> {
  const { data } = await api.get<StudentSessionDetailResponse>(`/students/me/sessions/${sessionId}`)
  return data
}

export async function getStudentAttendanceSummary(days = 30): Promise<StudentAttendanceSummary> {
  const { data } = await api.get<StudentAttendanceSummary>('/students/me/attendance/summary', { params: { days } })
  return data
}
