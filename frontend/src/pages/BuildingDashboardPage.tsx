import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AttendanceLivePanel } from '../components/AttendanceLivePanel'
import { ClassroomMapView } from '../components/ClassroomMapView'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Camera,
  CheckCircle2,
  Monitor,
  School,
  Settings,
} from 'lucide-react'
import { AdminBuildingLayout } from '../components/AdminBuildingLayout'
import { isUuidLikeBuildingId, resolveBuildingFromRouteParam } from '../utils/buildingRoute'
import { buildAttendanceStreamUrl } from '../utils/attendanceStream'
import { getBuildingsOverview } from '../services/api'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  addRoomDevice,
  changeSessionMode,
  endSession,
  getDeviceTypes,
  getEffectiveRefreshInterval,
  getBuildingFloors,
  getFloorRooms,
  getGlobalThresholds,
  getIncidents,
  getRoomDevices,
  getLatestSessionFrame,
  getRoomDeviceStates,
  getRoomSensorReadings,
  getRoomThresholds,
  getSessionAttendanceReport,
  getSessionAnalytics,
  getSessions,
  getTutorRoomContext,
  removeRoomDevice,
  reviewIncident,
  toggleDevice,
  updateAttendanceConfig,
  updateGlobalThreshold,
  updateRoomThreshold,
  updateRoomDevice,
} from '../services/api'
import type {
  AttendanceSessionReport,
  BuildingOverview,
  DeviceCreatePayload,
  DeviceTypeItem,
  FloorSummary,
  Incident,
  LatestFrameResponse,
  RoomDeviceState,
  RoomSensorReadingItem,
  RoomThresholdConfigItem,
  RoomDeviceInventoryItem,
  RoomSummary,
  SessionAnalytics,
  SessionSummary,
  ThresholdConfigItem,
} from '../types'
import { timeAgo, toLocalDateTime } from '../utils/time'
import { usePermissions } from '../hooks/usePermissions'
import { PERMISSIONS } from '../constants/permissions'
import { useAuthStore } from '../store/auth'

type ModeFilter = 'NORMAL' | 'TESTING'
type SeverityFilter = 'ALL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
type LeaderboardMetric = 'RISK' | 'PERFORMANCE'
type DashboardView = 'DEVICES' | 'MODE' | 'DEVICE_SCREEN' | 'MODE_SCREEN'
type ViewMode = 'DEVICE_SCREEN' | 'MODE_SCREEN'
type DeviceCrudPanelView = 'FILTER' | 'CRUD'
type DeviceInventoryWithRoom = RoomDeviceInventoryItem & { room_id: string; room_code: string | null }

interface StreamStatusResponse {
  session_id: string | null
  is_running: boolean
  total_recognized: number
  camera_active: boolean
  recognized_students: Array<{
    student_code: string
    student_name: string
    confidence: number
    timestamp: string
  }>
  last_recognition_at: string | null
}

function toSeverity(score: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (score < 0.4) return 'LOW'
  if (score < 0.65) return 'MEDIUM'
  if (score < 0.8) return 'HIGH'
  return 'CRITICAL'
}

function ensureDataUri(value: string): string {
  if (value.startsWith('data:image')) return value
  return `data:image/jpeg;base64,${value}`
}

function formatClock(iso: string | null): string {
  if (!iso) return '--:--'
  try {
    const date = new Date(iso)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '--:--'
  }
}

function formatSensorReading(value: number, unit?: string | null): string {
  const normalizedUnit = unit?.trim() ?? ''
  if (normalizedUnit.toLowerCase() === 'people') {
    return `${Math.round(value)} people`
  }

  const normalizedValue = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return normalizedUnit ? `${normalizedValue} ${normalizedUnit}` : normalizedValue
}

