export type SessionMode = 'NORMAL' | 'TESTING'
export type SessionStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED'

export interface AuthLoginRequest {
  username: string
  password: string
}

export interface AuthUser {
  id: string
  username: string
  email: string | null
  role: string
  is_active: boolean
  created_at: string
}

export interface AuthTokenResponse {
  access_token: string
  token_type: string
  user: AuthUser
}

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
  teacher_name?: string | null
  subject_id: string
  subject_name?: string | null
  mode: SessionMode
  status: SessionStatus
  start_time: string
  end_time: string | null
  students_present: string[]
  risk_alerts_count: number
}

export interface TutorRoomContext {
  building_id: string | null
  floor_id: string | null
  room_id: string | null
  room_code: string | null
  active_sessions: SessionSummary[]
  selected_session_id: string | null
  selection_reason:
    | 'no_assigned_room'
    | 'first_assigned_room'
    | 'timetable_room'
    | 'teacher_owned_active'
    | 'room_recent_active'
}

export interface CurrentSessionTarget {
  session_id: string | null
  room_id: string | null
  room_code: string | null
  building_id: string | null
  mode: SessionMode | null
  fallback_reason:
    | 'timetable'
    | 'auto_created_from_timetable'
    | 'recent_active'
    | 'first_active'
    | 'none'
  start_time: string | null
}

export type RefreshIntervalMode = 'NORMAL' | 'TESTING'

export interface RefreshIntervalEffective {
  mode: RefreshIntervalMode
  interval_ms: number
  source_scope: 'ROOM' | 'BUILDING' | 'GROUP' | 'FALLBACK'
  source_scope_id: string | null
  building_id: string
  room_id: string | null
  min_interval_ms: number
  max_interval_ms: number
}

export interface RefreshIntervalGroupRow {
  group_code: 'A' | 'B' | 'C' | 'LABS'
  normal_interval_ms: number
  testing_interval_ms: number
}

export interface RefreshIntervalGroupListResponse {
  groups: RefreshIntervalGroupRow[]
  min_interval_ms: number
  max_interval_ms: number
}

export interface RefreshIntervalScopeValue {
  mode: RefreshIntervalMode
  interval_ms: number
  is_override: boolean
  source_scope: 'ROOM' | 'BUILDING' | 'GROUP' | 'FALLBACK'
  source_scope_id: string | null
}

export interface BuildingRefreshIntervalConfig {
  building_id: string
  building_name: string
  building_code: string | null
  group_code: string | null
  values: RefreshIntervalScopeValue[]
  min_interval_ms: number
  max_interval_ms: number
}

