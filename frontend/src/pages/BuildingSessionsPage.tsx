import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  addRoomDevice,
  getBuildingFloors,
  getBuildingsOverview,
  getGlobalThresholds,
  getRoomSensorReadings,
  getFloorRooms,
  getRoomDeviceStates,
  getRoomDevices,
  getRoomThresholds,
  getSessionAttendanceReport,
  getSessions,
  removeRoomDevice,
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
  FloorSummary,
  RoomDeviceInventoryItem,
  RoomSensorReadingItem,
  ThresholdConfigItem,
  RoomThresholdConfigItem,
  RoomSummary,
  SessionSummary,
} from '../types'
import { toLocalDateTime } from '../utils/time'
import { AdminBuildingLayout } from '../components/AdminBuildingLayout'
import { useAuthStore } from '../store/auth'
import { usePermissions } from '../hooks/usePermissions'
import { PERMISSIONS } from '../constants/permissions'
import { resolveBuildingFromRouteParam } from '../utils/buildingRoute'
import { buildAttendanceStreamUrl } from '../utils/attendanceStream'

type ViewMode = 'DEVICE_SCREEN' | 'MODE_SCREEN'

interface RoomDirectoryItem {
  building: BuildingOverview
  floor: FloorSummary
  room: RoomSummary
}

interface SessionDeviceRow extends RoomDeviceInventoryItem {
  room_id: string
  status: string
  last_updated: string | null
}

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

const EMPTY_TOTALS = {
  enrolled: 0,
  present: 0,
  late: 0,
  absent: 0,
}

const INITIAL_NEW_DEVICE: DeviceCreatePayload = {
  device_type: 'LIGHT',
  location_front_back: 'FRONT',
  location_left_right: 'LEFT',
  power_consumption_watts: 0,
}

