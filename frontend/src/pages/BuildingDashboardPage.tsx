import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  BarChart3,
  Camera,
  Monitor,
  School,
} from 'lucide-react'
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
type DashboardView = 'DEVICES' | 'MODE'
type DeviceCrudPanelView = 'FILTER' | 'CRUD'
type DeviceInventoryWithRoom = RoomDeviceInventoryItem & { room_id: string; room_code: string | null }

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

function formatSensorReading(value: number, unit?: string | null): string {
  const normalizedUnit = unit?.trim() ?? ''
  if (normalizedUnit.toLowerCase() === 'people') {
    return `${Math.round(value)} people`
  }

  const normalizedValue = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return normalizedUnit ? `${normalizedValue} ${normalizedUnit}` : normalizedValue
}

export function BuildingDashboardPage(): JSX.Element {
  const { buildingId } = useParams<{ buildingId: string }>()
  const navigate = useNavigate()

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

  const [isStructureLoading, setIsStructureLoading] = useState(true)
  const [isLiveLoading, setIsLiveLoading] = useState(true)
  const [resolvedRefreshMs, setResolvedRefreshMs] = useState<number>(30000)
  const [error, setError] = useState<string | null>(null)
  const { has, hasAny } = usePermissions()
  const currentRole = useAuthStore((state) => state.user?.role ?? null)
  const isTutorDashboard = currentRole === 'LECTURER'
  const isProctorDashboard = currentRole === 'EXAM_PROCTOR'
  const isFacilityDashboard = currentRole === 'FACILITY_STAFF'
  const isCleaningStaffDashboard = currentRole === 'CLEANING_STAFF'
  const isOperationsDashboard = isFacilityDashboard || isCleaningStaffDashboard
  const isScopedClassroomDashboard = isTutorDashboard || isProctorDashboard

  const canManageDevices = hasAny([PERMISSIONS.DEVICE_MANAGEMENT, PERMISSIONS.SYSTEM_SETTINGS])
  const canOnlyToggleDevices = isCleaningStaffDashboard && !canManageDevices
  const canToggleDevices =
    canManageDevices ||
    hasAny([PERMISSIONS.ENV_LIGHT, PERMISSIONS.ENV_AC, PERMISSIONS.ENV_FAN]) ||
    currentRole === 'CLEANING_STAFF'
  const canManageThresholds = hasAny([PERMISSIONS.ENV_THRESHOLDS, PERMISSIONS.SYSTEM_SETTINGS])
  const canManageAttendanceConfig = currentRole === 'LECTURER' || currentRole === 'SYSTEM_ADMIN'
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
  const isSystemAdmin = currentRole === 'SYSTEM_ADMIN'
  const shouldShowWorkspace = !isSystemAdmin || Boolean(selectedSessionId)

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

  const sensorReadingByDeviceType = useMemo(() => {
    const byKey = new Map<string, RoomSensorReadingItem>()
    roomSensorReadings.forEach((reading) => {
      byKey.set(reading.sensor_key.toUpperCase(), reading)
    })

    const readingFor = (keys: string[]): string => {
      for (const key of keys) {
        const row = byKey.get(key)
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
  }, [roomSensorReadings])

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

    const refreshMs = resolvedRefreshMs
    const intervalId = window.setInterval(() => {
      void loadLiveData()
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
    if (!canManageThresholds) {
      setError('You do not have permission to update room thresholds.')
      return
    }
    const draft = thresholdDraft[deviceTypeCode]
    if (!draft) return

    try {
      await updateRoomThreshold(selectedRoom.id, deviceTypeCode, {
        min_value: draft.min === '' ? null : Number(draft.min),
        max_value: draft.max === '' ? null : Number(draft.max),
        target_value: draft.target === '' ? null : Number(draft.target),
        enabled: draft.enabled,
      })
      await refreshDevices(selectedRoom.id)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update room threshold')
    }
  }

  async function handleSaveGlobalThreshold(deviceTypeCode: string): Promise<void> {
    if (!canManageThresholds) {
      setError('You do not have permission to update global thresholds.')
      return
    }
    const draft = thresholdDraft[deviceTypeCode]
    if (!draft) return

    try {
      await updateGlobalThreshold(deviceTypeCode, {
        min_value: draft.min === '' ? null : Number(draft.min),
        max_value: draft.max === '' ? null : Number(draft.max),
        target_value: draft.target === '' ? null : Number(draft.target),
        enabled: draft.enabled,
      })
      const globalThresholdData = await getGlobalThresholds()
      setGlobalThresholds(globalThresholdData)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update global threshold')
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

  if (!buildingId) {
    return (
      <main className="page">
        <section className="panel error-panel">Missing building id in route.</section>
      </main>
    )
  }

  if (isSystemAdmin && !shouldShowWorkspace) {
    return (
      <main className="page campus-bg admin-sessions-page">
        <section className="panel">
          <div className="section-title-row">
            <h2>Sessions Table</h2>
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
                {visibleSessions.map((session) => (
                  <tr
                    key={session.id}
                    className="clickable-row"
                    onClick={() => handleSelectSession(session)}
                  >
                    <td>{session.room_code || '-'}</td>
                    <td>{session.mode}</td>
                    <td>{session.status}</td>
                    <td>{toLocalDateTime(session.start_time)}</td>
                    <td>{session.risk_alerts_count}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            handleSelectSession(session)
                          }}
                        >
                          Open
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className={`page split-layout campus-bg${isCleaningStaffDashboard ? ' cleaning-staff-dashboard' : ''}`}>
      <aside className="left-sidebar panel">
        <div className="sidebar-header">
          <h1>Building Dashboard</h1>
        </div>

        {isScopedClassroomDashboard ? (
          <div className="filter-group">
            <label>Assigned Classroom Context</label>
            <p className="muted">Building: {buildingId ?? '-'}</p>
            <p className="muted">
              Floor: {selectedFloor ? `F${selectedFloor.floor_number} ${selectedFloor.name ?? ''}`.trim() : '-'}
            </p>
            <p className="muted">Room: {selectedRoom?.room_code ?? 'No assigned room'}</p>
          </div>
        ) : (
          <>
            <div className="filter-group">
              <label htmlFor="floor-filter">Floor</label>
              <select id="floor-filter" value={selectedFloorId} onChange={(event) => setSelectedFloorId(event.target.value)}>
                <option value="ALL">All Floors</option>
                {floors.map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    F{floor.floor_number} {floor.name ?? ''}
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
                    {room.room_code} {room.name ?? ''}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <div className="filter-group">
          <label htmlFor="screen-filter">Dashboard Screen</label>
          <select
            id="screen-filter"
            value={dashboardView}
            onChange={(event) => setDashboardView(event.target.value as DashboardView)}
          >
            <option value="DEVICES">Device Main Screen</option>
            {!isOperationsDashboard ? <option value="MODE">Mode Info Screen</option> : null}
          </select>
        </div>

        {canManageAttendanceConfig ? (
          <section className="panel">
            <div className="section-title-row">
              <h2>Attendance Config</h2>
              <span>{selectedSessionId ? 'Session-scoped' : 'No session selected'}</span>
            </div>

            <div className="inline-filters">
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
                onClick={() => void handleSaveGraceMinutes()}
                disabled={!selectedSessionId || isSavingGraceConfig}
              >
                {isSavingGraceConfig ? 'Saving...' : 'Save Grace Time'}
              </button>
            </div>

            <p className="muted">
              Current config: Grace {attendanceReport?.grace_minutes ?? '-'} min | Confidence {attendanceReport?.min_confidence ?? '-'}
            </p>
            {graceConfigMessage ? <p className="muted">{graceConfigMessage}</p> : null}
          </section>
        ) : null}

      </aside>

      <section className="right-content">
        {(isStructureLoading || isLiveLoading) && <section className="panel">Refreshing dashboard data...</section>}
        {error && <section className="panel error-panel">{error}</section>}

        {!isCleaningStaffDashboard ? (
          <section className="panel kpi-row">
            <article className="kpi-tile danger">
              <AlertTriangle size={18} />
              <div>
                <p>Unreviewed Alerts</p>
                <strong>{unreviewedCount}</strong>
              </div>
            </article>
            <article className="kpi-tile warn">
              <School size={18} />
              <div>
                <p>Active Sessions</p>
                <strong>{visibleSessions.length}</strong>
              </div>
            </article>
            <article className="kpi-tile safe">
              <Monitor size={18} />
              <div>
                <p>Room Devices</p>
                <strong>{deviceStates.length}</strong>
              </div>
            </article>
          </section>
        ) : null}

        <section className="panel">
          {isOperationsDashboard ? (
            <>
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
                              const isEditing = editingDeviceId === device.device_id
                              return (
                                <tr key={`${device.room_id}:${device.device_id}`}>
                                  <td>{device.device_id}</td>
                                  <td>{device.device_type}</td>
                                  <td>
                                    {!canOnlyToggleDevices && isEditing ? (
                                      <div className="inline-filters">
                                        <select
                                          value={editingDeviceFrontBack}
                                          onChange={(event) =>
                                            setEditingDeviceFrontBack(event.target.value as 'FRONT' | 'BACK')
                                          }
                                        >
                                          <option value="FRONT">FRONT</option>
                                          <option value="BACK">BACK</option>
                                        </select>
                                        <select
                                          value={editingDeviceLeftRight}
                                          onChange={(event) =>
                                            setEditingDeviceLeftRight(event.target.value as 'LEFT' | 'RIGHT')
                                          }
                                        >
                                          <option value="LEFT">LEFT</option>
                                          <option value="RIGHT">RIGHT</option>
                                        </select>
                                      </div>
                                    ) : (
                                      device.location
                                    )}
                                  </td>
                                  {!canOnlyToggleDevices ? (
                                    <td>
                                      {isEditing ? (
                                        <input
                                          type="number"
                                          min={0}
                                          value={editingDevicePower}
                                          onChange={(event) => setEditingDevicePower(event.target.value)}
                                        />
                                      ) : (
                                        device.power_consumption_watts ?? 0
                                      )}
                                    </td>
                                  ) : null}
                                  <td>
                                    <span className={`device-status ${isOn ? 'on' : 'off'}`}>{isOn ? 'ON' : 'OFF'}</span>
                                  </td>
                                  {!canOnlyToggleDevices ? <td>{toLocalDateTime(device.last_updated ?? null)}</td> : null}
                                  <td>
                                    <div className="row-actions">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void handleToggleSingleDevice(device.device_id, isOn ? 'OFF' : 'ON', device.room_id)
                                        }
                                        disabled={!canToggleDevices}
                                      >
                                        Toggle
                                      </button>
                                      {!canOnlyToggleDevices ? (
                                        <>
                                          {isEditing ? (
                                            <button
                                              type="button"
                                              onClick={() => void handleUpdateDevice(device.device_id, device.room_id)}
                                              disabled={!canManageDevices}
                                            >
                                              Save
                                            </button>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={() => openEditDevice(device)}
                                              disabled={!canManageDevices}
                                            >
                                              Edit
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => void handleDeleteDevice(device.device_id, device.room_id)}
                                            disabled={!canManageDevices}
                                          >
                                            Delete
                                          </button>
                                        </>
                                      ) : null}
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

              {!isCleaningStaffDashboard && selectedRoomId === 'ALL' ? (
                <p className="muted">Select a specific room from the left sidebar to manage devices.</p>
              ) : null}

              {!isCleaningStaffDashboard && selectedRoomId !== 'ALL' ? (
                <article className="panel device-subpanel">
                  <div className="section-title-row">
                    <h3>CRUD Activities Panel</h3>
                    <span>{targetCrudRoom ? targetCrudRoom.room_code : 'Select room'}</span>
                  </div>

                  {createDeviceMessage && (
                    <div className={`message-banner ${createDeviceMessage.type}`}>
                      {createDeviceMessage.text}
                    </div>
                  )}

                  <div className="device-create-grid">
                    <select
                      value={newDevice.device_type}
                      onChange={(event) => setNewDevice((prev) => ({ ...prev, device_type: event.target.value }))}
                    >
                      <option value="LIGHT">LIGHT</option>
                      <option value="AC">AC</option>
                      <option value="FAN">FAN</option>
                      <option value="CAMERA">CAMERA</option>
                    </select>
                    <select
                      value={newDevice.location_front_back}
                      onChange={(event) =>
                        setNewDevice((prev) => ({
                          ...prev,
                          location_front_back: event.target.value as 'FRONT' | 'BACK',
                        }))
                      }
                    >
                      <option value="FRONT">FRONT</option>
                      <option value="BACK">BACK</option>
                    </select>
                    <select
                      value={newDevice.location_left_right}
                      onChange={(event) =>
                        setNewDevice((prev) => ({
                          ...prev,
                          location_left_right: event.target.value as 'LEFT' | 'RIGHT',
                        }))
                      }
                    >
                      <option value="LEFT">LEFT</option>
                      <option value="RIGHT">RIGHT</option>
                    </select>
                    <input
                      type="number"
                      min={0}
                      value={newDevice.power_consumption_watts ?? 0}
                      onChange={(event) =>
                        setNewDevice((prev) => ({ ...prev, power_consumption_watts: Number(event.target.value) }))
                      }
                      placeholder="Power (W)"
                    />
                    <button 
                      type="button" 
                      onClick={() => void handleAddDevice()} 
                      disabled={!targetCrudRoom || !canManageDevices || isAddingDevice}
                      className={isAddingDevice ? 'loading' : ''}
                    >
                      {isAddingDevice ? 'Creating...' : 'Create Device'}
                    </button>
                  </div>
                </article>
              ) : null}
            </>
          ) : (
            <>
              <div className="section-title-row">
                <h2>Sessions Table</h2>
                <span>{visibleSessions.length} records</span>
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
                    {visibleSessions.map((session) => (
                      <tr
                        key={session.id}
                        className={selectedSessionId === session.id ? 'selected-row clickable-row' : 'clickable-row'}
                        onClick={() => {
                          if (isScopedClassroomDashboard) {
                            handleSelectSession(session)
                            return
                          }
                          if (isSystemAdmin) {
                            handleSelectSession(session)
                            return
                          }
                          navigate(`/sessions/${session.id}`)
                        }}
                      >
                        <td>{session.room_code || '-'}</td>
                        <td>{session.mode}</td>
                        <td>{session.status}</td>
                        <td>{toLocalDateTime(session.start_time)}</td>
                        <td>{session.risk_alerts_count}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                if (isScopedClassroomDashboard) {
                                  handleSelectSession(session)
                                  return
                                }
                                if (isSystemAdmin) {
                                  handleSelectSession(session)
                                  return
                                }
                                navigate(`/sessions/${session.id}`)
                              }}
                            >
                              {isScopedClassroomDashboard || isSystemAdmin ? 'Select' : 'Detail'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {dashboardView === 'DEVICES' ? (
          <>
            {!isOperationsDashboard ? (
              <>
                <section className="panel">
                  <div className="section-title-row">
                    <h2>Session Detail</h2>
                    <span>{selectedSession ? selectedSession.id.slice(0, 8) : 'No session selected'}</span>
                  </div>
                  {selectedSession ? (
                    <div className="table-scroll">
                      <table>
                        <tbody>
                          <tr>
                            <th>Room</th>
                            <td>{selectedSession.room_code ?? '-'}</td>
                            <th>Mode</th>
                            <td>{selectedSession.mode}</td>
                          </tr>
                          <tr>
                            <th>Status</th>
                            <td>{selectedSession.status}</td>
                            <th>Start</th>
                            <td>{toLocalDateTime(selectedSession.start_time)}</td>
                          </tr>
                          <tr>
                            <th>Risk Alerts</th>
                            <td>{selectedSession.risk_alerts_count}</td>
                            <th>Teacher</th>
                            <td>{selectedSession.teacher_name ?? selectedSession.teacher_id}</td>
                          </tr>
                          <tr>
                            <th>Subject</th>
                            <td>{selectedSession.subject_name ?? selectedSession.subject_id}</td>
                            <th>Session</th>
                            <td>{selectedSession.id}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="muted">No active session available for the selected classroom.</p>
                  )}
                </section>

                <section className="panel">
                  <div className="section-title-row">
                    <h2>2D Classroom Device View</h2>
                    <span>{selectedRoom?.room_code ?? 'Select room'}</span>
                  </div>

                  <div className="classroom-canvas">
                    <div className="classroom-board">Board</div>
                    {classroomLayoutDevices.map((device) => {
                      const isOn = (device.status ?? 'OFF').toUpperCase() === 'ON'
                      return (
                        <button
                          key={device.device_id}
                          type="button"
                          className={`classroom-device ${isOn ? 'on' : 'off'}`}
                          style={{ left: `${device.left}%`, top: `${device.top}%` }}
                          onClick={() => void handleToggleSingleDevice(device.device_id, isOn ? 'OFF' : 'ON', device.room_id)}
                          disabled={!canToggleDevices}
                          title={`${device.device_type} - ${device.location}`}
                        >
                          <span>{device.device_type}</span>
                          <strong>{device.device_id}</strong>
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section className="panel device-crud-container">

              <div className="section-title-row">
                <h2>Device CRUD (Below 2D View)</h2>
                <span>{filteredDevices.length} / {mergedDevices.length} devices</span>
              </div>

              <div className="device-crud-switcher row-actions">
                <button
                  type="button"
                  className={deviceCrudPanelView === 'FILTER' ? 'active-toggle' : ''}
                  onClick={() => setDeviceCrudPanelView('FILTER')}
                >
                  Search & Filter Panel
                </button>
                <button
                  type="button"
                  className={deviceCrudPanelView === 'CRUD' ? 'active-toggle' : ''}
                  onClick={() => setDeviceCrudPanelView('CRUD')}
                >
                  CRUD Activities Panel
                </button>
              </div>

              {deviceCrudPanelView === 'FILTER' ? (
                <article className="panel device-subpanel">
                  <div className="section-title-row">
                    <h3>Search & Filter Panel</h3>
                    <span>{filteredDevices.length} matched</span>
                  </div>
                  <div className="inline-filters device-filter-panel">
                    <input
                      value={deviceSearch}
                      onChange={(event) => setDeviceSearch(event.target.value)}
                      placeholder="Search by id, type, location, status, watts"
                    />
                    <select value={deviceTypeFilter} onChange={(event) => setDeviceTypeFilter(event.target.value)}>
                      {deviceTypeOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    <select value={deviceLocationFilter} onChange={(event) => setDeviceLocationFilter(event.target.value)}>
                      <option value="ALL">ALL LOCATION AXES</option>
                      <option value="FRONT">FRONT</option>
                      <option value="BACK">BACK</option>
                      <option value="LEFT">LEFT</option>
                      <option value="RIGHT">RIGHT</option>
                    </select>
                  </div>
                </article>
              ) : (
                <article className="panel device-subpanel">
                  <div className="section-title-row">
                    <h3>CRUD Activities Panel</h3>
                    <span>{targetCrudRoom ? targetCrudRoom.room_code : 'Select room'}</span>
                  </div>

                  {createDeviceMessage && (
                    <div className={`message-banner ${createDeviceMessage.type}`}>
                      {createDeviceMessage.text}
                    </div>
                  )}

                  <div className="device-create-grid">
                    <select
                      value={newDevice.device_type}
                      onChange={(event) => setNewDevice((prev) => ({ ...prev, device_type: event.target.value }))}
                    >
                      <option value="LIGHT">LIGHT</option>
                      <option value="AC">AC</option>
                      <option value="FAN">FAN</option>
                      <option value="CAMERA">CAMERA</option>
                    </select>
                    <select
                      value={newDevice.location_front_back}
                      onChange={(event) =>
                        setNewDevice((prev) => ({
                          ...prev,
                          location_front_back: event.target.value as 'FRONT' | 'BACK',
                        }))
                      }
                    >
                      <option value="FRONT">FRONT</option>
                      <option value="BACK">BACK</option>
                    </select>
                    <select
                      value={newDevice.location_left_right}
                      onChange={(event) =>
                        setNewDevice((prev) => ({
                          ...prev,
                          location_left_right: event.target.value as 'LEFT' | 'RIGHT',
                        }))
                      }
                    >
                      <option value="LEFT">LEFT</option>
                      <option value="RIGHT">RIGHT</option>
                    </select>
                    <input
                      type="number"
                      min={0}
                      value={newDevice.power_consumption_watts ?? 0}
                      onChange={(event) =>
                        setNewDevice((prev) => ({ ...prev, power_consumption_watts: Number(event.target.value) }))
                      }
                      placeholder="Power (W)"
                    />
                    <button 
                      type="button" 
                      onClick={() => void handleAddDevice()} 
                      disabled={!targetCrudRoom || !canManageDevices || isAddingDevice}
                      className={isAddingDevice ? 'loading' : ''}
                    >
                      {isAddingDevice ? 'Creating...' : 'Create Device'}
                    </button>
                  </div>

                  <div className="table-scroll">
                    <table className="ratio-table crud-ratio-table">
                      <colgroup>
                        <col className="col-device" />
                        <col className="col-type" />
                        <col className="col-location" />
                        <col className="col-power" />
                        <col className="col-status" />
                        <col className="col-actions" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>Device</th>
                          <th>Type</th>
                          <th>Location</th>
                          <th>Power (W)</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDevices.map((device) => {
                          const isOn = (device.status ?? 'OFF').toUpperCase() === 'ON'
                          const isEditing = editingDeviceId === device.device_id
                          return (
                            <tr key={device.device_id}>
                              <td>{device.device_id}</td>
                              <td>{device.device_type}</td>
                              <td>
                                {isEditing ? (
                                  <div className="inline-filters">
                                    <select
                                      value={editingDeviceFrontBack}
                                      onChange={(event) =>
                                        setEditingDeviceFrontBack(event.target.value as 'FRONT' | 'BACK')
                                      }
                                    >
                                      <option value="FRONT">FRONT</option>
                                      <option value="BACK">BACK</option>
                                    </select>
                                    <select
                                      value={editingDeviceLeftRight}
                                      onChange={(event) =>
                                        setEditingDeviceLeftRight(event.target.value as 'LEFT' | 'RIGHT')
                                      }
                                    >
                                      <option value="LEFT">LEFT</option>
                                      <option value="RIGHT">RIGHT</option>
                                    </select>
                                  </div>
                                ) : (
                                  device.location
                                )}
                              </td>
                              <td>
                                {isEditing ? (
                                  <input
                                    type="number"
                                    min={0}
                                    value={editingDevicePower}
                                    onChange={(event) => setEditingDevicePower(event.target.value)}
                                  />
                                ) : (
                                  device.power_consumption_watts ?? 0
                                )}
                              </td>
                              <td>
                                <span className={`device-status ${isOn ? 'on' : 'off'}`}>{isOn ? 'ON' : 'OFF'}</span>
                              </td>
                              <td>
                                <div className="row-actions">
                                  <button
                                    type="button"
                                    onClick={() => void handleToggleSingleDevice(device.device_id, isOn ? 'OFF' : 'ON', device.room_id)}
                                    disabled={!canToggleDevices}
                                  >
                                    Toggle
                                  </button>
                                  {isEditing ? (
                                    <button
                                      type="button"
                                      onClick={() => void handleUpdateDevice(device.device_id, device.room_id)}
                                      disabled={!canManageDevices}
                                    >
                                      Save
                                    </button>
                                  ) : (
                                    <button type="button" onClick={() => openEditDevice(device)} disabled={!canManageDevices}>
                                      Edit
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteDevice(device.device_id, device.room_id)}
                                    disabled={!canManageDevices}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </article>
              )}
                </section>

                <section className="panel device-threshold-container">
                  <div className="section-title-row">
                    <h2>Device Threshold Settings</h2>
                    <span>Stakeholder controls (global + room)</span>
                  </div>

                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Device Type</th>
                          <th>Reading</th>
                          <th>Unit</th>
                          <th>Min</th>
                          <th>Max</th>
                          <th>Target</th>
                          <th>Enabled</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deviceTypes.map((typeItem) => {
                          const roomValue = roomThresholds.find((item) => item.device_type_code === typeItem.code)
                          const globalValue = globalThresholds.find((item) => item.device_type_code === typeItem.code)
                          const draft =
                            thresholdDraft[typeItem.code] ??
                            {
                              min: roomValue?.min_value == null ? String(globalValue?.min_value ?? '') : String(roomValue.min_value),
                              max: roomValue?.max_value == null ? String(globalValue?.max_value ?? '') : String(roomValue.max_value),
                              target:
                                roomValue?.target_value == null
                                  ? String(globalValue?.target_value ?? '')
                                  : String(roomValue.target_value),
                              enabled: roomValue?.enabled ?? globalValue?.enabled ?? true,
                            }

                          return (
                            <tr key={typeItem.code}>
                              <td>{typeItem.display_name}</td>
                              <td>{sensorReadingByDeviceType[typeItem.code as keyof typeof sensorReadingByDeviceType] ?? '-'}</td>
                              <td>{typeItem.unit ?? '-'}</td>
                              <td>
                                <input
                                  className="threshold-input"
                                  type="number"
                                  value={draft.min}
                                  onChange={(event) =>
                                    handleThresholdDraftChange(typeItem.code, 'min', event.target.value)
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  className="threshold-input"
                                  type="number"
                                  value={draft.max}
                                  onChange={(event) =>
                                    handleThresholdDraftChange(typeItem.code, 'max', event.target.value)
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  className="threshold-input"
                                  type="number"
                                  value={draft.target}
                                  onChange={(event) =>
                                    handleThresholdDraftChange(typeItem.code, 'target', event.target.value)
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={draft.enabled}
                                  onChange={(event) =>
                                    handleThresholdDraftChange(typeItem.code, 'enabled', event.target.checked)
                                  }
                                />
                              </td>
                              <td>
                                <div className="row-actions">
                                  <button
                                    type="button"
                                    onClick={() => void handleSaveRoomThreshold(typeItem.code)}
                                    disabled={!selectedRoom || !canManageThresholds}
                                  >
                                    Save Room
                                  </button>
                                  <button type="button" onClick={() => void handleSaveGlobalThreshold(typeItem.code)} disabled={!canManageThresholds}>
                                    Save Global
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="panel">
                  <div className="section-title-row">
                    <h2>Mode Controls</h2>
                    <span>{selectedSession?.mode ?? 'No session selected'}</span>
                  </div>
                  <div className="row-actions session-actions">
                    {!isProctorDashboard ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setModeFilter('NORMAL')
                            void handleSessionModeChange('NORMAL')
                            setDashboardView('MODE')
                          }}
                          disabled={!selectedSessionId || !canSwitchLearningMode}
                        >
                          Activate Learning Mode Screen
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setModeFilter('TESTING')
                            void handleSessionModeChange('TESTING')
                            setDashboardView('MODE')
                          }}
                          disabled={!selectedSessionId || !canSwitchTestingMode}
                        >
                          Activate Testing Mode Screen
                        </button>
                      </>
                    ) : (
                      <p className="muted">Proctor dashboard is locked to testing mode.</p>
                    )}
                    <button type="button" onClick={() => void handleEndSession()} disabled={!selectedSessionId || !canEndSession}>
                      End Session
                    </button>
                  </div>
                </section>
              </>
            ) : null}
          </>
        ) : (
          <>
            <section className="panel">
              <div className="section-title-row">
                <h2>Current Session Mode</h2>
                <span>{modeFilter}</span>
              </div>
              <div className="row-actions session-actions">
                <select
                  value={modeFilter}
                  onChange={(event) => {
                    if (isProctorDashboard) return
                    const nextMode = event.target.value as ModeFilter
                    setModeFilter(nextMode)
                    if (selectedSessionId) {
                      void handleSessionModeChange(nextMode)
                    }
                  }}
                  disabled={isProctorDashboard || !selectedSessionId || (!canSwitchLearningMode && !canSwitchTestingMode)}
                >
                  <option value="NORMAL">Learning Mode</option>
                  <option value="TESTING">Testing Mode</option>
                </select>
              </div>
              <p className="muted">
                {modeFilter === 'TESTING'
                  ? 'Testing mode: Incident feed, risk chart, and annotated frame preview only.'
                  : 'Learning mode: Behavior distribution and student leaderboard only.'}
              </p>
            </section>

            {modeFilter === 'TESTING' ? (
              <>
                <section className="content-grid-two">
                  <article className="panel">
                    <div className="section-title-row">
                      <h2>Incidents Feed</h2>
                      <span>{filteredIncidents.length} incidents</span>
                    </div>

                    {!canViewIncidents ? (
                      <p className="muted">You do not have permission to view incidents.</p>
                    ) : (
                      <>

                        <div className="inline-filters">
                          <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value as SeverityFilter)}>
                            <option value="ALL">All Severity</option>
                            <option value="LOW">Low</option>
                            <option value="MEDIUM">Medium</option>
                            <option value="HIGH">High</option>
                            <option value="CRITICAL">Critical</option>
                          </select>
                          <select value={incidentTypeFilter} onChange={(event) => setIncidentTypeFilter(event.target.value)}>
                            {incidentTypeOptions.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="incident-list">
                          {filteredIncidents.map((incident) => {
                            const note = reviewNotes[incident.id] ?? ''
                            const severity = toSeverity(incident.risk_score)

                            return (
                              <article key={incident.id} className={`incident-item severity-${severity.toLowerCase()}`}>
                                <header>
                                  <strong>{severity}</strong>
                                  <span>{timeAgo(incident.flagged_at)}</span>
                                </header>
                                <p>Student: {incident.student_id.slice(0, 8)}</p>
                                <p>Risk score: {incident.risk_score.toFixed(2)}</p>
                                <p>Behaviors: {Object.keys(incident.triggered_behaviors).join(', ') || 'N/A'}</p>

                                {!incident.reviewed ? (
                                  <>
                                    <textarea
                                      placeholder="Required note for acknowledge/dismiss"
                                      value={note}
                                      disabled={!canReviewIncidents}
                                      onChange={(event) =>
                                        setReviewNotes((prev) => ({ ...prev, [incident.id]: event.target.value }))
                                      }
                                    />
                                    {canReviewIncidents ? (
                                      <div className="row-actions">
                                        <button type="button" onClick={() => void handleIncidentAction(incident.id, 'ACK')}>
                                          Acknowledge
                                        </button>
                                        <button type="button" onClick={() => void handleIncidentAction(incident.id, 'DISMISS')}>
                                          Dismiss
                                        </button>
                                      </div>
                                    ) : (
                                      <p className="muted">You do not have permission to review incidents.</p>
                                    )}
                                  </>
                                ) : (
                                  <p className="muted">Reviewed: {incident.reviewer_notes ?? 'No note'}</p>
                                )}
                              </article>
                            )
                          })}
                        </div>
                      </>
                    )}
                  </article>

                  <article className="panel">
                    <div className="section-title-row">
                      <h2>Annotated Frame Preview</h2>
                      <span>{latestFrame?.source ?? 'none'}</span>
                    </div>

                    {canViewFrames ? (
                      latestFrame?.image_base64 ? (
                        <img
                          className="frame-preview"
                          src={ensureDataUri(latestFrame.image_base64)}
                          alt="Annotated classroom frame"
                        />
                      ) : (
                        <div className="frame-placeholder">
                          <Camera size={20} />
                          <p>No frame available yet for this session.</p>
                        </div>
                      )
                    ) : (
                      <p className="muted">You do not have permission to view annotated frames.</p>
                    )}

                    <p className="muted">Captured: {toLocalDateTime(latestFrame?.captured_at ?? null)}</p>
                  </article>
                </section>

                <section className="panel chart-panel">
                  <div className="section-title-row">
                    <h2>Risk Over Time</h2>
                    <BarChart3 size={16} />
                  </div>
                  <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={riskChartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="time" />
                      <YAxis domain={[0, 1]} />
                      <Tooltip />
                      <Line type="monotone" dataKey="risk" stroke="#b32b24" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </section>
              </>
            ) : (
              <>
                <section className="panel chart-panel">
                  <div className="section-title-row">
                    <h2>Behavior Distribution</h2>
                    <BarChart3 size={16} />
                  </div>
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={behaviorDistributionData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="count" fill="#214b7a" />
                    </BarChart>
                  </ResponsiveContainer>
                </section>

                <section className="panel chart-panel">
                  <div className="section-title-row">
                    <h2>Student Leaderboard</h2>
                    <div className="inline-filters">
                      <button type="button" onClick={() => setLeaderboardMetric('RISK')}>
                        Risk
                      </button>
                      <button type="button" onClick={() => setLeaderboardMetric('PERFORMANCE')}>
                        Performance
                      </button>
                    </div>
                  </div>

                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={leaderboardData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="actor" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Bar
                        dataKey="value"
                        name={leaderboardMetric === 'RISK' ? 'Risk Score' : 'Performance Activity'}
                        fill="#4f6f52"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </section>
              </>
            )}
          </>
        )}
      </section>
    </main>
  )
}
