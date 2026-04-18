import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  getBuildingsOverview,
  getBuildingFloors,
  getFloorRooms,
  getSessionAttendanceReport,
  getSessions,
  updateAttendanceConfig,
} from '../services/api'
import type { AttendanceSessionReport, FloorSummary, RoomSummary, SessionSummary } from '../types'
import { AdminBuildingLayout } from '../components/AdminBuildingLayout'
import { AttendanceLivePanel } from '../components/AttendanceLivePanel'
import { useAuthStore } from '../store/auth'
import { resolveBuildingFromRouteParam } from '../utils/buildingRoute'

export function BuildingAttendancePage(): JSX.Element {
  const { buildingId } = useParams<{ buildingId: string }>()
  const currentRole = useAuthStore((state) => state.user?.role ?? null)
  const canManageAttendanceConfig = currentRole === 'LECTURER' || currentRole === 'SYSTEM_ADMIN'

  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [report, setReport] = useState<AttendanceSessionReport | null>(null)

  const [selectedFloorId, setSelectedFloorId] = useState<string>('ALL')
  const [selectedRoomId, setSelectedRoomId] = useState<string>('ALL')
  const [selectedSessionId, setSelectedSessionId] = useState<string>('')
  const [graceMinutesDraft, setGraceMinutesDraft] = useState<string>('10')

  const [isStructureLoading, setIsStructureLoading] = useState(true)
  const [isSessionsLoading, setIsSessionsLoading] = useState(true)
  const [isReportLoading, setIsReportLoading] = useState(false)
  const [isSavingConfig, setIsSavingConfig] = useState(false)
  const [resolvedBuildingId, setResolvedBuildingId] = useState<string | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [configMessage, setConfigMessage] = useState<string | null>(null)

  const filteredRooms = useMemo(() => {
    if (selectedFloorId === 'ALL') {
      return rooms
    }
    return rooms.filter((room) => room.floor_id === selectedFloorId)
  }, [rooms, selectedFloorId])

  const availableSessions = useMemo(() => {
    return sessions.filter((session) => selectedRoomId === 'ALL' || session.room_id === selectedRoomId)
  }, [selectedRoomId, sessions])

  useEffect(() => {
    if (selectedRoomId === 'ALL') return

    const roomStillVisible = filteredRooms.some((room) => room.id === selectedRoomId)
    if (!roomStillVisible) {
      setSelectedRoomId('ALL')
    }
  }, [filteredRooms, selectedRoomId])

  useEffect(() => {
    if (!selectedSessionId) return

    const sessionStillVisible = availableSessions.some((session) => session.id === selectedSessionId)
    if (!sessionStillVisible) {
      setSelectedSessionId(availableSessions[0]?.id ?? '')
    }
  }, [availableSessions, selectedSessionId])

  useEffect(() => {
    let isMounted = true

    async function loadStructure(): Promise<void> {
      if (!buildingId) {
        return
      }

      setIsStructureLoading(true)
      setError(null)

      try {
        const buildingData = await getBuildingsOverview()
        const resolvedBuilding = resolveBuildingFromRouteParam(buildingData, buildingId)
        if (!resolvedBuilding) {
          throw new Error('Building not found for this route')
        }

        const floorData = await getBuildingFloors(resolvedBuilding.id)
        const roomsByFloor = await Promise.all(
          floorData.map(async (floor) => getFloorRooms(resolvedBuilding.id, floor.id)),
        )

        if (!isMounted) return

        setResolvedBuildingId(resolvedBuilding.id)
        setFloors(floorData)
        setRooms(roomsByFloor.flat())
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
  }, [buildingId])

  const roomIdsInBuilding = useMemo(() => rooms.map((room) => room.id), [rooms])

  useEffect(() => {
    let isMounted = true

    async function loadSessions(): Promise<void> {
      if (!resolvedBuildingId || roomIdsInBuilding.length === 0) {
        setSessions([])
        setSelectedSessionId('')
        setIsSessionsLoading(false)
        return
      }

      setIsSessionsLoading(true)
      setError(null)

      try {
        const activeSessions = await getSessions({ status_filter: 'ACTIVE' })
        if (!isMounted) return

        const buildingSessions = activeSessions.filter((session) => roomIdsInBuilding.includes(session.room_id))
        setSessions(buildingSessions)
        setSelectedSessionId((current) => {
          if (current && buildingSessions.some((session) => session.id === current)) {
            return current
          }
          return buildingSessions[0]?.id ?? ''
        })
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
  }, [resolvedBuildingId, roomIdsInBuilding])

  useEffect(() => {
    let isMounted = true

    async function loadAttendanceReport(): Promise<void> {
      if (!selectedSessionId) {
        setReport(null)
        return
      }

      setIsReportLoading(true)
      setError(null)
      setConfigMessage(null)

      try {
        const attendance = await getSessionAttendanceReport(selectedSessionId)
        if (!isMounted) return

        setReport(attendance)
        setGraceMinutesDraft(String(attendance.grace_minutes))
      } catch (loadError) {
        if (!isMounted) return
        setReport(null)
        setError(loadError instanceof Error ? loadError.message : 'Failed to load attendance report')
      } finally {
        if (isMounted) {
          setIsReportLoading(false)
        }
      }
    }

    void loadAttendanceReport()

    return () => {
      isMounted = false
    }
  }, [selectedSessionId])

  async function handleSaveGraceMinutes(): Promise<void> {
    if (!selectedSessionId || !report || !canManageAttendanceConfig) {
      return
    }

    const parsedGraceMinutes = Number(graceMinutesDraft)
    if (!Number.isInteger(parsedGraceMinutes) || parsedGraceMinutes < 0 || parsedGraceMinutes > 90) {
      setConfigMessage('Grace minutes must be an integer between 0 and 90.')
      return
    }

    setIsSavingConfig(true)
    setConfigMessage(null)

    try {
      await updateAttendanceConfig(selectedSessionId, {
        grace_minutes: parsedGraceMinutes,
        min_confidence: report.min_confidence,
        auto_checkin_enabled: true,
      })

      const refreshed = await getSessionAttendanceReport(selectedSessionId)
      setReport(refreshed)
      setGraceMinutesDraft(String(refreshed.grace_minutes))
      setConfigMessage('Attendance grace time updated successfully.')
    } catch (saveError) {
      setConfigMessage(saveError instanceof Error ? saveError.message : 'Failed to update attendance config')
    } finally {
      setIsSavingConfig(false)
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
    <AdminBuildingLayout
      buildingId={buildingId}
      title="Attendance"
      subtitle="Monitor attendance status and session check-in configuration by room."
      metrics={[
        { label: 'Present', value: report?.totals.present ?? 0, tone: 'safe' },
        { label: 'Late', value: report?.totals.late ?? 0, tone: 'warn' },
        { label: 'Absent', value: report?.totals.absent ?? 0, tone: (report?.totals.absent ?? 0) > 0 ? 'danger' : 'neutral' },
      ]}
      sidebarContent={(
        <>
          <div className="filter-group">
            <label htmlFor="attendance-floor-filter">Floor</label>
            <select
              id="attendance-floor-filter"
              value={selectedFloorId}
              onChange={(event) => setSelectedFloorId(event.target.value)}
            >
              <option value="ALL">All Floors</option>
              {floors.map((floor) => (
                <option key={floor.id} value={floor.id}>
                  F{floor.floor_number} {floor.name ?? ''}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="attendance-room-filter">Room</label>
            <select
              id="attendance-room-filter"
              value={selectedRoomId}
              onChange={(event) => setSelectedRoomId(event.target.value)}
            >
              <option value="ALL">All Rooms</option>
              {filteredRooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.room_code} {room.name ?? ''}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="attendance-session-filter">Session</label>
            <select
              id="attendance-session-filter"
              value={selectedSessionId}
              onChange={(event) => setSelectedSessionId(event.target.value)}
            >
              <option value="">Select Session</option>
              {availableSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.room_code ?? '-'} | {session.mode} | {session.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>

          {canManageAttendanceConfig ? (
            <>
              <div className="filter-group">
                <label htmlFor="attendance-grace-input">Grace Minutes (0-90)</label>
                <input
                  id="attendance-grace-input"
                  type="number"
                  min={0}
                  max={90}
                  step={1}
                  value={graceMinutesDraft}
                  onChange={(event) => setGraceMinutesDraft(event.target.value)}
                  disabled={!selectedSessionId || isSavingConfig}
                />
              </div>
              <button
                type="button"
                onClick={() => void handleSaveGraceMinutes()}
                disabled={!selectedSessionId || isSavingConfig}
              >
                {isSavingConfig ? 'Saving...' : 'Save Configuration'}
              </button>
            </>
          ) : null}

          {configMessage ? <p className="muted">{configMessage}</p> : null}
        </>
      )}
    >
      {(isStructureLoading || isSessionsLoading || isReportLoading) && <section className="panel">Loading attendance data...</section>}
      {error ? <section className="panel error-panel">{error}</section> : null}

      {!selectedSessionId ? (
        <section className="panel">
          <p className="muted">Select an active session from the left sidebar to view attendance details.</p>
        </section>
      ) : (
        <>
          {report ? (
            <section className="panel">
              <div className="section-title-row">
                <h2>Session Attendance Report</h2>
                <span>{report.session_id.slice(0, 8)}</span>
              </div>

              <p className="muted">
                Enrolled: {report.totals.enrolled} | Present: {report.totals.present} | Late: {report.totals.late} | Absent: {report.totals.absent}
              </p>

              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Status</th>
                      <th>First Seen</th>
                      <th>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.students.map((student) => (
                      <tr key={student.student_id}>
                        <td>
                          {student.student_name} ({student.student_code})
                        </td>
                        <td>{student.status}</td>
                        <td>{student.first_seen_at ?? '-'}</td>
                        <td>{student.confidence == null ? '-' : student.confidence.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <AttendanceLivePanel sessionId={selectedSessionId} />
        </>
      )}
    </AdminBuildingLayout>
  )
}
