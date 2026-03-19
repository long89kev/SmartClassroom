import axios, { AxiosError } from 'axios'
import type {
  BuildingOverview,
  DeviceCreatePayload,
  FloorSummary,
  Incident,
  IncidentReviewPayload,
  LatestFrameResponse,
  DeviceUpdatePayload,
  RoomDeviceInventoryResponse,
  RoomDeviceStatusAll,
  RoomSummary,
  SessionAnalytics,
  SessionSummary,
  DeviceTogglePayload,
} from '../types'

const api = axios.create({
  baseURL: '/api',
  timeout: 12000,
})

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
