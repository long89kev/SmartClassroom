import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  BarChart3,
  Camera,
  ChevronLeft,
  Fan,
  Flame,
  Lightbulb,
  ListFilter,
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
  getBuildingFloors,
  getFloorRooms,
  getIncidents,
  getRoomDevices,
  getLatestSessionFrame,
  getRoomDeviceStates,
  getSessionAnalytics,
  getSessions,
  removeRoomDevice,
  reviewIncident,
  toggleDevice,
  updateRoomDevice,
} from '../services/api'
import type {
  DeviceCreatePayload,
  FloorSummary,
  Incident,
  LatestFrameResponse,
  RoomDeviceInventoryItem,
  RoomSummary,
  SessionAnalytics,
  SessionSummary,
} from '../types'
import { timeAgo, toLocalDateTime } from '../utils/time'

type ModeFilter = 'NORMAL' | 'TESTING'
type SeverityFilter = 'ALL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
type LeaderboardMetric = 'RISK' | 'PERFORMANCE'
type SceneName = 'EXAM' | 'LECTURE' | 'BREAK'
type DashboardView = 'DEVICES' | 'MODE'

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

function sceneAction(scene: SceneName, deviceType: string): 'ON' | 'OFF' {
  const normalized = deviceType.toUpperCase()

  if (scene === 'BREAK') return 'OFF'
  if (scene === 'EXAM') {
    if (normalized === 'LIGHT' || normalized === 'AC') return 'ON'
    return 'OFF'
  }

  if (normalized === 'LIGHT' || normalized === 'FAN') return 'ON'
  return 'OFF'
}