export function BuildingDashboardPage(): JSX.Element {
  const { buildingId: buildingIdParam } = useParams<{ buildingId: string }>()
  const navigate = useNavigate()

  const [allBuildings, setAllBuildings] = useState<BuildingOverview[]>([])
  const [resolvedBuildingId, setResolvedBuildingId] = useState<string | null>(null)

  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [analytics, setAnalytics] = useState<SessionAnalytics | null>(null)
  const [latestFrame, setLatestFrame] = useState<LatestFrameResponse | null>(null)
  const [deviceStates, setDeviceStates] = useState<RoomDeviceState[]>([])
  const [deviceInventory, setDeviceInventory] = useState<DeviceInventoryWithRoom[]>([])
  const [roomSensorReadings, setRoomSensorReadings] = useState<RoomSensorReadingItem[]>([])
  const [deviceTypes, setDeviceTypes] = useState<DeviceTypeItem[]>([])
  const [globalThresholds, setGlobalThresholds] = useState<ThresholdConfigItem[]>([])
  const [roomThresholds, setRoomThresholds] = useState<RoomThresholdConfigItem[]>([])
  const [attendanceReport, setAttendanceReport] = useState<AttendanceSessionReport | null>(null)
  const [graceMinutesDraft, setGraceMinutesDraft] = useState<string>('10')
  const [isSavingGraceConfig, setIsSavingGraceConfig] = useState(false)
  const [graceConfigMessage, setGraceConfigMessage] = useState<string | null>(null)
  const [thresholdDraft, setThresholdDraft] = useState<Record<string, { min: string; max: string; target: string; enabled: boolean }>>({})
  const [thresholdMessage, setThresholdMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [isSavingThreshold, setIsSavingThreshold] = useState(false)

  const [selectedFloorId, setSelectedFloorId] = useState<string>('ALL')
  const [selectedRoomId, setSelectedRoomId] = useState<string>('ALL')
  const [selectedSessionId, setSelectedSessionId] = useState<string>('')
  const [dashboardView, setDashboardView] = useState<DashboardView>('DEVICES')
  const [modeFilter, setModeFilter] = useState<ModeFilter>('NORMAL')
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL')
  const [incidentTypeFilter, setIncidentTypeFilter] = useState<string>('ALL')
  const [leaderboardMetric, setLeaderboardMetric] = useState<LeaderboardMetric>('RISK')
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({})
  const [newDevice, setNewDevice] = useState<DeviceCreatePayload>({
    device_type: 'LIGHT',
    location_front_back: 'FRONT',
    location_left_right: 'LEFT',
    power_consumption_watts: 0,
  })
  const [editingDeviceId, setEditingDeviceId] = useState<string>('')
  const [editingDeviceRoomId, setEditingDeviceRoomId] = useState<string>('')
  const [editingDeviceFrontBack, setEditingDeviceFrontBack] = useState<'FRONT' | 'BACK'>('FRONT')
  const [editingDeviceLeftRight, setEditingDeviceLeftRight] = useState<'LEFT' | 'RIGHT'>('LEFT')
  const [editingDevicePower, setEditingDevicePower] = useState<string>('0')
  const [deviceSearch, setDeviceSearch] = useState<string>('')
  const [deviceTypeFilter, setDeviceTypeFilter] = useState<string>('ALL')
  const [deviceLocationFilter, setDeviceLocationFilter] = useState<string>('ALL')
  const [deviceCrudPanelView, setDeviceCrudPanelView] = useState<DeviceCrudPanelView>('CRUD')
  const [isAddingDevice, setIsAddingDevice] = useState(false)
  const [createDeviceMessage, setCreateDeviceMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [streamStatus, setStreamStatus] = useState<StreamStatusResponse | null>(null)
  const [isStreamOnline, setIsStreamOnline] = useState(false)
  const [lastLiveRefreshAt, setLastLiveRefreshAt] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('MODE_SCREEN')

  const [isStructureLoading, setIsStructureLoading] = useState(true)
  const [isLiveLoading, setIsLiveLoading] = useState(true)
  const [resolvedRefreshMs, setResolvedRefreshMs] = useState<number>(30000)
  const [error, setError] = useState<string | null>(null)

  const buildingId = resolvedBuildingId
  const { has, hasAny } = usePermissions()
  const currentRole = useAuthStore((state) => state.user?.role ?? null)
  const isTutorDashboard = currentRole === 'INSTRUCTOR' && modeFilter !== 'TESTING'
  const isProctorDashboard = currentRole === 'INSTRUCTOR' && modeFilter === 'TESTING'
  const isFacilityDashboard = currentRole === 'FACILITY_STAFF'
  const isCleaningStaffDashboard = currentRole === 'FACILITY_STAFF'
  const isOperationsDashboard = isFacilityDashboard || isCleaningStaffDashboard
  const isScopedClassroomDashboard = isTutorDashboard || isProctorDashboard

  const canManageDevices = hasAny([PERMISSIONS.DEVICE_MANAGEMENT, PERMISSIONS.SYSTEM_SETTINGS])
  const canOnlyToggleDevices = isCleaningStaffDashboard && !canManageDevices
  const canToggleDevices =
    canManageDevices ||
    hasAny([PERMISSIONS.ENV_LIGHT, PERMISSIONS.ENV_AC, PERMISSIONS.ENV_FAN]) ||
    currentRole === 'FACILITY_STAFF'
  const canManageThresholds = hasAny([PERMISSIONS.ENV_THRESHOLDS, PERMISSIONS.SYSTEM_SETTINGS])
  const canEditRoomThresholds = canManageThresholds || isScopedClassroomDashboard
  const canManageAttendanceConfig = currentRole === 'INSTRUCTOR' || currentRole === 'ACADEMIC_MANAGER'
  const canSwitchLearningMode = has(PERMISSIONS.MODE_SWITCH_LEARNING)
  const canSwitchTestingMode = has(PERMISSIONS.MODE_SWITCH_TESTING)
  const canEndSession = canSwitchLearningMode || canSwitchTestingMode
  const canViewIncidents = has(PERMISSIONS.INCIDENT_VIEW)
  const canViewFrames = hasAny([PERMISSIONS.CAMERA_VIEW_LIVE, PERMISSIONS.CAMERA_VIEW_RECORDED])
  const canViewAnalytics = hasAny([
    PERMISSIONS.REPORT_PERFORMANCE,
    PERMISSIONS.DASHBOARD_VIEW_CLASSROOM,
    PERMISSIONS.DASHBOARD_VIEW_BLOCK,
    PERMISSIONS.DASHBOARD_VIEW_UNIVERSITY,
  ])
  const canReviewIncidents = hasAny([
    PERMISSIONS.INCIDENT_RESOLVE,
    PERMISSIONS.INCIDENT_AUDIT,
    PERMISSIONS.ALERT_ACKNOWLEDGE,
  ])
  const isSystemAdmin = currentRole === 'ACADEMIC_MANAGER'
  const shouldShowWorkspace = !isSystemAdmin || Boolean(selectedSessionId)

  useEffect(() => {
    async function resolveContext(): Promise<void> {
      try {
        const buildings = await getBuildingsOverview()
        setAllBuildings(buildings)

        if (!buildingIdParam) {
          setResolvedBuildingId(null)
          return
        }

        const resolved = resolveBuildingFromRouteParam(buildings, buildingIdParam)
        setResolvedBuildingId(resolved?.id ?? buildingIdParam)
      } catch {
        setResolvedBuildingId(buildingIdParam ?? null)
      }
    }
    void resolveContext()
  }, [buildingIdParam])

  useEffect(() => {
    if (isProctorDashboard && modeFilter !== 'TESTING') {
      setModeFilter('TESTING')
    }
  }, [isProctorDashboard, modeFilter])

  useEffect(() => {
    if (isOperationsDashboard && dashboardView !== 'DEVICES') {
      setDashboardView('DEVICES')
    }
  }, [dashboardView, isOperationsDashboard])

  useEffect(() => {
    if (isTutorDashboard && viewMode !== 'DEVICE_SCREEN') {
      setViewMode('DEVICE_SCREEN')
    }
  }, [isTutorDashboard, viewMode])

  const filteredRooms = useMemo(() => {
    if (selectedFloorId === 'ALL') return rooms
    return rooms.filter((room) => room.floor_id === selectedFloorId)
  }, [rooms, selectedFloorId])

  useEffect(() => {
    if (!isCleaningStaffDashboard || selectedRoomId !== 'ALL' || filteredRooms.length === 0) {
      return
    }
    setSelectedRoomId(filteredRooms[0].id)
  }, [filteredRooms, isCleaningStaffDashboard, selectedRoomId])

  const selectedFloor = useMemo(
    () => (selectedFloorId === 'ALL' ? null : floors.find((floor) => floor.id === selectedFloorId) ?? null),
    [floors, selectedFloorId],
  )

  const roomIdsInBuilding = useMemo(() => rooms.map((room) => room.id), [rooms])

  const visibleSessions = useMemo(() => {
    const sessionsInBuilding = sessions.filter((session) => roomIdsInBuilding.includes(session.room_id))

    if (isScopedClassroomDashboard) {
      return sessionsInBuilding.filter((session) => {
        const roomMatch = selectedRoomId === 'ALL' || session.room_id === selectedRoomId
        if (!roomMatch) return false
        if (isProctorDashboard) return session.mode === 'TESTING'
        return true
      })
    }

    return sessionsInBuilding.filter((session) => {
      const roomMatch = selectedRoomId === 'ALL' || session.room_id === selectedRoomId
      const modeMatch = session.mode === modeFilter
      return roomMatch && modeMatch
    })
  }, [isProctorDashboard, isScopedClassroomDashboard, modeFilter, roomIdsInBuilding, selectedRoomId, sessions])

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  )

  const selectedRoom = useMemo(
    () => (selectedRoomId === 'ALL' ? null : rooms.find((room) => room.id === selectedRoomId) ?? null),
    [rooms, selectedRoomId],
  )

  const targetCrudRoom = useMemo(() => {
    if (!isFacilityDashboard) return selectedRoom
    if (selectedRoomId === 'ALL') return null
    return selectedRoom
  }, [isFacilityDashboard, selectedRoom, selectedRoomId])

  const sensorReadingByKey = useMemo(() => {
    const byKey = new Map<string, RoomSensorReadingItem>()
    roomSensorReadings.forEach((reading) => {
      byKey.set(reading.sensor_key.toUpperCase(), reading)
    })
    return byKey
  }, [roomSensorReadings])

  const sensorReadingByDeviceType = useMemo(() => {
    const readingFor = (keys: string[]): string => {
      for (const key of keys) {
        const row = sensorReadingByKey.get(key)
        if (row) {
          return formatSensorReading(row.value, row.unit)
        }
      }
      return '-'
    }

    return {
      LIGHT: readingFor(['LIGHT']),
      AC: readingFor(['TEMPERATURE', 'TEMP']),
      FAN: readingFor(['HUMIDITY']),
      CAMERA: '-',
    }
  }, [sensorReadingByKey])

  const deviceThresholdRows = useMemo(() => {
    const thresholdByType = new Map<string, RoomThresholdConfigItem>()
    roomThresholds.forEach((threshold) => {
      thresholdByType.set(threshold.device_type_code.toUpperCase(), threshold)
    })

    const globalByType = new Map<string, ThresholdConfigItem>()
    globalThresholds.forEach((threshold) => {
      globalByType.set(threshold.device_type_code.toUpperCase(), threshold)
    })

    const typeCodes = new Set<string>()
    deviceInventory.forEach((device) => {
      if (device.device_type) {
        typeCodes.add(device.device_type.toUpperCase())
      }
    })
    roomThresholds.forEach((threshold) => {
      if (threshold.device_type_code) {
        typeCodes.add(threshold.device_type_code.toUpperCase())
      }
    })

    const resolveSensorReading = (deviceTypeCode: string): RoomSensorReadingItem | null => {
      const mapping: Record<string, string[]> = {
        LIGHT: ['LIGHT'],
        AC: ['TEMPERATURE', 'TEMP'],
        FAN: ['HUMIDITY'],
        CAMERA: [],
      }

      const candidates = mapping[deviceTypeCode] ?? [deviceTypeCode]
      for (const candidate of candidates) {
        const match = sensorReadingByKey.get(candidate)
        if (match) {
          return match
        }
      }
      return null
    }

    return Array.from(typeCodes)
      .sort((left, right) => left.localeCompare(right))
      .map((deviceTypeCode) => {
        const reading = resolveSensorReading(deviceTypeCode)
        const threshold = thresholdByType.get(deviceTypeCode)
        const globalThreshold = globalByType.get(deviceTypeCode)

        return {
          deviceTypeCode,
          readingDisplay: reading ? formatSensorReading(reading.value, reading.unit) : '-',
          unit: reading?.unit ?? '-',
          minValue: threshold?.min_value ?? globalThreshold?.min_value ?? null,
          targetValue: threshold?.target_value ?? globalThreshold?.target_value ?? null,
          maxValue: threshold?.max_value ?? globalThreshold?.max_value ?? null,
          enabled: threshold?.enabled ?? globalThreshold?.enabled ?? true,
          source: threshold?.is_override ? 'Room' : 'Global',
        }
      })
  }, [deviceInventory, globalThresholds, roomThresholds, sensorReadingByKey])

  useEffect(() => {
    if (!isScopedClassroomDashboard) return
    const nextDraft: Record<string, { min: string; max: string; target: string; enabled: boolean }> = {}
    deviceThresholdRows.forEach((row) => {
      nextDraft[row.deviceTypeCode] = {
        min: row.minValue == null ? '' : String(row.minValue),
        max: row.maxValue == null ? '' : String(row.maxValue),
        target: row.targetValue == null ? '' : String(row.targetValue),
        enabled: row.enabled,
      }
    })
    setThresholdDraft(nextDraft)
  }, [deviceThresholdRows, isScopedClassroomDashboard])

  useEffect(() => {
    let isMounted = true

    async function resolveRefreshInterval(): Promise<void> {
      if (!buildingId) return

      const roomScope = selectedRoomId !== 'ALL' ? selectedRoomId : undefined
      try {
        const config = await getEffectiveRefreshInterval(buildingId, modeFilter, roomScope)
        if (!isMounted) return
        setResolvedRefreshMs(config.interval_ms)
      } catch {
        if (!isMounted) return
        setResolvedRefreshMs(modeFilter === 'TESTING' ? 2000 : 30000)
      }
    }

    void resolveRefreshInterval()

    return () => {
      isMounted = false
    }
  }, [buildingId, modeFilter, selectedRoomId])

  useEffect(() => {
    let isMounted = true

    async function loadAttendanceConfig(): Promise<void> {
      if (!selectedSessionId || !canManageAttendanceConfig) {
        setAttendanceReport(null)
        setGraceConfigMessage(null)
        return
      }

      try {
        const report = await getSessionAttendanceReport(selectedSessionId)
        if (!isMounted) return
        setAttendanceReport(report)
        setGraceMinutesDraft(String(report.grace_minutes))
      } catch (loadError) {
        if (!isMounted) return
        setAttendanceReport(null)
        setGraceConfigMessage(loadError instanceof Error ? loadError.message : 'Failed to load attendance config')
      }
    }

    void loadAttendanceConfig()

    return () => {
      isMounted = false
    }
  }, [canManageAttendanceConfig, selectedSessionId])

  useEffect(() => {
    let isMounted = true

    async function loadStructure(): Promise<void> {
      if (!buildingId) return

      setIsStructureLoading(true)
      setError(null)

      try {
        const floorData = await getBuildingFloors(buildingId)
        const roomsByFloor = await Promise.all(
          floorData.map(async (floor) => {
            const floorRooms = await getFloorRooms(buildingId, floor.id)
            return floorRooms
          }),
        )

        const flattenedRooms = roomsByFloor.flat()

        if (!isMounted) return

        setFloors(floorData)
        setRooms(flattenedRooms)
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load building data')
      } finally {
        if (isMounted) setIsStructureLoading(false)
      }
    }

    void loadStructure()

    return () => {
      isMounted = false
    }
  }, [buildingId])

  useEffect(() => {
    let isMounted = true

    async function loadLiveData(): Promise<void> {
      if (!buildingId) return

      setIsLiveLoading(true)
      try {
        let effectiveRoomId = selectedRoomId
        let effectiveSessions: SessionSummary[] = []
        let nextSessionId = selectedSessionId

        if (isScopedClassroomDashboard) {
          const roomContext = await getTutorRoomContext()
          if (!isMounted) return

          if (roomContext.building_id && roomContext.building_id !== buildingId) {
            navigate(`/buildings/${roomContext.building_id}`)
            return
          }

          if (!roomContext.room_id || !roomContext.floor_id) {
            setSessions([])
            setSelectedSessionId('')
            setError('No assigned classroom found for your tutor dashboard.')
            setAnalytics(null)
            setLatestFrame(null)
            setDeviceStates([])
            setDeviceInventory([])
            setRoomThresholds([])
            setThresholdDraft({})
            return
          }

          setError(null)

          if (selectedFloorId !== roomContext.floor_id) setSelectedFloorId(roomContext.floor_id)
          if (selectedRoomId !== roomContext.room_id) setSelectedRoomId(roomContext.room_id)

          effectiveRoomId = roomContext.room_id
          effectiveSessions = isProctorDashboard
            ? roomContext.active_sessions.filter((session) => session.mode === 'TESTING')
            : roomContext.active_sessions
          setSessions(effectiveSessions)

          const hasSelectedSession = effectiveSessions.some((session) => session.id === selectedSessionId)
          nextSessionId = hasSelectedSession
            ? selectedSessionId
            : (roomContext.selected_session_id ?? effectiveSessions[0]?.id ?? '')
        } else {
          const sessionParams: { mode?: 'NORMAL' | 'TESTING'; status_filter?: 'ACTIVE' } = {
            status_filter: 'ACTIVE',
            mode: modeFilter,
          }

          const sessionData = await getSessions(sessionParams)
          if (!isMounted) return

          const buildingSessionData = sessionData.filter((session) => roomIdsInBuilding.includes(session.room_id))
          effectiveSessions = buildingSessionData
          setSessions(buildingSessionData)

          const hasSelectedSession = buildingSessionData.some((session) => session.id === selectedSessionId)
          nextSessionId = hasSelectedSession
            ? selectedSessionId
            : (isSystemAdmin ? '' : (buildingSessionData[0]?.id ?? ''))
        }

        if (nextSessionId !== selectedSessionId) {
          setSelectedSessionId(nextSessionId)
        }

        const incidentData = canViewIncidents
          ? await getIncidents(effectiveRoomId === 'ALL' ? undefined : { room_id: effectiveRoomId })
          : []
        if (!isMounted) return

        setIncidents(
          incidentData.filter((incident) =>
            effectiveRoomId === 'ALL'
              ? effectiveSessions.some((session) => session.id === incident.session_id)
              : true,
          ),
        )

        if (nextSessionId) {
          const fallbackFrame: LatestFrameResponse = {
            source: 'none',
            image_base64: null,
            captured_at: null,
          }

          const [analyticsData, frameData] = await Promise.all([
            canViewAnalytics ? getSessionAnalytics(nextSessionId) : Promise.resolve(null),
            canViewFrames
              ? getLatestSessionFrame(nextSessionId)
              : Promise.resolve(fallbackFrame),
          ])
          if (!isMounted) return
          setAnalytics(analyticsData)
          setLatestFrame(frameData)
        } else {
          setAnalytics(null)
          setLatestFrame(null)
        }

        if (effectiveRoomId !== 'ALL') {
          const [roomDeviceData, roomInventoryData, roomThresholdData, sensorReadingsData] = await Promise.all([
            getRoomDeviceStates(effectiveRoomId),
            getRoomDevices(effectiveRoomId),
            getRoomThresholds(effectiveRoomId),
            getRoomSensorReadings(effectiveRoomId),
          ])
          if (!isMounted) return
          setDeviceStates(roomDeviceData.device_states)
          setDeviceInventory(
            roomInventoryData.devices.map((device) => ({
              ...device,
              room_id: effectiveRoomId,
              room_code: roomInventoryData.room_code,
            })),
          )
          setRoomThresholds(roomThresholdData)
          setRoomSensorReadings(sensorReadingsData.readings)

          const nextDraft: Record<string, { min: string; max: string; target: string; enabled: boolean }> = {}
          roomThresholdData.forEach((item) => {
            nextDraft[item.device_type_code] = {
              min: item.min_value == null ? '' : String(item.min_value),
              max: item.max_value == null ? '' : String(item.max_value),
              target: item.target_value == null ? '' : String(item.target_value),
              enabled: item.enabled,
            }
          })
          setThresholdDraft(nextDraft)
        } else if (isFacilityDashboard) {
          const scopedRooms = selectedFloorId === 'ALL' ? rooms : filteredRooms
          const roomDeviceData = await Promise.all(
            scopedRooms.map(async (room) => {
              const [states, inventory] = await Promise.all([
                getRoomDeviceStates(room.id),
                getRoomDevices(room.id),
              ])

              return {
                room,
                states: states.device_states,
                inventory: inventory.devices,
              }
            }),
          )

          if (!isMounted) return

          const mergedStates = roomDeviceData.flatMap((entry) => entry.states)
          const mergedInventory = roomDeviceData.flatMap((entry) =>
            entry.inventory.map((device) => ({
              ...device,
              room_id: entry.room.id,
              room_code: entry.room.room_code,
            })),
          )

          setDeviceStates(mergedStates)
          setDeviceInventory(mergedInventory)
          setRoomThresholds([])
          setRoomSensorReadings([])
          setThresholdDraft({})
        } else {
          setDeviceStates([])
          setDeviceInventory([])
          setRoomThresholds([])
          setRoomSensorReadings([])
          setThresholdDraft({})
        }

        const [typeData, globalThresholdData] = await Promise.all([
          getDeviceTypes(),
          canManageThresholds ? getGlobalThresholds() : Promise.resolve([]),
        ])
        if (!isMounted) return
        setDeviceTypes(typeData)
        setGlobalThresholds(globalThresholdData)
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to refresh dashboard data')
      } finally {
        if (isMounted) setIsLiveLoading(false)
      }
    }

    void loadLiveData()
    void fetchStreamStatus()

    const refreshMs = resolvedRefreshMs
    const intervalId = window.setInterval(() => {
      void loadLiveData()
      void fetchStreamStatus()
    }, refreshMs)

    return () => {
      isMounted = false
      window.clearInterval(intervalId)
    }
  }, [
    buildingId,
    canManageThresholds,
    canViewAnalytics,
    canViewFrames,
    canViewIncidents,
    currentRole,
    isProctorDashboard,
    isScopedClassroomDashboard,
    isTutorDashboard,
    isFacilityDashboard,
    modeFilter,
    navigate,
    resolvedRefreshMs,
    roomIdsInBuilding,
    rooms,
    selectedFloorId,
    filteredRooms,
    selectedRoomId,
    selectedSession?.mode,
    selectedSessionId,
  ])

  const filteredIncidents = useMemo(() => {
    return incidents.filter((incident) => {
      const severity = toSeverity(incident.risk_score)
      const severityMatch = severityFilter === 'ALL' || severity === severityFilter

      const behaviorKeys = Object.keys(incident.triggered_behaviors || {})
      const typeMatch = incidentTypeFilter === 'ALL' || behaviorKeys.includes(incidentTypeFilter)

      return severityMatch && typeMatch
    })
  }, [incidents, severityFilter, incidentTypeFilter])

  const riskChartData = useMemo(() => {
    return filteredIncidents
      .slice()
      .sort((a, b) => new Date(a.flagged_at).getTime() - new Date(b.flagged_at).getTime())
      .map((incident) => ({
        time: new Date(incident.flagged_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        risk: Number(incident.risk_score.toFixed(2)),
      }))
  }, [filteredIncidents])

  const behaviorDistributionData = useMemo(() => {
    const bucket: Record<string, number> = {}

    Object.values(analytics?.student_performance ?? {}).forEach((studentBehaviors) => {
      Object.entries(studentBehaviors).forEach(([behaviorClass, count]) => {
        bucket[behaviorClass] = (bucket[behaviorClass] ?? 0) + count
      })
    })

    return Object.entries(bucket)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
  }, [analytics])

  const leaderboardData = useMemo(() => {
    if (leaderboardMetric === 'RISK') {
      const scores: Record<string, number> = {}
      filteredIncidents.forEach((incident) => {
        scores[incident.student_id] = Math.max(scores[incident.student_id] ?? 0, incident.risk_score)
      })

      return Object.entries(scores)
        .map(([studentId, score]) => ({
          actor: studentId.slice(0, 8),
          value: Number(score.toFixed(2)),
          label: 'Risk',
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8)
    }

    const performance: Record<string, number> = {}
    Object.entries(analytics?.student_performance ?? {}).forEach(([studentId, behaviorMap]) => {
      const score = Object.values(behaviorMap).reduce((sum, count) => sum + count, 0)
      performance[studentId] = score
    })

    return Object.entries(performance)
      .map(([studentId, score]) => ({
        actor: studentId.slice(0, 8),
        value: score,
        label: 'Activity',
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
  }, [analytics, filteredIncidents, leaderboardMetric])

  const incidentTypeOptions = useMemo(() => {
    const options = new Set<string>()
    incidents.forEach((incident) => {
      Object.keys(incident.triggered_behaviors || {}).forEach((behavior) => options.add(behavior))
    })
    return ['ALL', ...Array.from(options)]
  }, [incidents])

  const unreviewedCount = useMemo(
    () => filteredIncidents.filter((incident) => !incident.reviewed).length,
    [filteredIncidents],
  )

  const mergedDevices = useMemo(() => {
    const stateById = new Map(deviceStates.map((state) => [state.device_id, state]))
    return deviceInventory.map((device) => ({
      ...device,
      status: stateById.get(device.device_id)?.status ?? 'OFF',
      last_updated: stateById.get(device.device_id)?.last_updated ?? null,
      manual_override: stateById.get(device.device_id)?.manual_override ?? false,
    }))
  }, [deviceInventory, deviceStates])

  const filteredDevices = useMemo(() => {
    const query = deviceSearch.trim().toLowerCase()
    return mergedDevices.filter((device) => {
      const queryMatch =
        !query ||
        [
          device.device_id,
          device.device_type,
          device.location_front_back,
          device.location_left_right,
          device.location,
          String(device.power_consumption_watts ?? 0),
          device.status ?? 'OFF',
        ]
          .join(' ')
          .toLowerCase()
          .includes(query)

      const typeMatch = deviceTypeFilter === 'ALL' || device.device_type === deviceTypeFilter
      const locationMatch =
        deviceLocationFilter === 'ALL' ||
        device.location_front_back === deviceLocationFilter ||
        device.location_left_right === deviceLocationFilter

      return queryMatch && typeMatch && locationMatch
    })
  }, [deviceLocationFilter, deviceSearch, deviceTypeFilter, mergedDevices])

  const facilityDeviceGroups = useMemo(() => {
    const roomCodeById = new Map(rooms.map((room) => [room.id, room.room_code]))
    const grouped = filteredDevices.reduce(
      (acc, device) => {
        const roomCode = device.room_code ?? roomCodeById.get(device.room_id) ?? '-'
        if (!acc.has(device.room_id)) {
          acc.set(device.room_id, {
            room_id: device.room_id,
            room_code: roomCode,
            devices: [] as typeof filteredDevices,
          })
        }
        acc.get(device.room_id)?.devices.push(device)
        return acc
      },
      new Map<string, { room_id: string; room_code: string; devices: typeof filteredDevices }>(),
    )

    const groups = Array.from(grouped.values())
      .map((group) => ({
        ...group,
        devices: [...group.devices].sort((a, b) => {
          if (a.device_type !== b.device_type) {
            return a.device_type.localeCompare(b.device_type)
          }
          return a.device_id.localeCompare(b.device_id)
        }),
      }))
      .sort((a, b) => a.room_code.localeCompare(b.room_code))

    return groups
  }, [filteredDevices, rooms])

  const deviceTypeOptions = useMemo(
    () => ['ALL', ...Array.from(new Set(mergedDevices.map((device) => device.device_type)))],
    [mergedDevices],
  )

  const classroomLayoutDevices = useMemo(() => {
    const positioned: Array<(typeof filteredDevices)[number] & { left: number; top: number }> = []
    const groupedByQuadrant: Record<'FRONT_LEFT' | 'FRONT_RIGHT' | 'BACK_LEFT' | 'BACK_RIGHT', typeof filteredDevices> = {
      FRONT_LEFT: [],
      FRONT_RIGHT: [],
      BACK_LEFT: [],
      BACK_RIGHT: [],
    }

    filteredDevices.forEach((device) => {
      const key = `${device.location_front_back}_${device.location_left_right}` as 'FRONT_LEFT' | 'FRONT_RIGHT' | 'BACK_LEFT' | 'BACK_RIGHT'
      groupedByQuadrant[key].push(device)
    })

    const anchor: Record<'FRONT_LEFT' | 'FRONT_RIGHT' | 'BACK_LEFT' | 'BACK_RIGHT', { left: number; top: number }> = {
      FRONT_LEFT: { left: 22, top: 24 },
      FRONT_RIGHT: { left: 78, top: 24 },
      BACK_LEFT: { left: 22, top: 78 },
      BACK_RIGHT: { left: 78, top: 78 },
    }

    ;(['FRONT_LEFT', 'FRONT_RIGHT', 'BACK_LEFT', 'BACK_RIGHT'] as const).forEach((key) => {
      const bucket = groupedByQuadrant[key]
      bucket.forEach((device, index) => {
        const base = anchor[key]
        const shift = (index - (bucket.length - 1) / 2) * 8
        positioned.push({
          ...device,
          left: base.left + shift,
          top: base.top,
        })
      })
    })

    return positioned.map((device) => {
      return {
        ...device,
        left: Math.max(8, Math.min(92, device.left)),
        top: Math.max(10, Math.min(88, device.top)),
      }
    })
  }, [filteredDevices])

  async function refreshDevices(roomId: string): Promise<void> {
    if (isFacilityDashboard && selectedRoomId === 'ALL') {
      const scopedRooms = selectedFloorId === 'ALL' ? rooms : filteredRooms
      const roomDeviceData = await Promise.all(
        scopedRooms.map(async (room) => {
          const [states, inventory] = await Promise.all([
            getRoomDeviceStates(room.id),
            getRoomDevices(room.id),
          ])

          return {
            room,
            states: states.device_states,
            inventory: inventory.devices,
          }
        }),
      )

      const mergedStates = roomDeviceData.flatMap((entry) => entry.states)
      const mergedInventory = roomDeviceData.flatMap((entry) =>
        entry.inventory.map((device) => ({
          ...device,
          room_id: entry.room.id,
          room_code: entry.room.room_code,
        })),
      )

      setDeviceStates(mergedStates)
      setDeviceInventory(mergedInventory)
      setRoomThresholds([])
      setThresholdDraft({})
      return
    }

    const [roomDeviceData, roomInventoryData, roomThresholdData] = await Promise.all([
      getRoomDeviceStates(roomId),
      getRoomDevices(roomId),
      getRoomThresholds(roomId),
    ])
    setDeviceStates(roomDeviceData.device_states)
    setDeviceInventory(
      roomInventoryData.devices.map((device) => ({
        ...device,
        room_id: roomId,
        room_code: roomInventoryData.room_code,
      })),
    )
    setRoomThresholds(roomThresholdData)

    const nextDraft: Record<string, { min: string; max: string; target: string; enabled: boolean }> = {}
    roomThresholdData.forEach((item) => {
      nextDraft[item.device_type_code] = {
        min: item.min_value == null ? '' : String(item.min_value),
        max: item.max_value == null ? '' : String(item.max_value),
        target: item.target_value == null ? '' : String(item.target_value),
        enabled: item.enabled,
      }
    })
    setThresholdDraft(nextDraft)
  }

  function handleThresholdDraftChange(
    deviceTypeCode: string,
    field: 'min' | 'max' | 'target' | 'enabled',
    value: string | boolean,
  ): void {
    setThresholdDraft((prev) => {
      const current = prev[deviceTypeCode] ?? { min: '', max: '', target: '', enabled: true }
      return {
        ...prev,
        [deviceTypeCode]: {
          ...current,
          [field]: value,
        },
      }
    })
  }

  async function handleSaveRoomThreshold(deviceTypeCode: string): Promise<void> {
    if (!selectedRoom) return
    if (!canEditRoomThresholds) {
      setThresholdMessage({ type: 'error', text: 'You do not have permission to update room thresholds.' })
      return
    }
    const draft = thresholdDraft[deviceTypeCode]
    if (!draft) return

    setIsSavingThreshold(true)
    setThresholdMessage(null)
    try {
      await updateRoomThreshold(selectedRoom.id, deviceTypeCode, {
        min_value: draft.min === '' ? null : Number(draft.min),
        max_value: draft.max === '' ? null : Number(draft.max),
        target_value: draft.target === '' ? null : Number(draft.target),
        enabled: draft.enabled,
      })
      await refreshDevices(selectedRoom.id)
      setThresholdMessage({ type: 'success', text: `Room threshold updated for ${deviceTypeCode}.` })
    } catch (updateError) {
      setThresholdMessage({
        type: 'error',
        text: updateError instanceof Error ? updateError.message : 'Failed to update room threshold',
      })
    } finally {
      setIsSavingThreshold(false)
    }
  }

  async function handleSaveGlobalThreshold(deviceTypeCode: string): Promise<void> {
    if (!canManageThresholds || isScopedClassroomDashboard) {
      setThresholdMessage({ type: 'error', text: 'You do not have permission to update global thresholds.' })
      return
    }
    const draft = thresholdDraft[deviceTypeCode]
    if (!draft) return

    setIsSavingThreshold(true)
    setThresholdMessage(null)
    try {
      await updateGlobalThreshold(deviceTypeCode, {
        min_value: draft.min === '' ? null : Number(draft.min),
        max_value: draft.max === '' ? null : Number(draft.max),
        target_value: draft.target === '' ? null : Number(draft.target),
        enabled: draft.enabled,
      })
      const globalThresholdData = await getGlobalThresholds()
      setGlobalThresholds(globalThresholdData)
      setThresholdMessage({ type: 'success', text: `Global threshold updated for ${deviceTypeCode}.` })
    } catch (updateError) {
      setThresholdMessage({
        type: 'error',
        text: updateError instanceof Error ? updateError.message : 'Failed to update global threshold',
      })
    } finally {
      setIsSavingThreshold(false)
    }
  }

  async function handleToggleSingleDevice(deviceId: string, nextStatus: 'ON' | 'OFF', roomId?: string): Promise<void> {
    const targetRoomId = roomId ?? targetCrudRoom?.id ?? selectedRoom?.id
    if (!targetRoomId) return
    if (!canToggleDevices) {
      setError('You do not have permission to toggle devices.')
      return
    }
    try {
      await toggleDevice(targetRoomId, deviceId, { action: nextStatus })
      await refreshDevices(targetRoomId)
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Failed to toggle device')
    }
  }

  async function handleAddDevice(): Promise<void> {
    const room = targetCrudRoom ?? selectedRoom
    if (!room) {
      setCreateDeviceMessage({ type: 'error', text: 'Select a room before creating a device.' })
      return
    }
    if (!canManageDevices) {
      setCreateDeviceMessage({ type: 'error', text: 'You do not have permission to add devices.' })
      return
    }
    if (!newDevice.location_front_back || !newDevice.location_left_right) {
      setCreateDeviceMessage({ type: 'error', text: 'Location axis values are required to add a device.' })
      return
    }

    setIsAddingDevice(true)
    try {
      await addRoomDevice(room.id, {
        device_type: newDevice.device_type,
        location_front_back: newDevice.location_front_back,
        location_left_right: newDevice.location_left_right,
        power_consumption_watts: newDevice.power_consumption_watts,
      })
      setNewDevice({
        device_type: 'LIGHT',
        location_front_back: 'FRONT',
        location_left_right: 'LEFT',
        power_consumption_watts: 0,
      })
      setCreateDeviceMessage({ type: 'success', text: `Device created successfully in ${room.room_code}` })
      setTimeout(() => setCreateDeviceMessage(null), 3000)
      await refreshDevices(room.id)
    } catch (createError) {
      setCreateDeviceMessage({ 
        type: 'error', 
        text: createError instanceof Error ? createError.message : 'Failed to add device'
      })
    } finally {
      setIsAddingDevice(false)
    }
  }

  async function handleUpdateDevice(deviceId: string, roomId?: string): Promise<void> {
    const targetRoomId = roomId ?? editingDeviceRoomId ?? targetCrudRoom?.id ?? selectedRoom?.id
    if (!targetRoomId) return
    if (!canManageDevices) {
      setError('You do not have permission to update devices.')
      return
    }

    try {
      await updateRoomDevice(targetRoomId, deviceId, {
        location_front_back: editingDeviceFrontBack,
        location_left_right: editingDeviceLeftRight,
        power_consumption_watts: Number(editingDevicePower) || 0,
      })
      setEditingDeviceId('')
      setEditingDeviceRoomId('')
      await refreshDevices(targetRoomId)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update device')
    }
  }

  async function handleDeleteDevice(deviceId: string, roomId?: string): Promise<void> {
    const targetRoomId = roomId ?? targetCrudRoom?.id ?? selectedRoom?.id
    if (!targetRoomId) return
    if (!canManageDevices) {
      setError('You do not have permission to delete devices.')
      return
    }

    if (!window.confirm('Delete this device? This action cannot be undone.')) {
      return
    }

    try {
      await removeRoomDevice(targetRoomId, deviceId)
      await refreshDevices(targetRoomId)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete device')
    }
  }

  function openEditDevice(device: DeviceInventoryWithRoom): void {
    setEditingDeviceId(device.device_id)
    setEditingDeviceRoomId(device.room_id)
    setEditingDeviceFrontBack(device.location_front_back)
    setEditingDeviceLeftRight(device.location_left_right)
    setEditingDevicePower(String(device.power_consumption_watts ?? 0))
  }

  async function handleIncidentAction(incidentId: string, action: 'ACK' | 'DISMISS'): Promise<void> {
    if (!canReviewIncidents) {
      setError('You do not have permission to review incidents.')
      return
    }
    const note = (reviewNotes[incidentId] ?? '').trim()
    if (!note) {
      setError('Please add a note before acknowledging or dismissing an incident.')
      return
    }

    const payloadNote = action === 'DISMISS' ? `[DISMISSED] ${note}` : note

    try {
      await reviewIncident(incidentId, { reviewer_notes: payloadNote })
      setIncidents((prev) =>
        prev.map((incident) =>
          incident.id === incidentId
            ? { ...incident, reviewed: true, reviewer_notes: payloadNote }
            : incident,
        ),
      )
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Failed to update incident review')
    }
  }

  const fetchStreamStatus = async (): Promise<void> => {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 1800)

    try {
      const response = await fetch(buildAttendanceStreamUrl('/status'), { signal: controller.signal })
      if (!response.ok) {
        throw new Error('Service offline')
      }

      const payload = (await response.json()) as StreamStatusResponse
      setStreamStatus(payload)
      setIsStreamOnline(true)
    } catch {
      setStreamStatus(null)
      setIsStreamOnline(false)
    } finally {
      window.clearTimeout(timeoutId)
      setLastLiveRefreshAt(new Date().toISOString())
    }
  }

  async function handleSessionModeChange(mode: 'NORMAL' | 'TESTING'): Promise<void> {
    if (!selectedSessionId) return
    if (mode === 'NORMAL' && !canSwitchLearningMode) {
      setError('You do not have permission to switch to learning mode.')
      return
    }
    if (mode === 'TESTING' && !canSwitchTestingMode) {
      setError('You do not have permission to switch to testing mode.')
      return
    }
    try {
      await changeSessionMode(selectedSessionId, mode)
      setSessions((prev) => prev.map((session) => (session.id === selectedSessionId ? { ...session, mode } : session)))
    } catch (modeError) {
      setError(modeError instanceof Error ? modeError.message : 'Failed to change session mode')
    }
  }

  async function handleSaveGraceMinutes(): Promise<void> {
    if (!selectedSessionId || !canManageAttendanceConfig) return

    const parsedGraceMinutes = Number(graceMinutesDraft)
    if (!Number.isInteger(parsedGraceMinutes) || parsedGraceMinutes < 0 || parsedGraceMinutes > 90) {
      setGraceConfigMessage('Grace minutes must be an integer between 0 and 90.')
      return
    }

    setGraceConfigMessage(null)
    setIsSavingGraceConfig(true)
    try {
      await updateAttendanceConfig(selectedSessionId, {
        grace_minutes: parsedGraceMinutes,
        min_confidence: attendanceReport?.min_confidence ?? 0.75,
        auto_checkin_enabled: true,
      })

      const refreshed = await getSessionAttendanceReport(selectedSessionId)
      setAttendanceReport(refreshed)
      setGraceMinutesDraft(String(refreshed.grace_minutes))
      setGraceConfigMessage('Attendance grace time updated successfully.')
    } catch (saveError) {
      setGraceConfigMessage(saveError instanceof Error ? saveError.message : 'Failed to save attendance config')
    } finally {
      setIsSavingGraceConfig(false)
    }
  }

  function handleSelectSession(session: SessionSummary): void {
    setSelectedSessionId(session.id)

    const sessionRoom = rooms.find((room) => room.id === session.room_id)
    if (sessionRoom) {
      setSelectedRoomId(sessionRoom.id)
      setSelectedFloorId(sessionRoom.floor_id)
    } else {
      setSelectedRoomId(session.room_id)
    }
  }

  async function handleEndSession(): Promise<void> {
    if (!selectedSessionId) return
    if (!canEndSession) {
      setError('You do not have permission to end sessions.')
      return
    }
    try {
      await endSession(selectedSessionId)
      setSessions((prev) => prev.map((session) => (session.id === selectedSessionId ? { ...session, status: 'COMPLETED' } : session)))
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : 'Failed to end session')
    }
  }

  const sidebarContent = isScopedClassroomDashboard ? (
    <div className="sessions-sidebar-stack">
      <section className="sessions-sidebar-block">
        <p className="sidebar-section-title">Assigned Classroom</p>
        <div className="admin-side-context-box">
          {!isScopedClassroomDashboard && (
            <p className="muted">
              Building: <strong>{allBuildings.find((b) => b.id === buildingId)?.code ?? buildingIdParam}</strong>
            </p>
          )}
          <p className="muted">
            Floor: <strong>{selectedFloor ? `F${selectedFloor.floor_number} ${selectedFloor.name ?? ''}`.trim() : '-'}</strong>
          </p>
          <p className="muted">Room: <strong>{selectedRoom?.room_code ?? 'No assigned room'}</strong></p>
        </div>
      </section>

      {isTutorDashboard ? null : (
        <section className="sessions-sidebar-block">
          <p className="sidebar-section-title">View Mode</p>
          <div className="view-mode-segment">
            <button
              type="button"
              className={viewMode === 'DEVICE_SCREEN' ? 'active' : ''}
              onClick={() => setViewMode('DEVICE_SCREEN')}
            >
              Device Screen
            </button>
            <button
              type="button"
              className={viewMode === 'MODE_SCREEN' ? 'active' : ''}
              onClick={() => setViewMode('MODE_SCREEN')}
            >
              Mode Screen
            </button>
          </div>
        </section>
      )}

      {canManageAttendanceConfig ? (
        <section className="sessions-sidebar-block attendance-config-mini">
          <div className="mini-card-header">
            <h3>Attendance Config</h3>
            <span>{graceMinutesDraft} min</span>
          </div>

          <label htmlFor="sessions-grace-range">Grace Minutes</label>
          <input
            id="sessions-grace-range"
            type="range"
            min={0}
            max={90}
            value={Number(graceMinutesDraft) || 0}
            onChange={(event) => setGraceMinutesDraft(event.target.value)}
            disabled={!selectedSessionId || isSavingGraceConfig}
          />

          <button
            type="button"
            onClick={() => void handleSaveGraceMinutes()}
            disabled={!selectedSessionId || isSavingGraceConfig}
          >
            {isSavingGraceConfig ? 'Saving...' : 'Save Configuration'}
          </button>

          <p className="muted compact-note">
            Current: Grace {attendanceReport?.grace_minutes ?? 10} min | Confidence {(attendanceReport?.min_confidence ?? 0.75).toFixed(2)}
          </p>

          {graceConfigMessage ? <p className="mini-message error">{graceConfigMessage}</p> : null}
        </section>
      ) : null}

      <section className="sessions-sidebar-block live-attendance-mini">
        <div className="mini-card-header">
          <h3>Live Attendance</h3>
          <span className={`service-pill ${isStreamOnline && streamStatus?.is_running ? 'online' : 'offline'}`}>
            {isStreamOnline && streamStatus?.is_running ? 'SERVICE ONLINE' : 'SERVICE OFFLINE'}
          </span>
        </div>

        <p className="muted compact-note">Auto-refreshing...</p>

        <div className="live-mini-grid">
          <article>
            <span>Enrolled</span>
            <strong>{attendanceReport?.totals.enrolled ?? 0}</strong>
          </article>
          <article>
            <span>Present</span>
            <strong>{attendanceReport?.totals.present ?? 0}</strong>
          </article>
          <article>
            <span>Late</span>
            <strong>{attendanceReport?.totals.late ?? 0}</strong>
          </article>
          <article>
            <span>Absent</span>
            <strong>{attendanceReport?.totals.absent ?? 0}</strong>
          </article>
        </div>

        <div className="live-mini-roster">
          <p>Roster</p>
          <p className="muted compact-note">
            {streamStatus && streamStatus.recognized_students.length > 0
              ? `${streamStatus.recognized_students.length} recognition events`
              : 'No records...'}
          </p>
        </div>

        <p className="muted compact-note">Updated {formatClock(lastLiveRefreshAt)}</p>
      </section>
    </div>
  ) : (
    <>
      <div className="filter-group">
        <label htmlFor="floor-filter">Floor</label>
        <select id="floor-filter" value={selectedFloorId} onChange={(event) => setSelectedFloorId(event.target.value)}>
          <option value="ALL">All Floors</option>
          {floors.map((floor) => (
            <option key={floor.id} value={floor.id}>
              Floor {floor.floor_number}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <label htmlFor="room-filter">Room</label>
        <select id="room-filter" value={selectedRoomId} onChange={(event) => setSelectedRoomId(event.target.value)}>
          <option value="ALL">All Rooms</option>
          {filteredRooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.room_code}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <label htmlFor="screen-filter">Dashboard View Mode</label>
        <select
          id="screen-filter"
          value={viewMode}
          onChange={(event) => setViewMode(event.target.value as ViewMode)}
        >
          <option value="MODE_SCREEN">Session & Student List</option>
          <option value="DEVICE_SCREEN">Device & Sensor Screen</option>
        </select>
      </div>

      <section className="admin-side-section">
        <div className="section-title-row">
          <h3>Current Sessions</h3>
          <span className="badge">{visibleSessions.length}</span>
        </div>
        <div className="admin-side-list">
          {visibleSessions.length === 0 ? (
            <p className="muted small">No active sessions for this scope.</p>
          ) : (
            visibleSessions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`admin-side-item ${s.id === selectedSessionId ? 'is-active' : ''}`}
                onClick={() => handleSelectSession(s)}
              >
                <div className="asi-header">
                  <strong>{s.room_code}</strong>
                  <span className="asi-time">{formatClock(s.start_time)}</span>
                </div>
                <div className="asi-footer">
                  <span>{s.subject_code}</span>
                  <ArrowRight size={14} />
                </div>
              </button>
            ))
          )}
        </div>
      </section>

      {canManageAttendanceConfig ? (
        <section className="admin-side-section attendance-config-sidebar">
          <div className="section-title-row">
            <h3>Attendance Config</h3>
            {selectedSessionId && <Settings size={14} className="muted" />}
          </div>

          <div className="admin-side-form">
            <div className="filter-group">
              <label htmlFor="grace-minutes-input">Grace Minutes (0-90)</label>
              <input
                id="grace-minutes-input"
                type="number"
                min={0}
                max={90}
                step={1}
                value={graceMinutesDraft}
                onChange={(event) => setGraceMinutesDraft(event.target.value)}
                disabled={!selectedSessionId || isSavingGraceConfig}
              />
            </div>
            <button
              type="button"
              className="admin-btn-primary"
              onClick={() => void handleSaveGraceMinutes()}
              disabled={!selectedSessionId || isSavingGraceConfig}
            >
              {isSavingGraceConfig ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>

          <div className="admin-side-footer-info">
            <p className="muted small">
              Grace: {attendanceReport?.grace_minutes ?? '-'}m | Conf: {attendanceReport?.min_confidence ?? '-'}
            </p>
            {graceConfigMessage ? <p className="small text-danger">{graceConfigMessage}</p> : null}
          </div>
        </section>
      ) : null}
    </>
  )

  const dashboardMetrics = [
    { label: 'Unreviewed Alerts', value: unreviewedCount, tone: unreviewedCount > 0 ? 'danger' : 'neutral' as any },
    { label: 'Active Sessions', value: visibleSessions.length, tone: visibleSessions.length > 0 ? 'safe' : 'neutral' as any },
    { label: 'Room Devices', value: deviceStates.length, tone: 'neutral' as any },
  ]

  const roomDeviceRows = useMemo(
    () => [...mergedDevices].sort((left, right) => left.device_id.localeCompare(right.device_id)),
    [mergedDevices],
  )

  if (!buildingId) {
    return (
      <main className="page">
        <section className="panel error-panel">Missing building id in route.</section>
      </main>
    )
  }

  if (isSystemAdmin && !shouldShowWorkspace) {
    return (
      <AdminBuildingLayout
        buildingId={buildingId ?? undefined}
        title="Sessions Management"
        subtitle="Global overview of university sessions and risk alerts."
        eyebrow="System Administration"
        metrics={dashboardMetrics}
        sidebarContent={sidebarContent}
        wrapSidebarContentPanel={false}
      >
        <section className="panel">
          <div className="section-title-row">
            <h2>University Sessions Table</h2>
            <span>{visibleSessions.length} records</span>
          </div>

          {(isStructureLoading || isLiveLoading) && <section className="panel">Refreshing dashboard data...</section>}
          {error && <section className="panel error-panel">{error}</section>}

          <div className="table-scroll">
            <table className="ratio-table sessions-ratio-table">
              <colgroup>
                <col className="col-room" />
                <col className="col-mode" />
                <col className="col-status" />
                <col className="col-start" />
                <col className="col-risk" />
                <col className="col-detail" />
              </colgroup>
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Start Time</th>
                  <th>Risk Alerts</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {visibleSessions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center muted py-8">
                      No sessions found for this scope.
                    </td>
                  </tr>
                ) : (
                  visibleSessions.map((session) => (
                    <tr
                      key={session.id}
                      className="clickable-row"
                      onClick={() => handleSelectSession(session)}
                    >
                      <td>{session.room_code || '-'}</td>
                      <td>{session.mode}</td>
                      <td>
                        <span className={`alp-status-badge alp-status-${session.status.toLowerCase()}`}>
                          {session.status}
                        </span>
                      </td>
                      <td>{toLocalDateTime(session.start_time)}</td>
                      <td>
                        <span className={`risk-tag risk-${toSeverity(session.final_risk_score || 0).toLowerCase()}`}>
                          {session.risk_alerts_count} alerts
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn-link"
                            onClick={(event) => {
                              event.stopPropagation()
                              handleSelectSession(session)
                            }}
                          >
                            Select
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </AdminBuildingLayout>
    )
  }

  return (
    <AdminBuildingLayout
      buildingId={buildingId ?? undefined}
      title={isScopedClassroomDashboard ? "Instructor Dashboard" : "Building Dashboard"}
      subtitle={isScopedClassroomDashboard
        ? `Monitoring live attendance and sessions for assigned classroom ${selectedRoom?.room_code ?? ''}`
        : "Operational overview of building status, sessions, and IoT environment."
      }
      eyebrow={isScopedClassroomDashboard ? "Personal Workspace" : "Building Workspace"}
      metrics={isCleaningStaffDashboard || isScopedClassroomDashboard ? [] : dashboardMetrics}
      sidebarContent={sidebarContent}
      wrapSidebarContentPanel={false}
    >
      {(isStructureLoading || isLiveLoading) && <section className="panel">Refreshing dashboard data...</section>}
      {error && <section className="panel error-panel">{error}</section>}

      {canManageAttendanceConfig && selectedSessionId && !isScopedClassroomDashboard ? (
        <AttendanceLivePanel sessionId={selectedSessionId} />
      ) : null}

      {isScopedClassroomDashboard ? (
        <>
              <section className="panel device-screen-panel">
                <div className="section-title-row">
                  <h3>Device Screen</h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span>{selectedRoom ? selectedRoom.room_code : 'Select a room to view devices'}</span>
                  </div>
                </div>

              {selectedRoomId === 'ALL' ? (
                <p className="muted device-screen-empty">Select a room to load devices.</p>
              ) : roomDeviceRows.length === 0 ? (
                <p className="muted device-screen-empty">No devices were found for the selected room.</p>
              ) : (
                <div className="device-split-layout">
                  <div className="table-scroll">
                    <table className="device-screen-table">
                      <thead>
                        <tr>
                          <th>Device ID</th>
                          <th>Type</th>
                          <th>Location</th>
                          <th>Power (W)</th>
                          <th>Status</th>
                          <th>Last Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roomDeviceRows.map((device) => {
                          const isOn = (device.status ?? 'OFF').toUpperCase() === 'ON'

                          return (
                            <tr key={device.device_id}>
                              <td>{device.device_id}</td>
                              <td>{device.device_type} {device.device_index}</td>
                              <td>{device.location}</td>
                              <td>{device.power_consumption_watts ?? 0}</td>
                              <td>
                                <button
                                  type="button"
                                  className={`device-status-toggle ${isOn ? 'on' : 'off'}`}
                                  onClick={() => void handleToggleSingleDevice(device.device_id, isOn ? 'OFF' : 'ON', device.room_id)}
                                  disabled={!canToggleDevices}
                                  title={canToggleDevices ? 'Click to toggle status' : 'View only'}
                                >
                                  {isOn ? 'ON' : 'OFF'}
                                </button>
                              </td>
                              <td>{toLocalDateTime(device.last_updated)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <ClassroomMapView
                    devices={roomDeviceRows}
                    roomCode={selectedRoom?.room_code ?? undefined}
                    disabled={!canToggleDevices}
                    onToggle={(deviceId, action, roomId) => void handleToggleSingleDevice(deviceId, action, roomId)}
                  />
                </div>
              )}
              </section>

              {selectedRoomId !== 'ALL' ? (
                <section className="panel device-threshold-standalone">
                  <div className="section-title-row">
                    <h3>Device Readings &amp; Thresholds</h3>
                    <span>{selectedRoom?.room_code ?? 'Selected room'}</span>
                  </div>

                  <p className="muted">
                    Current sensor readings and effective thresholds. Edit values, then save to room scope or global scope.
                  </p>

                  {thresholdMessage ? (
                    <div className={`message-banner ${thresholdMessage.type}`}>
                      {thresholdMessage.text}
                    </div>
                  ) : null}

                  {deviceThresholdRows.length === 0 ? (
                    <p className="muted">No readings or thresholds are available for this room yet.</p>
                  ) : (
                    <div className="table-scroll">
                      <table className="device-screen-table">
                        <thead>
                          <tr>
                            <th>Device Type</th>
                            <th>Reading</th>
                            <th>Unit</th>
                            <th>Min</th>
                            <th>Target</th>
                            <th>Max</th>
                            <th>Enabled</th>
                            <th>Source</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deviceThresholdRows.map((row) => {
                            const draft = thresholdDraft[row.deviceTypeCode] ?? {
                              min: row.minValue == null ? '' : String(row.minValue),
                              max: row.maxValue == null ? '' : String(row.maxValue),
                              target: row.targetValue == null ? '' : String(row.targetValue),
                              enabled: row.enabled,
                            }

                            return (
                              <tr key={row.deviceTypeCode}>
                                <td>{row.deviceTypeCode}</td>
                                <td>{row.readingDisplay}</td>
                                <td>{row.unit}</td>
                                <td>
                                  <input
                                    className="threshold-input"
                                    type="number"
                                    value={draft.min}
                                    onChange={(event) => handleThresholdDraftChange(row.deviceTypeCode, 'min', event.target.value)}
                                    disabled={!canEditRoomThresholds || isSavingThreshold}
                                  />
                                </td>
                                <td>
                                  <input
                                    className="threshold-input"
                                    type="number"
                                    value={draft.target}
                                    onChange={(event) => handleThresholdDraftChange(row.deviceTypeCode, 'target', event.target.value)}
                                    disabled={!canEditRoomThresholds || isSavingThreshold}
                                  />
                                </td>
                                <td>
                                  <input
                                    className="threshold-input"
                                    type="number"
                                    value={draft.max}
                                    onChange={(event) => handleThresholdDraftChange(row.deviceTypeCode, 'max', event.target.value)}
                                    disabled={!canEditRoomThresholds || isSavingThreshold}
                                  />
                                </td>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={draft.enabled}
                                    onChange={(event) => handleThresholdDraftChange(row.deviceTypeCode, 'enabled', event.target.checked)}
                                    disabled={!canEditRoomThresholds || isSavingThreshold}
                                  />
                                </td>
                                <td>{row.source}</td>
                                <td>
                                  <div className="row-actions threshold-row-actions">
                                    <button
                                      type="button"
                                      onClick={() => void handleSaveRoomThreshold(row.deviceTypeCode)}
                                      disabled={!canEditRoomThresholds || isSavingThreshold}
                                    >
                                      Save Room
                                    </button>
                                    {!isScopedClassroomDashboard && (
                                      <button
                                        type="button"
                                        onClick={() => void handleSaveGlobalThreshold(row.deviceTypeCode)}
                                        disabled={!canManageThresholds || isSavingThreshold}
                                      >
                                        Save Global
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              ) : null}
              <section className="panel student-list-panel">
                <div className="section-title-row">
                  <h3>Student List</h3>
                  <div className="row-actions row-actions--horizontal">
                    {attendanceReport && (
                      <div className="student-kpi-grid">
                        <article className="stat-card tone-neutral">
                          <div className="admin-metric-stack">
                            <span>Enrolled</span>
                            <strong>{attendanceReport.totals.enrolled}</strong>
                          </div>
                        </article>
                        <article className="stat-card tone-safe">
                          <div className="admin-metric-stack">
                            <span>Present</span>
                            <strong>{attendanceReport.totals.present}</strong>
                          </div>
                        </article>
                        <article className="stat-card tone-warn">
                          <div className="admin-metric-stack">
                            <span>Late</span>
                            <strong>{attendanceReport.totals.late}</strong>
                          </div>
                        </article>
                        <article className="stat-card tone-danger">
                          <div className="admin-metric-stack">
                            <span>Absent</span>
                            <strong>{attendanceReport.totals.absent}</strong>
                          </div>
                        </article>

                        {selectedSession?.mode === 'NORMAL' && (() => {
                          const scores = attendanceReport.students
                            .map((s) => s.performance_score)
                            .filter((s): s is number => s !== null)
                          const avg = scores.length > 0
                            ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
                            : null
                          return avg !== null ? (
                            <article className="stat-card tone-safe">
                              <div className="admin-metric-stack">
                                <span>Avg Score</span>
                                <strong>{avg}</strong>
                              </div>
                            </article>
                          ) : null
                        })()}

                        {selectedSession?.mode === 'TESTING' && (() => {
                          const flagged = attendanceReport.students.filter((s) => s.risk_level !== null).length
                          return (
                            <article className="stat-card tone-danger">
                              <div className="admin-metric-stack">
                                <span>Flagged</span>
                                <strong>{flagged}</strong>
                              </div>
                            </article>
                          )
                        })()}
                      </div>
                    )}
                    <button
                      type="button"
                      className="header-nav-link btn-capture-styled"
                      onClick={() => {
                        if (selectedSession) {
                          navigate(`/sessions/${selectedSession.id}/capture`)
                        }
                      }}
                      disabled={!selectedSession}
                    >
                      <Camera size={14} /> Open Camera Capture
                    </button>
                  </div>
                </div>

                {!selectedSessionId ? (
                  <p className="muted">Select a current session to view student attendance status.</p>
                ) : attendanceReport ? (
                  <div className="table-scroll">
                    <table className="student-list-table student-list-table--rich">
                      <thead>
                        <tr>
                          <th>Student</th>
                          <th>Class</th>
                          <th>Status</th>
                          <th>Check-in</th>
                          <th>Confidence</th>
                          {selectedSession?.mode === 'NORMAL' ? (
                            <>
                              <th>Perf. Score</th>
                              <th>Top Behaviors</th>
                              <th>Negative Flags</th>
                            </>
                          ) : (
                            <>
                              <th>Risk Level</th>
                              <th>Risk Flags</th>
                              <th>Reviewed</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {attendanceReport.students.map((student) => {
                          const isLearning = selectedSession?.mode === 'NORMAL'

                          const NEGATIVE_BEHAVIORS = new Set([
                            'yawning',
                            'bow-head',
                            'using-phone',
                            'using-computer',
                            'talking',
                            'leaning-on-desk',
                          ])
                          const behaviorEntries = student.behavior_summary
                            ? Object.entries(student.behavior_summary).sort(([, a], [, b]) => b - a)
                            : []
                          const topPositive = behaviorEntries
                            .filter(([k]) => !NEGATIVE_BEHAVIORS.has(k))
                            .slice(0, 3)
                          const negativeCount = behaviorEntries
                            .filter(([k]) => NEGATIVE_BEHAVIORS.has(k))
                            .reduce((sum, [, v]) => sum + v, 0)

                          const riskFlags = student.triggered_behaviors
                            ? Object.entries(student.triggered_behaviors).filter(([, v]) => (v as number) > 0)
                            : []

                          const riskLevelClass = student.risk_level
                            ? `risk-level-pill ${student.risk_level.toLowerCase()}`
                            : ''

                          return (
                            <tr key={student.student_id}>
                              <td>
                                <div className="student-name-stack">
                                  <strong>{student.student_name}</strong>
                                  <span>{student.student_code}</span>
                                </div>
                              </td>
                              <td>
                                <span className="student-class-badge">{student.student_class ?? '—'}</span>
                              </td>
                              <td>
                                <span className={`student-status-pill ${student.status.toLowerCase()}`}>
                                  {student.status}
                                </span>
                              </td>
                              <td className="td-mono">
                                {student.first_seen_at
                                  ? new Date(student.first_seen_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                  : <span className="muted">—</span>}
                              </td>
                              <td className="td-mono">
                                {student.confidence !== null
                                  ? <span className="confidence-badge">{Math.round(student.confidence * 100)}%</span>
                                  : <span className="muted">—</span>}
                              </td>
                              {isLearning ? (
                                <>
                                  <td>
                                    {student.performance_score !== null ? (
                                      <div className="perf-score-cell">
                                        <div
                                          className="perf-score-bar"
                                          style={{ width: `${Math.min(100, Math.max(0, student.performance_score))}%` }}
                                        />
                                        <span>{student.performance_score}</span>
                                      </div>
                                    ) : <span className="muted">—</span>}
                                  </td>
                                  <td>
                                    {topPositive.length > 0 ? (
                                      <div className="behavior-chips">
                                        {topPositive.map(([k, v]) => (
                                          <span key={k} className="behavior-chip positive" title={k}>
                                            {k.replace(/-/g, ' ')} ×{v}
                                          </span>
                                        ))}
                                      </div>
                                    ) : <span className="muted">—</span>}
                                  </td>
                                  <td>
                                    {negativeCount > 0 ? (
                                      <span className="behavior-chip negative">⚠ {negativeCount}</span>
                                    ) : <span className="muted">—</span>}
                                  </td>
                                </>
                              ) : (
                                <>
                                  <td>
                                    {student.risk_level ? (
                                      <span className={riskLevelClass}>{student.risk_level}</span>
                                    ) : <span className="muted">—</span>}
                                  </td>
                                  <td>
                                    {riskFlags.length > 0 ? (
                                      <div className="behavior-chips">
                                        {riskFlags.map(([k, v]) => (
                                          <span key={k} className="behavior-chip risk-flag" title={k}>
                                            {k.replace(/_/g, ' ')} ×{v as number}
                                          </span>
                                        ))}
                                      </div>
                                    ) : <span className="muted">—</span>}
                                  </td>
                                  <td>
                                    {student.incident_reviewed !== null ? (
                                      <span className={`reviewed-badge ${student.incident_reviewed ? 'done' : 'pending'}`}>
                                        {student.incident_reviewed ? '✓ Reviewed' : '⏳ Pending'}
                                      </span>
                                    ) : <span className="muted">—</span>}
                                  </td>
                                </>
                              )}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">Attendance report is not available for the selected session.</p>
                )}
              </section>
        </>
      ) : isOperationsDashboard ? (
        <section className="panel">
          <div className="section-title-row">
            <div>
              <h2>Device Operations Table</h2>
              <span>{facilityDeviceGroups.length} rooms / {filteredDevices.length} devices</span>
            </div>
          </div>
          <p className="muted">
            Room filter: {selectedRoomId === 'ALL' ? 'All rooms in current building scope' : selectedRoom?.room_code ?? 'No room selected'}
          </p>

          {facilityDeviceGroups.length > 0 && (
            <div className="facility-room-groups">
              {facilityDeviceGroups.map((group) => (
                <article key={group.room_id} className="room-device-group panel">
                  <div className="section-title-row">
                    <h3>Room {group.room_code}</h3>
                    <span>{group.devices.length} devices</span>
                  </div>

                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Device</th>
                          <th>Type</th>
                          <th>Location</th>
                          {!canOnlyToggleDevices ? <th>Power (W)</th> : null}
                          <th>Status</th>
                          {!canOnlyToggleDevices ? <th>Last Updated</th> : null}
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.devices.map((device) => {
                          const isOn = (device.status ?? 'OFF').toUpperCase() === 'ON'
                          const isEditing = editingDeviceId === device.device_id && editingDeviceRoomId === device.room_id

                          return (
                            <tr key={device.device_id}>
                              <td>{device.device_type} {device.device_index}</td>
                              <td>{device.device_type}</td>
                              <td>
                                {isEditing ? (
                                  <div className="inline-filters">
                                    <select
                                      value={editingDeviceFrontBack}
                                      onChange={(e) => setEditingDeviceFrontBack(e.target.value as 'FRONT' | 'BACK')}
                                    >
                                      <option value="FRONT">FRONT</option>
                                      <option value="BACK">BACK</option>
                                    </select>
                                    <select
                                      value={editingDeviceLeftRight}
                                      onChange={(e) => setEditingDeviceLeftRight(e.target.value as 'LEFT' | 'RIGHT')}
                                    >
                                      <option value="LEFT">LEFT</option>
                                      <option value="RIGHT">RIGHT</option>
                                    </select>
                                  </div>
                                ) : (
                                  device.location
                                )}
                              </td>
                              {!canOnlyToggleDevices && (
                                <td>
                                  {isEditing ? (
                                    <input
                                      type="number"
                                      className="inline-input"
                                      value={editingDevicePower}
                                      onChange={(e) => setEditingDevicePower(e.target.value)}
                                    />
                                  ) : (
                                    device.power_consumption_watts
                                  )}
                                </td>
                              )}
                              <td>
                                <button
                                  type="button"
                                  className={`device-status-toggle ${isOn ? 'on' : 'off'}`}
                                  onClick={() => void handleToggleDevice(device)}
                                  disabled={!canToggleDevices}
                                >
                                  {isOn ? 'ON' : 'OFF'}
                                </button>
                              </td>
                              {!canOnlyToggleDevices && <td>{toLocalDateTime(device.last_updated)}</td>}
                              <td>
                                <div className="row-actions">
                                  {canManageDevices ? (
                                    isEditing ? (
                                      <>
                                        <button onClick={() => void handleUpdateDevice(device.device_id, device.room_id)}>Save</button>
                                        <button onClick={() => setEditingDeviceId('')}>Cancel</button>
                                      </>
                                    ) : (
                                      <button onClick={() => openEditDevice(device)}>Edit</button>
                                    )
                                  ) : null}
                                  {canManageDevices && (
                                    <button onClick={() => void handleDeleteDevice(device.device_id, device.room_id)}>Delete</button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="panel">
            <div className="section-title-row">
              <div>
                <h2>{isScopedClassroomDashboard ? "Session History" : "Current Active Sessions"}</h2>
                <p className="muted small">Overview of performance and risk across available rooms.</p>
              </div>
              <div className="row-actions">
                {!isScopedClassroomDashboard && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => navigate(`/buildings/${buildingIdParam}/sessions`)}
                    title="View full sessions history"
                  >
                    <BarChart3 size={18} />
                  </button>
                )}
              </div>
            </div>

            <div className="table-scroll">
              <table className="ratio-table sessions-ratio-table">
                <colgroup>
                  <col className="col-room" />
                  <col className="col-mode" />
                  <col className="col-status" />
                  <col className="col-start" />
                  <col className="col-risk" />
                  <col className="col-detail" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Mode</th>
                    <th>Status</th>
                    <th>Start Time</th>
                    <th>Risk Alerts</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSessions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center muted py-8">
                        No active sessions found for this scope.
                      </td>
                    </tr>
                  ) : (
                    visibleSessions.map((session) => (
                      <tr
                        key={session.id}
                        className={`clickable-row ${session.id === selectedSessionId ? 'is-selected' : ''}`}
                        onClick={() => handleSelectSession(session)}
                      >
                        <td>{session.room_code || '-'}</td>
                        <td>{session.mode}</td>
                        <td>
                          <span className={`alp-status-badge alp-status-${session.status.toLowerCase()}`}>
                            {session.status}
                          </span>
                        </td>
                        <td>{toLocalDateTime(session.start_time)}</td>
                        <td>
                          <span className={`risk-tag risk-${toSeverity(session.final_risk_score || 0).toLowerCase()}`}>
                            {session.risk_alerts_count} alerts
                          </span>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn-link"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleSelectSession(session)
                              }}
                            >
                              Details
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {shouldShowWorkspace && (
            <div className="dashboard-grid">
              {dashboardView === 'DEVICES' ? (
                <>
                  <section className="panel devices-panel">
                    <div className="section-title-row">
                      <h2>Room Environment</h2>
                      <span>{filteredDevices.length} devices found</span>
                    </div>

                    <div className="device-crud-toolbar">
                      <div className="search-box">
                        <input
                          type="text"
                          placeholder="Search devices..."
                          value={deviceSearch}
                          onChange={(e) => setDeviceSearch(e.target.value)}
                        />
                      </div>
                      <div className="filter-group-inline">
                        <select value={deviceTypeFilter} onChange={(e) => setDeviceTypeFilter(e.target.value)}>
                          {deviceTypeOptions.map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="classroom-map-container">
                      <div className="classroom-view-header">
                        <span>Classroom Map View</span>
                        <div className="sensor-summary">
                          {Object.entries(sensorReadingByDeviceType).map(([type, val]) => (
                            <div key={type} className="sensor-chip">
                              <small>{type}:</small>
                              <strong>{val}</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="classroom-map">
                        {classroomLayoutDevices.map((device) => {
                          const isOn = (device.status ?? 'OFF').toUpperCase() === 'ON'
                          return (
                            <div
                              key={device.device_id}
                              className={`map-device-node node-${device.device_type.toLowerCase()} ${isOn ? 'is-on' : 'is-off'}`}
                              style={{ left: `${device.left}%`, top: `${device.top}%` }}
                              title={`${device.device_id}: ${device.status}`}
                              onClick={() => void handleToggleDevice(device)}
                            >
                              <div className="node-icon">
                                {device.device_type === 'LIGHT' ? <Monitor size={14} /> : <BarChart3 size={14} />}
                              </div>
                              <span className="node-label">{device.device_index}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </section>

                  <section className="panel dashboard-incidents-panel">
                    <div className="section-title-row">
                      <h2>Risk Monitoring</h2>
                      <span className="badge">{filteredIncidents.length} logs</span>
                    </div>

                    <div className="incident-list">
                      {filteredIncidents.length === 0 ? (
                        <div className="empty-state">No risk incidents detected in this session.</div>
                      ) : (
                        filteredIncidents.map((incident) => (
                          <article key={incident.id} className={`incident-card risk-${toSeverity(incident.risk_score).toLowerCase()}`}>
                            <div className="ic-header">
                              <span className="ic-actor">{incident.student_name || incident.student_id.slice(0, 8)}</span>
                              <span className="ic-time">{timeAgo(incident.flagged_at)}</span>
                            </div>
                            <div className="ic-body">
                              <div className="ic-behaviors">
                                {Object.keys(incident.triggered_behaviors || {}).map((b) => (
                                  <span key={b} className="behavior-tag">{b}</span>
                                ))}
                              </div>
                            </div>
                            <div className="ic-footer">
                              <span className="ic-score">Risk Score: {(incident.risk_score * 100).toFixed(0)}%</span>
                              {incident.reviewed ? (
                                <CheckCircle2 size={16} className="text-safe" />
                              ) : (
                                <button
                                  className="btn-review"
                                  onClick={() => void handleReviewIncident(incident.id)}
                                >
                                  Review
                                </button>
                              )}
                            </div>
                          </article>
                        ))
                      )}
                    </div>
                  </section>
                </>
              ) : (
                <>
                  <section className="panel dashboard-analytics-panel">
                    <div className="section-title-row">
                      <h2>Performance Analytics</h2>
                      <span>Session Insight</span>
                    </div>

                    <div className="analytics-charts">
                      <div className="chart-container">
                        <h3>Risk Progression</h3>
                        <ResponsiveContainer width="100%" height={240}>
                          <LineChart data={riskChartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis dataKey="time" stroke="#64748b" fontSize={10} />
                            <YAxis stroke="#64748b" fontSize={10} domain={[0, 1]} />
                            <Tooltip
                              contentStyle={{ background: '#1e2232', border: 'none', borderRadius: '8px' }}
                            />
                            <Line type="monotone" dataKey="risk" stroke="#f87171" strokeWidth={2} dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="chart-container">
                        <h3>Behavior Distribution</h3>
                        <ResponsiveContainer width="100%" height={240}>
                          <BarChart data={behaviorDistributionData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis dataKey="name" stroke="#64748b" fontSize={10} />
                            <YAxis stroke="#64748b" fontSize={10} />
                            <Tooltip
                              contentStyle={{ background: '#1e2232', border: 'none', borderRadius: '8px' }}
                            />
                            <Bar dataKey="count" fill="#818cf8" radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </section>

                  <section className="panel leaderboard-panel">
                    <div className="section-title-row">
                      <h2>Student Activity</h2>
                      <div className="tab-buttons">
                        <button
                          className={leaderboardMetric === 'RISK' ? 'is-active' : ''}
                          onClick={() => setLeaderboardMetric('RISK')}
                        >
                          Risk
                        </button>
                        <button
                          className={leaderboardMetric === 'PERFORMANCE' ? 'is-active' : ''}
                          onClick={() => setLeaderboardMetric('PERFORMANCE')}
                        >
                          Activity
                        </button>
                      </div>
                    </div>

                    <div className="leaderboard-list">
                      {leaderboardData.map((item) => (
                        <div key={item.actor} className="leaderboard-item">
                          <span className="li-name">{item.actor}</span>
                          <div className="li-bar-container">
                            <div
                              className={`li-bar ${leaderboardMetric === 'RISK' ? 'bg-danger' : 'bg-primary'}`}
                              style={{ width: `${Math.min(100, item.value * (leaderboardMetric === 'RISK' ? 100 : 5))}%` }}
                            />
                          </div>
                          <span className="li-value">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </div>
          )}
        </>
      )}
    </AdminBuildingLayout>
  )
}