export interface RoomRefreshIntervalConfig {
  room_id: string
  room_code: string
  building_id: string
  building_code: string | null
  values: RefreshIntervalScopeValue[]
  min_interval_ms: number
  max_interval_ms: number
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

export interface RoomSensorReadingItem {
  sensor_key: string
  value: number
  unit: string | null
  source_topic: string | null
  captured_at: string
}

export interface RoomSensorReadingsResponse {
  room_id: string
  room_code: string | null
  readings: RoomSensorReadingItem[]
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

export interface DeviceTypeItem {
  code: string
  display_name: string
  unit?: string | null
  default_min?: number | null
  default_max?: number | null
  default_target?: number | null
  is_active: boolean
}

export interface ThresholdConfigItem {
  device_type_code: string
  min_value?: number | null
  max_value?: number | null
  target_value?: number | null
  enabled: boolean
}

export interface RoomThresholdConfigItem extends ThresholdConfigItem {
  room_id: string
  is_override: boolean
}

export interface ThresholdUpdatePayload {
  min_value?: number | null
  max_value?: number | null
  target_value?: number | null
  enabled?: boolean
}

export interface AttendanceConfigPayload {
  grace_minutes: number
  min_confidence: number
  auto_checkin_enabled: boolean
}

export interface AttendanceMockEventPayload {
  student_id: string
  face_confidence?: number
  occurred_at?: string
  source?: string
  metadata?: Record<string, unknown>
}

export interface AttendanceStudentStatus {
  student_id: string
  student_code: string
  student_name: string
  status: 'PRESENT' | 'LATE' | 'ABSENT'
  first_seen_at: string | null
  confidence: number | null
}

export interface AttendanceSessionReport {
  session_id: string
  room_id: string
  room_code: string | null
  start_time: string
  end_time: string | null
  grace_minutes: number
  min_confidence: number
  totals: {
    present: number
    late: number
    absent: number
    enrolled: number
  }
  students: AttendanceStudentStatus[]
}

export interface AttendanceHistoryEntry {
  session_id: string
  subject_id: string | null
  room_id: string
  start_time: string
  end_time: string | null
  status: 'PRESENT' | 'LATE' | 'ABSENT'
  first_seen_at: string | null
}

export interface AttendanceDailyRoomSummary {
  room_id: string
  date: string
  sessions_count: number
  totals: {
    present: number
    late: number
    absent: number
    enrolled: number
  }
}

export type AttendanceDashboardDimension = 'session' | 'day_of_week' | 'subject'
export type AttendanceDashboardTrendGranularity = 'day' | 'week' | 'month' | 'weekday'
export type AttendanceDashboardRankingScope = 'session' | 'room' | 'subject'

export interface AttendanceDashboardKpis {
  enrolled: number
  present: number
  late: number
  absent: number
  attendance_rate: number
}

export interface AttendanceDashboardPoint {
  key: string
  label: string
  enrolled: number
  present: number
  late: number
  absent: number
  attendance_rate: number
}

export interface AttendanceDashboardBreakdownResponse {
  dimension: AttendanceDashboardDimension
  points: AttendanceDashboardPoint[]
}

export interface AttendanceDashboardTrendResponse {
  granularity: AttendanceDashboardTrendGranularity
  points: AttendanceDashboardPoint[]
}

export interface AttendanceDashboardRankingRow {
  rank: number
  scope_key: string
  scope_label: string
  start_time: string | null
  session_status: string | null
  enrolled: number
  present: number
  late: number
  absent: number
  attendance_rate: number
}

export interface AttendanceDashboardRankingsResponse {
  scope: AttendanceDashboardRankingScope
  rows: AttendanceDashboardRankingRow[]
}

export interface AttendanceDashboardFilters {
  start_date?: string
  end_date?: string
  building_id?: string
  room_id?: string
  subject_id?: string
  session_id?: string
  day_of_week?: number
}

export type AttendanceStatus = 'PRESENT' | 'LATE' | 'ABSENT'

export interface StudentSessionCalendarItem {
  session_id: string
  subject_id: string | null
  subject_name: string | null
  subject_code: string | null
  room_id: string
  room_code: string | null
  teacher_id: string | null
  teacher_name: string | null
  status: SessionStatus
  mode: SessionMode
  start_time: string
  end_time: string | null
  attendance_status: AttendanceStatus
}

export interface StudentAttendanceSummary {
  present: number
  late: number
  absent: number
  total_sessions: number
}

export interface StudentBehaviorSummaryItem {
  behavior_class: string
  count: number
  duration_seconds: number
  avg_confidence: number
}

export interface StudentIncidentItem {
  id: string
  risk_score: number
  risk_level: string
  triggered_behaviors: Record<string, unknown>
  flagged_at: string
  reviewed: boolean
  reviewer_notes: string | null
}

export interface StudentSessionDetailResponse {
  session_id: string
  subject_name: string | null
  room_code: string | null
  teacher_name: string | null
  start_time: string
  end_time: string | null
  attendance_status: AttendanceStatus
  first_seen_at: string | null
  confidence: number | null
  grace_minutes: number
  behavior_summary: StudentBehaviorSummaryItem[]
  incidents: StudentIncidentItem[]
}