function formatClock(value: string | null | undefined): string {
  if (!value) {
    return '-'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return '-'
  }

  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatSensorReading(value: number, unit?: string | null): string {
  const normalizedUnit = unit?.trim() ?? ''
  if (normalizedUnit.toLowerCase() === 'people') {
    return `${Math.round(value)} people`
  }

  const normalizedValue = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return normalizedUnit ? `${normalizedValue} ${normalizedUnit}` : normalizedValue
}

export function BuildingSessionsPage(): JSX.Element {
  const { buildingId } = useParams<{ buildingId: string }>()
  const currentRole = useAuthStore((state) => state.user?.role ?? null)
  const { hasAny } = usePermissions()

  const isGlobalMode = !buildingId
  const canAccessGlobalWorkspace =
    currentRole === 'SYSTEM_ADMIN' || currentRole === 'FACILITY_STAFF' || currentRole === 'CLEANING_STAFF'
  const canManageAttendanceConfig = currentRole === 'LECTURER' || currentRole === 'SYSTEM_ADMIN'
  const canManageDevices = hasAny([PERMISSIONS.DEVICE_MANAGEMENT, PERMISSIONS.SYSTEM_SETTINGS])
  const canManageThresholds = hasAny([PERMISSIONS.ENV_THRESHOLDS, PERMISSIONS.SYSTEM_SETTINGS])
  const canToggleDevices =
    canManageDevices ||
    hasAny([PERMISSIONS.ENV_LIGHT, PERMISSIONS.ENV_AC, PERMISSIONS.ENV_FAN]) ||
    currentRole === 'CLEANING_STAFF'
  const canOnlyToggleDevices = canToggleDevices && !canManageDevices

  const [buildings, setBuildings] = useState<BuildingOverview[]>([])
  const [roomDirectory, setRoomDirectory] = useState<RoomDirectoryItem[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [roomDevices, setRoomDevices] = useState<SessionDeviceRow[]>([])
  const [roomSensorReadings, setRoomSensorReadings] = useState<RoomSensorReadingItem[]>([])
  const [globalThresholds, setGlobalThresholds] = useState<ThresholdConfigItem[]>([])
  const [roomThresholds, setRoomThresholds] = useState<RoomThresholdConfigItem[]>([])
  const [thresholdDraft, setThresholdDraft] = useState<Record<string, { min: string; max: string; target: string; enabled: boolean }>>({})
  const [thresholdMessage, setThresholdMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [attendanceReport, setAttendanceReport] = useState<AttendanceSessionReport | null>(null)

  const [selectedBuildingId, setSelectedBuildingId] = useState<string>(buildingId ?? 'ALL')
  const [selectedFloorId, setSelectedFloorId] = useState<string>('ALL')
  const [selectedRoomId, setSelectedRoomId] = useState<string>('ALL')
  const [selectedSessionId, setSelectedSessionId] = useState<string>('')
  const [viewMode, setViewMode] = useState<ViewMode>('MODE_SCREEN')
  const [graceMinutesDraft, setGraceMinutesDraft] = useState<string>('10')
  const [isGraceDirty, setIsGraceDirty] = useState(false)
  const [configMessage, setConfigMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [newDevice, setNewDevice] = useState<DeviceCreatePayload>(INITIAL_NEW_DEVICE)
  const [editingDeviceId, setEditingDeviceId] = useState<string>('')
  const [editingDeviceRoomId, setEditingDeviceRoomId] = useState<string>('')
  const [editingDeviceFrontBack, setEditingDeviceFrontBack] = useState<'FRONT' | 'BACK'>('FRONT')
  const [editingDeviceLeftRight, setEditingDeviceLeftRight] = useState<'LEFT' | 'RIGHT'>('LEFT')
  const [editingDevicePower, setEditingDevicePower] = useState<string>('0')
  const [createDeviceMessage, setCreateDeviceMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [isAddingDevice, setIsAddingDevice] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const [streamStatus, setStreamStatus] = useState<StreamStatusResponse | null>(null)
  const [isStreamOnline, setIsStreamOnline] = useState(false)
  const [lastLiveRefreshAt, setLastLiveRefreshAt] = useState<string | null>(null)

  const [isStructureLoading, setIsStructureLoading] = useState(true)
  const [isSessionsLoading, setIsSessionsLoading] = useState(true)
  const [isAttendanceLoading, setIsAttendanceLoading] = useState(false)
  const [isRoomDevicesLoading, setIsRoomDevicesLoading] = useState(false)
  const [isThresholdPanelLoading, setIsThresholdPanelLoading] = useState(false)
  const [isSavingThreshold, setIsSavingThreshold] = useState(false)
  const [isSavingConfig, setIsSavingConfig] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedBuildingId('ALL')
    setSelectedFloorId('ALL')
    setSelectedRoomId('ALL')
    setSelectedSessionId('')
    setNewDevice(INITIAL_NEW_DEVICE)
    setCreateDeviceMessage(null)
    setEditingDeviceId('')
    setEditingDeviceRoomId('')
    setReloadKey(0)
  }, [buildingId])

  const roomMetaById = useMemo(
    () => new Map(roomDirectory.map((item) => [item.room.id, item])),
    [roomDirectory],
  )

  const floorsInScope = useMemo(() => {
    if (selectedBuildingId === 'ALL') {
      return []
    }

    const uniqueFloors = new Map<string, FloorSummary>()
    roomDirectory.forEach((item) => {
      if (item.building.id === selectedBuildingId) {
        uniqueFloors.set(item.floor.id, item.floor)
      }
    })

    return Array.from(uniqueFloors.values()).sort((left, right) => left.floor_number - right.floor_number)
  }, [roomDirectory, selectedBuildingId])

  const roomsInScope = useMemo(() => {
    return roomDirectory
      .filter((item) => (selectedBuildingId === 'ALL' ? true : item.building.id === selectedBuildingId))
      .filter((item) => (selectedFloorId === 'ALL' ? true : item.floor.id === selectedFloorId))
      .map((item) => item.room)
      .sort((left, right) => left.room_code.localeCompare(right.room_code))
  }, [roomDirectory, selectedBuildingId, selectedFloorId])

  const selectedRoomMeta = useMemo(
    () => (selectedRoomId === 'ALL' ? null : roomDirectory.find((item) => item.room.id === selectedRoomId) ?? null),
    [roomDirectory, selectedRoomId],
  )

  const sensorReadingByKey = useMemo(() => {
    const map = new Map<string, RoomSensorReadingItem>()
    roomSensorReadings.forEach((reading) => {
      map.set(reading.sensor_key.toUpperCase(), reading)
    })
    return map
  }, [roomSensorReadings])

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
    roomDevices.forEach((device) => {
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
  }, [globalThresholds, roomDevices, roomThresholds, sensorReadingByKey])

  useEffect(() => {
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
  }, [deviceThresholdRows])

  useEffect(() => {
    if (selectedRoomId === 'ALL') {
      return
    }

    const roomStillVisible = roomsInScope.some((room) => room.id === selectedRoomId)
    if (!roomStillVisible) {
      setSelectedRoomId('ALL')
    }
  }, [roomsInScope, selectedRoomId])

  useEffect(() => {
    if (isGlobalMode && !canAccessGlobalWorkspace) {
      setIsStructureLoading(false)
      return
    }

    let isMounted = true

    async function loadStructure(): Promise<void> {
      setIsStructureLoading(true)
      setError(null)

      try {
        const buildingData = await getBuildingsOverview()
        const resolvedBuilding = resolveBuildingFromRouteParam(buildingData, buildingId)
        if (buildingId && !resolvedBuilding) {
          throw new Error('Building not found for this route')
        }

        const scopedBuildings = resolvedBuilding ? [resolvedBuilding] : buildingData

        const directoryByBuilding = await Promise.all(
          scopedBuildings.map(async (building) => {
            const floors = await getBuildingFloors(building.id)
            const roomsByFloor = await Promise.all(
              floors.map(async (floor) => {
                const rooms = await getFloorRooms(building.id, floor.id)
                return rooms.map((room) => ({ building, floor, room }))
              }),
            )
            return roomsByFloor.flat()
          }),
        )

        if (!isMounted) return

        setBuildings(buildingData)
        setRoomDirectory(directoryByBuilding.flat())
        if (resolvedBuilding) {
          setSelectedBuildingId(resolvedBuilding.id)
        }
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load building structure')
      } finally {
        if (isMounted) {
          setIsStructureLoading(false)
        }
      }
    }

    void loadStructure()

    return () => {
      isMounted = false
    }
  }, [buildingId, canAccessGlobalWorkspace, isGlobalMode])

  useEffect(() => {
    if (isGlobalMode && !canAccessGlobalWorkspace) {
      setIsSessionsLoading(false)
      return
    }

    let isMounted = true

    async function loadSessions(): Promise<void> {
      setIsSessionsLoading(true)
      setError(null)

      try {
        const allActiveSessions = await getSessions({ status_filter: 'ACTIVE' })
        if (!isMounted) return
        setSessions(allActiveSessions)
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load active sessions')
      } finally {
        if (isMounted) {
          setIsSessionsLoading(false)
        }
      }
    }

    void loadSessions()

    return () => {
      isMounted = false
    }
  }, [canAccessGlobalWorkspace, isGlobalMode])

  const visibleSessions = useMemo(() => {
    return sessions
      .filter((session) => {
        const roomMeta = roomMetaById.get(session.room_id)
        if (!roomMeta) return false

        if (selectedBuildingId !== 'ALL' && roomMeta.building.id !== selectedBuildingId) {
          return false
        }

        if (selectedFloorId !== 'ALL' && roomMeta.floor.id !== selectedFloorId) {
          return false
        }

        if (selectedRoomId !== 'ALL' && session.room_id !== selectedRoomId) {
          return false
        }

        return true
      })
      .sort((left, right) => new Date(right.start_time).getTime() - new Date(left.start_time).getTime())
  }, [roomMetaById, selectedBuildingId, selectedFloorId, selectedRoomId, sessions])

  useEffect(() => {
    setSelectedSessionId((current) => {
      if (current && visibleSessions.some((session) => session.id === current)) {
        return current
      }

      if (selectedRoomId !== 'ALL') {
        const roomSession = visibleSessions.find((session) => session.room_id === selectedRoomId)
        if (roomSession) {
          return roomSession.id
        }
      }

      return visibleSessions[0]?.id ?? ''
    })
  }, [selectedRoomId, visibleSessions])

  const selectedSession = useMemo(
    () => visibleSessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, visibleSessions],
  )

  const loadAttendanceReport = useCallback(
    async (sessionId: string, silent: boolean): Promise<void> => {
      if (!sessionId) {
        setAttendanceReport(null)
        return
      }

      if (!silent) {
        setIsAttendanceLoading(true)
      }

      try {
        const report = await getSessionAttendanceReport(sessionId)
        setAttendanceReport(report)
        setGraceMinutesDraft((current) => {
          if (!silent || !isGraceDirty) {
            return String(report.grace_minutes)
          }
          return current
        })
        if (!silent) {
          setIsGraceDirty(false)
        }
      } catch (loadError) {
        if (!silent) {
          setAttendanceReport(null)
          setError(loadError instanceof Error ? loadError.message : 'Failed to load attendance report')
        }
      } finally {
        if (!silent) {
          setIsAttendanceLoading(false)
        }
      }
    },
    [isGraceDirty],
  )

  const fetchStreamStatus = useCallback(async (): Promise<void> => {
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
  }, [])

  useEffect(() => {
    if (!selectedSessionId) {
      setAttendanceReport(null)
      setGraceMinutesDraft('10')
      setIsGraceDirty(false)
      return
    }

    setConfigMessage(null)
    setIsGraceDirty(false)
    void loadAttendanceReport(selectedSessionId, false)
  }, [loadAttendanceReport, selectedSessionId])

  useEffect(() => {
    if (!selectedSessionId) {
      setStreamStatus(null)
      setIsStreamOnline(false)
      setLastLiveRefreshAt(null)
      return
    }

    void fetchStreamStatus()

    const intervalId = window.setInterval(() => {
      void loadAttendanceReport(selectedSessionId, true)
      void fetchStreamStatus()
    }, 8000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [fetchStreamStatus, loadAttendanceReport, selectedSessionId])

  useEffect(() => {
    if (viewMode !== 'DEVICE_SCREEN' || selectedRoomId === 'ALL') {
      setRoomDevices([])
      setRoomSensorReadings([])
      setGlobalThresholds([])
      setRoomThresholds([])
      setThresholdDraft({})
      setThresholdMessage(null)
      setIsRoomDevicesLoading(false)
      setIsThresholdPanelLoading(false)
      return
    }

    let isMounted = true

    async function loadRoomDevices(): Promise<void> {
      setIsRoomDevicesLoading(true)
      setIsThresholdPanelLoading(true)

      try {
        const [inventoryResult, stateResult, sensorResult, globalThresholdResult, thresholdResult] = await Promise.allSettled([
          getRoomDevices(selectedRoomId),
          getRoomDeviceStates(selectedRoomId),
          getRoomSensorReadings(selectedRoomId),
          getGlobalThresholds(),
          getRoomThresholds(selectedRoomId),
        ])

        if (inventoryResult.status !== 'fulfilled' || stateResult.status !== 'fulfilled') {
          throw new Error('Failed to load room devices')
        }

        const inventory = inventoryResult.value
        const stateData = stateResult.value

        if (!isMounted) return

        const stateByDeviceId = new Map<string, { status: string; last_updated: string | null }>(
          stateData.device_states.map((state) => [
            state.device_id,
            {
              status: state.status,
              last_updated: state.last_updated,
            },
          ]),
        )

        const merged = inventory.devices
          .map((device) => {
            const liveState = stateByDeviceId.get(device.device_id)
            return {
              ...device,
              room_id: selectedRoomId,
              status: liveState?.status ?? 'OFF',
              last_updated: liveState?.last_updated ?? null,
            }
          })
          .sort((left, right) => left.device_id.localeCompare(right.device_id))

        setRoomDevices(merged)

        setRoomSensorReadings(sensorResult.status === 'fulfilled' ? sensorResult.value.readings : [])
        setGlobalThresholds(globalThresholdResult.status === 'fulfilled' ? globalThresholdResult.value : [])
        setRoomThresholds(thresholdResult.status === 'fulfilled' ? thresholdResult.value : [])
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load room devices')
      } finally {
        if (isMounted) {
          setIsRoomDevicesLoading(false)
          setIsThresholdPanelLoading(false)
        }
      }
    }

    void loadRoomDevices()

    return () => {
      isMounted = false
    }
  }, [reloadKey, selectedRoomId, viewMode])

  function resetDeviceActionState(): void {
    setEditingDeviceId('')
    setEditingDeviceRoomId('')
    setCreateDeviceMessage(null)
  }

  function handleBuildingChange(nextBuildingId: string): void {
    resetDeviceActionState()
    setSelectedBuildingId(nextBuildingId)
    setSelectedFloorId('ALL')
    setSelectedRoomId('ALL')
  }

  function handleFloorChange(nextFloorId: string): void {
    resetDeviceActionState()
    setSelectedFloorId(nextFloorId)
    setSelectedRoomId('ALL')
  }

  function handleRoomChange(nextRoomId: string): void {
    resetDeviceActionState()
    setSelectedRoomId(nextRoomId)
  }

  function handleFocusRoom(session: SessionSummary): void {
    const roomMeta = roomMetaById.get(session.room_id)
    if (roomMeta) {
      if (isGlobalMode) {
        setSelectedBuildingId(roomMeta.building.id)
      }
      setSelectedFloorId(roomMeta.floor.id)
      setSelectedRoomId(roomMeta.room.id)
      setSelectedSessionId(session.id)
      return
    }

    setSelectedRoomId(session.room_id)
    setSelectedSessionId(session.id)
  }

  async function handleSaveGraceMinutes(): Promise<void> {
    if (!selectedSessionId || !attendanceReport || !canManageAttendanceConfig) {
      return
    }

    const parsedGrace = Number(graceMinutesDraft)
    if (!Number.isInteger(parsedGrace) || parsedGrace < 0 || parsedGrace > 90) {
      setConfigMessage({ type: 'error', text: 'Grace minutes must be between 0 and 90.' })
      return
    }

    setIsSavingConfig(true)
    setConfigMessage(null)

    try {
      await updateAttendanceConfig(selectedSessionId, {
        grace_minutes: parsedGrace,
        min_confidence: attendanceReport.min_confidence,
        auto_checkin_enabled: true,
      })

      setIsGraceDirty(false)
      await loadAttendanceReport(selectedSessionId, false)
      setConfigMessage({ type: 'success', text: 'Attendance configuration saved.' })
    } catch (saveError) {
      setConfigMessage({
        type: 'error',
        text: saveError instanceof Error ? saveError.message : 'Failed to save attendance configuration',
      })
    } finally {
      setIsSavingConfig(false)
    }
  }

  async function handleToggleDevice(device: SessionDeviceRow): Promise<void> {
    if (!canToggleDevices) {
      setError('You do not have permission to toggle devices.')
      return
    }

    try {
      const isOn = (device.status ?? 'OFF').toUpperCase() === 'ON'
      await toggleDevice(device.room_id, device.device_id, { action: isOn ? 'OFF' : 'ON' })
      setReloadKey((value) => value + 1)
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Failed to toggle device')
    }
  }

  function openEditDevice(device: SessionDeviceRow): void {
    setEditingDeviceId(device.device_id)
    setEditingDeviceRoomId(device.room_id)
    setEditingDeviceFrontBack(device.location_front_back)
    setEditingDeviceLeftRight(device.location_left_right)
    setEditingDevicePower(String(device.power_consumption_watts ?? 0))
  }

  async function handleUpdateDevice(device: SessionDeviceRow): Promise<void> {
    if (!canManageDevices) {
      setError('You do not have permission to update devices.')
      return
    }

    try {
      await updateRoomDevice(device.room_id, device.device_id, {
        location_front_back: editingDeviceFrontBack,
        location_left_right: editingDeviceLeftRight,
        power_consumption_watts: Number(editingDevicePower) || 0,
      })
      setEditingDeviceId('')
      setEditingDeviceRoomId('')
      setReloadKey((value) => value + 1)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update device')
    }
  }

  async function handleDeleteDevice(device: SessionDeviceRow): Promise<void> {
    if (!canManageDevices) {
      setError('You do not have permission to delete devices.')
      return
    }

    if (!window.confirm('Delete this device? This action cannot be undone.')) {
      return
    }

    try {
      await removeRoomDevice(device.room_id, device.device_id)
      setEditingDeviceId('')
      setEditingDeviceRoomId('')
      setReloadKey((value) => value + 1)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete device')
    }
  }

  async function handleAddDevice(): Promise<void> {
    if (!selectedRoomMeta || selectedRoomId === 'ALL') {
      setCreateDeviceMessage({ type: 'error', text: 'Select a specific room before creating a device.' })
      return
    }

    if (!canManageDevices) {
      setCreateDeviceMessage({ type: 'error', text: 'You do not have permission to add devices.' })
      return
    }

    if (!newDevice.location_front_back || !newDevice.location_left_right) {
      setCreateDeviceMessage({ type: 'error', text: 'Location axis values are required to create a device.' })
      return
    }

    setIsAddingDevice(true)

    try {
      await addRoomDevice(selectedRoomMeta.room.id, {
        device_type: newDevice.device_type,
        location_front_back: newDevice.location_front_back,
        location_left_right: newDevice.location_left_right,
        power_consumption_watts: newDevice.power_consumption_watts,
      })

      setNewDevice(INITIAL_NEW_DEVICE)
      setCreateDeviceMessage({ type: 'success', text: `Device created successfully in room ${selectedRoomMeta.room.room_code}.` })
      setReloadKey((value) => value + 1)
    } catch (createError) {
      setCreateDeviceMessage({
        type: 'error',
        text: createError instanceof Error ? createError.message : 'Failed to create device',
      })
    } finally {
      setIsAddingDevice(false)
    }
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
    if (!selectedRoomMeta || selectedRoomId === 'ALL') {
      return
    }

    if (!canManageThresholds) {
      setThresholdMessage({ type: 'error', text: 'You do not have permission to update room thresholds.' })
      return
    }

    const draft = thresholdDraft[deviceTypeCode]
    if (!draft) {
      return
    }

    setIsSavingThreshold(true)
    setThresholdMessage(null)
    try {
      await updateRoomThreshold(selectedRoomMeta.room.id, deviceTypeCode, {
        min_value: draft.min === '' ? null : Number(draft.min),
        max_value: draft.max === '' ? null : Number(draft.max),
        target_value: draft.target === '' ? null : Number(draft.target),
        enabled: draft.enabled,
      })
      setThresholdMessage({ type: 'success', text: `Room threshold updated for ${deviceTypeCode}.` })
      setReloadKey((value) => value + 1)
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
    if (!canManageThresholds) {
      setThresholdMessage({ type: 'error', text: 'You do not have permission to update global thresholds.' })
      return
    }

    const draft = thresholdDraft[deviceTypeCode]
    if (!draft) {
      return
    }

    setIsSavingThreshold(true)
    setThresholdMessage(null)
    try {
      await updateGlobalThreshold(deviceTypeCode, {
        min_value: draft.min === '' ? null : Number(draft.min),
        max_value: draft.max === '' ? null : Number(draft.max),
        target_value: draft.target === '' ? null : Number(draft.target),
        enabled: draft.enabled,
      })
      setThresholdMessage({ type: 'success', text: `Global threshold updated for ${deviceTypeCode}.` })
      setReloadKey((value) => value + 1)
    } catch (updateError) {
      setThresholdMessage({
        type: 'error',
        text: updateError instanceof Error ? updateError.message : 'Failed to update global threshold',
      })
    } finally {
      setIsSavingThreshold(false)
    }
  }

  const attendanceTotals = attendanceReport?.totals ?? EMPTY_TOTALS
  const showCrudPanel = selectedRoomId !== 'ALL' && selectedRoomMeta !== null
  const selectedBuildingLabel =
    selectedBuildingId === 'ALL'
      ? 'All Buildings'
      : (buildings.find((building) => building.id === selectedBuildingId)?.code ?? 'Building Scope')

  if (isGlobalMode && !canAccessGlobalWorkspace) {
    return (
      <main className="page">
        <section className="panel error-panel">
          Global sessions workspace is only available for System Admin and operations roles.
        </section>
      </main>
    )
  }

  return (
    <AdminBuildingLayout
      buildingId={buildingId}
      title="Current Sessions"
      subtitle={isGlobalMode
        ? 'Room-focused active session monitoring across the campus.'
        : 'Room-focused active session monitoring for the selected building.'}
      eyebrow={isGlobalMode ? 'Campus Command' : 'Building Workspace'}
      showSidebarNav={false}
      showCommandLinks={false}
      wrapSidebarContentPanel={false}
      sidebarContent={(
        <div className="sessions-sidebar-stack">
          <section className="sessions-sidebar-block">
            <p className="sidebar-section-title">Location Filter</p>

            {isGlobalMode ? (
              <div className="filter-group">
                <label htmlFor="sessions-building-filter">Building</label>
                <select
                  id="sessions-building-filter"
                  value={selectedBuildingId}
                  onChange={(event) => handleBuildingChange(event.target.value)}
                >
                  <option value="ALL">All Buildings</option>
                  {buildings.map((building) => (
                    <option key={building.id} value={building.id}>
                      {building.code ?? 'N/A'} | {building.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="filter-group">
              <label htmlFor="sessions-floor-filter">Floor</label>
              <select
                id="sessions-floor-filter"
                value={selectedFloorId}
                onChange={(event) => handleFloorChange(event.target.value)}
                disabled={selectedBuildingId === 'ALL'}
              >
                <option value="ALL">All Floors</option>
                {floorsInScope.map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    F{floor.floor_number} {floor.name ?? ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label htmlFor="sessions-room-filter">Room</label>
              <select
                id="sessions-room-filter"
                value={selectedRoomId}
                onChange={(event) => handleRoomChange(event.target.value)}
                disabled={selectedBuildingId === 'ALL'}
              >
                <option value="ALL">All Rooms</option>
                {roomsInScope.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.room_code} {room.name ?? ''}
                  </option>
                ))}
              </select>
            </div>
          </section>

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
              onChange={(event) => {
                setGraceMinutesDraft(event.target.value)
                setIsGraceDirty(true)
              }}
              disabled={!selectedSessionId || !canManageAttendanceConfig || isSavingConfig}
            />

            <button
              type="button"
              onClick={() => void handleSaveGraceMinutes()}
              disabled={!selectedSessionId || !canManageAttendanceConfig || isSavingConfig}
            >
              {isSavingConfig ? 'Saving...' : 'Save Configuration'}
            </button>

            <p className="muted compact-note">
              Current: Grace {attendanceReport?.grace_minutes ?? 10} min | Confidence {(attendanceReport?.min_confidence ?? 0.75).toFixed(2)}
            </p>

            {configMessage ? (
              <p className={`mini-message ${configMessage.type}`}>{configMessage.text}</p>
            ) : null}
          </section>

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
                <strong>{attendanceTotals.enrolled}</strong>
              </article>
              <article>
                <span>Present</span>
                <strong>{attendanceTotals.present}</strong>
              </article>
              <article>
                <span>Late</span>
                <strong>{attendanceTotals.late}</strong>
              </article>
              <article>
                <span>Absent</span>
                <strong>{attendanceTotals.absent}</strong>
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

            <p className="muted compact-note">
              Updated {formatClock(lastLiveRefreshAt)}
            </p>
          </section>
        </div>
      )}
    >
      {(isStructureLoading || isSessionsLoading) && <section className="panel">Loading sessions...</section>}
      {error ? <section className="panel error-panel">{error}</section> : null}

      <section className="panel sessions-current-panel">
        <div className="section-title-row sessions-current-header">
          <div>
            <h2>Current Sessions</h2>
            <span>{selectedBuildingLabel}</span>
          </div>
          <button type="button" className="archive-btn" disabled>
            View Archive
          </button>
        </div>

        <div className="table-scroll">
          <table className="sessions-current-table">
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Course Name</th>
                <th>Start Time</th>
                <th>End Time</th>
                <th>Teacher</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {visibleSessions.map((session) => {
                const isSelected = selectedSessionId === session.id
                const roomLabel = session.room_code ?? roomMetaById.get(session.room_id)?.room.room_code ?? 'Unknown'
                return (
                  <tr
                    key={session.id}
                    className={isSelected ? 'is-selected' : ''}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <td>
                      <div className="session-id-block">
                        <strong title={session.id}>{session.id.slice(0, 8).toUpperCase()}</strong>
                        <button
                          type="button"
                          className="room-focus-trigger"
                          onClick={(event) => {
                            event.stopPropagation()
                            handleFocusRoom(session)
                          }}
                        >
                          Room: {roomLabel}
                        </button>
                      </div>
                    </td>
                    <td>{session.subject_name ?? '-'}</td>
                    <td>{formatClock(session.start_time)}</td>
                    <td>{formatClock(session.end_time)}</td>
                    <td>{session.teacher_name ?? '-'}</td>
                    <td>
                      <span className={`mode-badge ${session.mode === 'TESTING' ? 'testing' : 'normal'}`}>
                        {session.mode === 'TESTING' ? 'Testing mode' : 'Learning mode'}
                      </span>
                    </td>
                  </tr>
                )
              })}

              {!isStructureLoading && !isSessionsLoading && visibleSessions.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <p className="muted">No active sessions in the selected location scope.</p>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel student-list-panel">
        <div className="section-title-row">
          <h3>Student List</h3>
          <span>{selectedSession ? `Session ${selectedSession.id.slice(0, 8).toUpperCase()}` : 'No session selected'}</span>
        </div>

        {isAttendanceLoading ? (
          <p className="muted">Loading student attendance...</p>
        ) : !selectedSessionId ? (
          <p className="muted">Select a current session to view student attendance status.</p>
        ) : attendanceReport ? (
          <div className="table-scroll">
            <table className="student-list-table">
              <thead>
                <tr>
                  <th>Student Name</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {attendanceReport.students.map((student) => (
                  <tr key={student.student_id}>
                    <td>
                      <div className="student-name-stack">
                        <strong>{student.student_name}</strong>
                        <span>{student.student_code}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`student-status-pill ${student.status.toLowerCase()}`}>
                        {student.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Attendance report is not available for the selected session.</p>
        )}
      </section>

      {viewMode === 'DEVICE_SCREEN' ? (
        <section className="panel device-screen-panel">
          <div className="section-title-row">
            <h3>Device Screen</h3>
            <span>{selectedRoomMeta ? selectedRoomMeta.room.room_code : 'Select a room to view devices'}</span>
          </div>

          {showCrudPanel ? (
            <section className="panel device-subpanel">
              <div className="section-title-row">
                <h3>CRUD Activities Panel</h3>
                <span>Target room: {selectedRoomMeta.room.room_code}</span>
              </div>

              {createDeviceMessage ? (
                <div className={`message-banner ${createDeviceMessage.type}`}>
                  {createDeviceMessage.text}
                </div>
              ) : null}

              <p className="muted">
                {canManageDevices
                  ? 'Toggle, create, edit, and delete actions are available for this room.'
                  : canOnlyToggleDevices
                    ? 'Toggle actions are available. Your current role cannot create, edit, or delete devices.'
                    : 'View-only mode. Your current role does not allow device control actions.'}
              </p>

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
                    setNewDevice((prev) => ({
                      ...prev,
                      power_consumption_watts: Number(event.target.value),
                    }))
                  }
                  placeholder="Power (W)"
                />

                <button
                  type="button"
                  onClick={() => void handleAddDevice()}
                  disabled={!canManageDevices || selectedRoomId === 'ALL' || isAddingDevice}
                  className={isAddingDevice ? 'loading' : ''}
                >
                  {isAddingDevice ? 'Creating...' : 'Create Device'}
                </button>
              </div>
            </section>
          ) : null}

          {selectedRoomId === 'ALL' ? (
            <p className="muted device-screen-empty">Select a room from Current Sessions to load room devices.</p>
          ) : isRoomDevicesLoading ? (
            <p className="muted">Loading room devices...</p>
          ) : roomDevices.length === 0 ? (
            <p className="muted device-screen-empty">No devices were found for the selected room.</p>
          ) : (
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
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {roomDevices.map((device) => {
                    const isOn = (device.status ?? 'OFF').toUpperCase() === 'ON'
                    const isEditing = editingDeviceId === device.device_id && editingDeviceRoomId === device.room_id

                    return (
                      <tr key={device.device_id}>
                        <td>{device.device_id}</td>
                        <td>{device.device_type}</td>
                        <td>
                          {isEditing ? (
                            <div className="inline-filters">
                              <select
                                value={editingDeviceFrontBack}
                                onChange={(event) => setEditingDeviceFrontBack(event.target.value as 'FRONT' | 'BACK')}
                              >
                                <option value="FRONT">FRONT</option>
                                <option value="BACK">BACK</option>
                              </select>
                              <select
                                value={editingDeviceLeftRight}
                                onChange={(event) => setEditingDeviceLeftRight(event.target.value as 'LEFT' | 'RIGHT')}
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
                        <td>{toLocalDateTime(device.last_updated)}</td>
                        <td>
                          <div className="row-actions device-row-actions">
                            <button
                              type="button"
                              onClick={() => void handleToggleDevice(device)}
                              disabled={!canToggleDevices}
                            >
                              Toggle
                            </button>

                            {canManageDevices ? (
                              isEditing ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void handleUpdateDevice(device)}
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingDeviceId('')
                                      setEditingDeviceRoomId('')
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => openEditDevice(device)}
                                >
                                  Edit
                                </button>
                              )
                            ) : null}

                            {canManageDevices ? (
                              <button
                                type="button"
                                onClick={() => void handleDeleteDevice(device)}
                              >
                                Delete
                              </button>
                            ) : null}
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
      ) : (
        <section className="panel mode-screen-panel">
          <div className="section-title-row">
            <h3>Mode Screen</h3>
            <span>{selectedSession ? selectedSession.mode : 'No active session selected'}</span>
          </div>

          {!selectedSession ? (
            <p className="muted">Select an active session to view mode details.</p>
          ) : (
            <div className="mode-screen-grid">
              <article>
                <span>Session</span>
                <strong>{selectedSession.id.slice(0, 8).toUpperCase()}</strong>
              </article>
              <article>
                <span>Room</span>
                <strong>{selectedSession.room_code ?? selectedRoomMeta?.room.room_code ?? '-'}</strong>
              </article>
              <article>
                <span>Mode</span>
                <strong>{selectedSession.mode}</strong>
              </article>
              <article>
                <span>Status</span>
                <strong>{selectedSession.status}</strong>
              </article>
              <article>
                <span>Start</span>
                <strong>{formatClock(selectedSession.start_time)}</strong>
              </article>
              <article>
                <span>End</span>
                <strong>{formatClock(selectedSession.end_time)}</strong>
              </article>
            </div>
          )}
        </section>
      )}

      {viewMode === 'DEVICE_SCREEN' && selectedRoomId !== 'ALL' ? (
        <section className="panel device-threshold-standalone">
          <div className="section-title-row">
            <h3>Device Readings &amp; Thresholds</h3>
            <span>{selectedRoomMeta ? selectedRoomMeta.room.room_code : 'Selected room'}</span>
          </div>

          <p className="muted">
            Current sensor readings and effective thresholds. Edit values, then save to room scope or global scope.
          </p>

          {thresholdMessage ? (
            <div className={`message-banner ${thresholdMessage.type}`}>
              {thresholdMessage.text}
            </div>
          ) : null}

          {isThresholdPanelLoading ? (
            <p className="muted">Loading readings and thresholds...</p>
          ) : deviceThresholdRows.length === 0 ? (
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
                            disabled={!canManageThresholds || isSavingThreshold}
                          />
                        </td>
                        <td>
                          <input
                            className="threshold-input"
                            type="number"
                            value={draft.target}
                            onChange={(event) => handleThresholdDraftChange(row.deviceTypeCode, 'target', event.target.value)}
                            disabled={!canManageThresholds || isSavingThreshold}
                          />
                        </td>
                        <td>
                          <input
                            className="threshold-input"
                            type="number"
                            value={draft.max}
                            onChange={(event) => handleThresholdDraftChange(row.deviceTypeCode, 'max', event.target.value)}
                            disabled={!canManageThresholds || isSavingThreshold}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={draft.enabled}
                            onChange={(event) => handleThresholdDraftChange(row.deviceTypeCode, 'enabled', event.target.checked)}
                            disabled={!canManageThresholds || isSavingThreshold}
                          />
                        </td>
                        <td>{row.source}</td>
                        <td>
                          <div className="row-actions threshold-row-actions">
                            <button
                              type="button"
                              onClick={() => void handleSaveRoomThreshold(row.deviceTypeCode)}
                              disabled={!canManageThresholds || isSavingThreshold}
                            >
                              Save Room
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleSaveGlobalThreshold(row.deviceTypeCode)}
                              disabled={!canManageThresholds || isSavingThreshold}
                            >
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
          )}
        </section>
      ) : null}
    </AdminBuildingLayout>
  )
}