export function BuildingDashboardPage(): JSX.Element {
  const { buildingId } = useParams<{ buildingId: string }>()

  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [analytics, setAnalytics] = useState<SessionAnalytics | null>(null)
  const [latestFrame, setLatestFrame] = useState<LatestFrameResponse | null>(null)
  const [deviceStates, setDeviceStates] = useState<Array<{ device_id: string; device_type: string; status: string }>>([])
  const [deviceInventory, setDeviceInventory] = useState<RoomDeviceInventoryItem[]>([])

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
  const [editingDeviceFrontBack, setEditingDeviceFrontBack] = useState<'FRONT' | 'BACK'>('FRONT')
  const [editingDeviceLeftRight, setEditingDeviceLeftRight] = useState<'LEFT' | 'RIGHT'>('LEFT')
  const [editingDevicePower, setEditingDevicePower] = useState<string>('0')
  const [deviceSearch, setDeviceSearch] = useState<string>('')
  const [deviceTypeFilter, setDeviceTypeFilter] = useState<string>('ALL')
  const [deviceLocationFilter, setDeviceLocationFilter] = useState<string>('ALL')

  const [isStructureLoading, setIsStructureLoading] = useState(true)
  const [isLiveLoading, setIsLiveLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const filteredRooms = useMemo(() => {
    if (selectedFloorId === 'ALL') return rooms
    return rooms.filter((room) => room.floor_id === selectedFloorId)
  }, [rooms, selectedFloorId])

  const roomIdsInBuilding = useMemo(() => rooms.map((room) => room.id), [rooms])

  const visibleSessions = useMemo(() => {
    const sessionsInBuilding = sessions.filter((session) => roomIdsInBuilding.includes(session.room_id))

    return sessionsInBuilding.filter((session) => {
      const roomMatch = selectedRoomId === 'ALL' || session.room_id === selectedRoomId
      const modeMatch = session.mode === modeFilter
      return roomMatch && modeMatch
    })
  }, [sessions, roomIdsInBuilding, selectedRoomId, modeFilter])

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  )

  const selectedRoom = useMemo(
    () => (selectedRoomId === 'ALL' ? null : rooms.find((room) => room.id === selectedRoomId) ?? null),
    [rooms, selectedRoomId],
  )

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
  }, [buildingId, selectedRoomId])

  useEffect(() => {
    let isMounted = true

    async function loadLiveData(): Promise<void> {
      if (!buildingId) return

      setIsLiveLoading(true)
      try {
        const sessionParams: { mode?: 'NORMAL' | 'TESTING'; status_filter?: 'ACTIVE' } = {
          status_filter: 'ACTIVE',
          mode: modeFilter,
        }

        const sessionData = await getSessions(sessionParams)
        if (!isMounted) return

        const buildingSessionData = sessionData.filter((session) => roomIdsInBuilding.includes(session.room_id))
        setSessions(buildingSessionData)

        const hasSelectedSession = buildingSessionData.some((session) => session.id === selectedSessionId)
        const nextSessionId = hasSelectedSession
          ? selectedSessionId
          : (buildingSessionData[0]?.id ?? '')

        if (nextSessionId !== selectedSessionId) {
          setSelectedSessionId(nextSessionId)
        }

        const incidentData = await getIncidents(selectedRoomId === 'ALL' ? undefined : { room_id: selectedRoomId })
        if (!isMounted) return

        setIncidents(
          incidentData.filter((incident) =>
            selectedRoomId === 'ALL'
              ? buildingSessionData.some((session) => session.id === incident.session_id)
              : true,
          ),
        )

        if (nextSessionId) {
          const [analyticsData, frameData] = await Promise.all([
            getSessionAnalytics(nextSessionId),
            getLatestSessionFrame(nextSessionId),
          ])
          if (!isMounted) return
          setAnalytics(analyticsData)
          setLatestFrame(frameData)
        } else {
          setAnalytics(null)
          setLatestFrame(null)
        }

        if (selectedRoomId !== 'ALL') {
          const [roomDeviceData, roomInventoryData] = await Promise.all([
            getRoomDeviceStates(selectedRoomId),
            getRoomDevices(selectedRoomId),
          ])
          if (!isMounted) return
          setDeviceStates(roomDeviceData.device_states)
          setDeviceInventory(roomInventoryData.devices)
        } else {
          setDeviceStates([])
          setDeviceInventory([])
        }
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to refresh dashboard data')
      } finally {
        if (isMounted) setIsLiveLoading(false)
      }
    }

    void loadLiveData()

    const refreshMs = modeFilter === 'TESTING' ? 2000 : 30000
    const intervalId = window.setInterval(() => {
      void loadLiveData()
    }, refreshMs)

    return () => {
      isMounted = false
      window.clearInterval(intervalId)
    }
  }, [buildingId, modeFilter, roomIdsInBuilding, selectedRoomId, selectedSession?.mode, selectedSessionId])

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
    const [roomDeviceData, roomInventoryData] = await Promise.all([
      getRoomDeviceStates(roomId),
      getRoomDevices(roomId),
    ])
    setDeviceStates(roomDeviceData.device_states)
    setDeviceInventory(roomInventoryData.devices)
  }

  async function handleToggleSingleDevice(deviceId: string, nextStatus: 'ON' | 'OFF'): Promise<void> {
    if (!selectedRoom) return
    try {
      await toggleDevice(selectedRoom.id, deviceId, { action: nextStatus })
      await refreshDevices(selectedRoom.id)
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Failed to toggle device')
    }
  }

  async function handleAddDevice(): Promise<void> {
    if (!selectedRoom) return
    if (!newDevice.location_front_back || !newDevice.location_left_right) {
      setError('Location axis values are required to add a device.')
      return
    }

    try {
      await addRoomDevice(selectedRoom.id, {
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
      await refreshDevices(selectedRoom.id)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to add device')
    }
  }

  async function handleUpdateDevice(deviceId: string): Promise<void> {
    if (!selectedRoom) return

    try {
      await updateRoomDevice(selectedRoom.id, deviceId, {
        location_front_back: editingDeviceFrontBack,
        location_left_right: editingDeviceLeftRight,
        power_consumption_watts: Number(editingDevicePower) || 0,
      })
      setEditingDeviceId('')
      await refreshDevices(selectedRoom.id)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update device')
    }
  }

  async function handleDeleteDevice(deviceId: string): Promise<void> {
    if (!selectedRoom) return

    try {
      await removeRoomDevice(selectedRoom.id, deviceId)
      await refreshDevices(selectedRoom.id)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete device')
    }
  }

  function openEditDevice(device: RoomDeviceInventoryItem): void {
    setEditingDeviceId(device.device_id)
    setEditingDeviceFrontBack(device.location_front_back)
    setEditingDeviceLeftRight(device.location_left_right)
    setEditingDevicePower(String(device.power_consumption_watts ?? 0))
  }

  async function handleIncidentAction(incidentId: string, action: 'ACK' | 'DISMISS'): Promise<void> {
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
    try {
      await changeSessionMode(selectedSessionId, mode)
      setSessions((prev) => prev.map((session) => (session.id === selectedSessionId ? { ...session, mode } : session)))
    } catch (modeError) {
      setError(modeError instanceof Error ? modeError.message : 'Failed to change session mode')
    }
  }

  async function handleEndSession(): Promise<void> {
    if (!selectedSessionId) return
    try {
      await endSession(selectedSessionId)
      setSessions((prev) => prev.map((session) => (session.id === selectedSessionId ? { ...session, status: 'COMPLETED' } : session)))
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : 'Failed to end session')
    }
  }

  async function handleScene(scene: SceneName): Promise<void> {
    if (!selectedRoom) return

    try {
      await Promise.all(
        deviceStates.map(async (device) =>
          toggleDevice(selectedRoom.id, device.device_id, {
            action: sceneAction(scene, device.device_type),
          }),
        ),
      )

      setDeviceStates((prev) =>
        prev.map((device) => ({
          ...device,
          status: sceneAction(scene, device.device_type),
        })),
      )
      setDeviceInventory((prev) =>
        prev.map((device) => ({
          ...device,
          status: sceneAction(scene, device.device_type),
        })),
      )
    } catch (sceneError) {
      setError(sceneError instanceof Error ? sceneError.message : 'Failed to apply scene action')
    }
  }

  if (!buildingId) {
    return (
      <main className="page">
        <section className="panel error-panel">Missing building id in route.</section>
      </main>
    )
  }

  return (
    <main className="page split-layout campus-bg">
      <aside className="left-sidebar panel">
        <div className="sidebar-header">
          <Link to="/" className="inline-link">
            <ChevronLeft size={16} />
            Back to Building Grid
          </Link>
          <h1>Building Dashboard</h1>
        </div>

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

        <div className="filter-group">
          <label htmlFor="screen-filter">Dashboard Screen</label>
          <select
            id="screen-filter"
            value={dashboardView}
            onChange={(event) => setDashboardView(event.target.value as DashboardView)}
          >
            <option value="DEVICES">Device Main Screen</option>
            <option value="MODE">Mode Info Screen</option>
          </select>
        </div>

        <div className="sidebar-note">
          <ListFilter size={16} />
          <p>
            Choose screen from this dropdown. Mode selection is configured inside Mode Info Screen.
          </p>
        </div>
      </aside>

      <section className="right-content">
        {(isStructureLoading || isLiveLoading) && <section className="panel">Refreshing dashboard data...</section>}
        {error && <section className="panel error-panel">{error}</section>}

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

        <section className="panel">
          <div className="section-title-row">
            <h2>Sessions Table</h2>
            <span>{visibleSessions.length} records</span>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Start Time</th>
                  <th>Risk Alerts</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {visibleSessions.map((session) => (
                  <tr key={session.id} className={selectedSessionId === session.id ? 'selected-row' : ''}>
                    <td>{session.room_code || '-'}</td>
                    <td>{session.mode}</td>
                    <td>{session.status}</td>
                    <td>{toLocalDateTime(session.start_time)}</td>
                    <td>{session.risk_alerts_count}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedSessionId(session.id)
                            setSelectedRoomId(session.room_id)
                            setDashboardView('DEVICES')
                          }}
                        >
                          Open Devices
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedSessionId(session.id)
                            setSelectedRoomId(session.room_id)
                            setDashboardView('MODE')
                          }}
                        >
                          Mode Screen
                        </button>
                        <Link to={`/sessions/${session.id}`}>Open Route</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {dashboardView === 'DEVICES' ? (
          <>
            <section className="panel">
              <div className="section-title-row">
                <h2>2D Classroom Device View</h2>
                <span>{selectedRoom?.room_code ?? 'Select room'}</span>
              </div>

              <div className="scene-buttons">
                <button type="button" onClick={() => void handleScene('EXAM')}>
                  <Flame size={14} /> Exam Scene
                </button>
                <button type="button" onClick={() => void handleScene('LECTURE')}>
                  <Lightbulb size={14} /> Lecture Scene
                </button>
                <button type="button" onClick={() => void handleScene('BREAK')}>
                  <Fan size={14} /> Break Scene
                </button>
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
                      onClick={() => void handleToggleSingleDevice(device.device_id, isOn ? 'OFF' : 'ON')}
                      title={`${device.device_type} - ${device.location}`}
                    >
                      <span>{device.device_type}</span>
                      <strong>{device.device_id}</strong>
                    </button>
                  )
                })}
              </div>

              <div className="section-title-row">
                <h2>Device CRUD (Below 2D View)</h2>
                <span>{filteredDevices.length} / {mergedDevices.length} devices</span>
              </div>

              <div className="inline-filters">
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

              <div className="device-create-grid">
                <select
                  value={newDevice.device_type}
                  onChange={(event) => setNewDevice((prev) => ({ ...prev, device_type: event.target.value }))}
                >
                  <option value="LIGHT">LIGHT</option>
                  <option value="AC">AC</option>
                  <option value="FAN">FAN</option>
                  <option value="PROJECTOR">PROJECTOR</option>
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
                <button type="button" onClick={() => void handleAddDevice()} disabled={!selectedRoom}>
                  Create Device
                </button>
              </div>

              <div className="table-scroll">
                <table>
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
                                onClick={() => void handleToggleSingleDevice(device.device_id, isOn ? 'OFF' : 'ON')}
                                disabled={!selectedRoom}
                              >
                                Toggle
                              </button>
                              {isEditing ? (
                                <button type="button" onClick={() => void handleUpdateDevice(device.device_id)}>
                                  Save
                                </button>
                              ) : (
                                <button type="button" onClick={() => openEditDevice(device)}>
                                  Edit
                                </button>
                              )}
                              <button type="button" onClick={() => void handleDeleteDevice(device.device_id)}>
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
            </section>

            <section className="panel">
              <div className="section-title-row">
                <h2>Mode Controls</h2>
                <span>{selectedSession?.mode ?? 'No session selected'}</span>
              </div>
              <div className="row-actions session-actions">
                <button
                  type="button"
                  onClick={() => {
                    setModeFilter('NORMAL')
                    void handleSessionModeChange('NORMAL')
                    setDashboardView('MODE')
                  }}
                  disabled={!selectedSessionId}
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
                  disabled={!selectedSessionId}
                >
                  Activate Testing Mode Screen
                </button>
                <button type="button" onClick={() => void handleEndSession()} disabled={!selectedSessionId}>
                  End Session
                </button>
              </div>
            </section>
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
                    const nextMode = event.target.value as ModeFilter
                    setModeFilter(nextMode)
                    if (selectedSessionId) {
                      void handleSessionModeChange(nextMode)
                    }
                  }}
                >
                  <option value="NORMAL">Learning Mode</option>
                  <option value="TESTING">Testing Mode</option>
                </select>
                <button type="button" onClick={() => setDashboardView('DEVICES')}>
                  Back To Device Main Screen
                </button>
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
                                  onChange={(event) =>
                                    setReviewNotes((prev) => ({ ...prev, [incident.id]: event.target.value }))
                                  }
                                />
                                <div className="row-actions">
                                  <button type="button" onClick={() => void handleIncidentAction(incident.id, 'ACK')}>
                                    Acknowledge
                                  </button>
                                  <button type="button" onClick={() => void handleIncidentAction(incident.id, 'DISMISS')}>
                                    Dismiss
                                  </button>
                                </div>
                              </>
                            ) : (
                              <p className="muted">Reviewed: {incident.reviewer_notes ?? 'No note'}</p>
                            )}
                          </article>
                        )
                      })}
                    </div>
                  </article>

                  <article className="panel">
                    <div className="section-title-row">
                      <h2>Annotated Frame Preview</h2>
                      <span>{latestFrame?.source ?? 'none'}</span>
                    </div>

                    {latestFrame?.image_base64 ? (
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
