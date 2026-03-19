export type SessionMode = 'NORMAL' | 'TESTING'
export type SessionStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED'

export interface BuildingOverview {
  id: string
  name: string
  code: string | null
  location: string | null
  active_sessions_count: number
  total_rooms: number
  rooms_online_count: number
}

export interface FloorSummary {
  id: string
  building_id: string
  floor_number: number
  name: string | null
  created_at: string
}

export interface RoomSummary {
  id: string
  floor_id: string
  room_code: string
  name: string | null
  capacity: number
  devices: Record<string, unknown>
  created_at: string
}

export interface SessionSummary {
  id: string
  room_id: string
  room_code: string | null
  teacher_id: string
  subject_id: string
  mode: SessionMode
  status: SessionStatus
  start_time: string
  end_time: string | null
  students_present: string[]
  risk_alerts_count: number
}

export interface SessionAnalytics {
  session_id: string
  mode: SessionMode
  status: SessionStatus
  start_time: string
  elapsed_minutes: number
  student_performance: Record<string, Record<string, number>>
  teacher_performance: Record<string, number>
  risk_alerts_count: number
}

export interface LatestFrameResponse {
  source: 'live' | 'incident' | 'none'
  image_base64: string | null
  captured_at: string | null
}

export interface Incident {
  id: string
  session_id: string
  student_id: string
  risk_score: number
  risk_level: string
  triggered_behaviors: Record<string, number>
  flagged_at: string
  reviewed: boolean
  reviewer_notes?: string | null
}

export interface RoomDeviceState {
  device_id: string
  device_type: string
  status: string
  manual_override: boolean
  override_until?: string | null
  last_updated: string
}

export interface RoomDeviceStatusAll {
  room_id: string
  device_states: RoomDeviceState[]
}

export interface RoomDeviceInventoryItem {
  device_id: string
  device_type: string
  location_front_back: 'FRONT' | 'BACK'
  location_left_right: 'LEFT' | 'RIGHT'
  location: string
  status?: string
  mqtt_topic?: string
  power_consumption_watts?: number
}

export interface RoomDeviceInventoryResponse {
  room_id: string
  room_code: string
  device_count: number
  devices: RoomDeviceInventoryItem[]
}

export interface DeviceCreatePayload {
  device_type: string
  location_front_back: 'FRONT' | 'BACK'
  location_left_right: 'LEFT' | 'RIGHT'
  power_consumption_watts?: number
}

export interface DeviceUpdatePayload {
  location_front_back?: 'FRONT' | 'BACK'
  location_left_right?: 'LEFT' | 'RIGHT'
  power_consumption_watts?: number
}

export interface IncidentReviewPayload {
  reviewer_notes: string
}

export interface DeviceTogglePayload {
  action: 'ON' | 'OFF'
  duration_minutes?: number
}
