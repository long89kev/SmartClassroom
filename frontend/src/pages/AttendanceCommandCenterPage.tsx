import { useEffect, useMemo, useState } from 'react'
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
  exportAttendanceDashboard,
  getAttendanceDashboardBreakdown,
  getAttendanceDashboardKpis,
  getAttendanceDashboardRankings,
  getAttendanceDashboardTrend,
  getBuildingsOverview,
  getBuildingFloors,
  getFloorRooms,
  getSessions,
} from '../services/api'
import type {
  AttendanceDashboardDimension,
  AttendanceDashboardFilters,
  AttendanceDashboardKpis,
  AttendanceDashboardPoint,
  AttendanceDashboardRankingRow,
  AttendanceDashboardRankingScope,
  AttendanceDashboardTrendGranularity,
  BuildingOverview,
  FloorSummary,
  RoomSummary,
  SessionSummary,
} from '../types'
import { AdminBuildingLayout } from '../components/AdminBuildingLayout'

const DEFAULT_KPIS: AttendanceDashboardKpis = {
  enrolled: 0,
  present: 0,
  late: 0,
  absent: 0,
  attendance_rate: 0,
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function toDateInputValue(offsetDays = 0): string {
  const now = new Date()
  now.setDate(now.getDate() + offsetDays)
  return now.toISOString().slice(0, 10)
}

export function AttendanceCommandCenterPage(): JSX.Element {
  const [buildings, setBuildings] = useState<BuildingOverview[]>([])
  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [subjects, setSubjects] = useState<Array<{ id: string; label: string }>>([])

  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('ALL')
  const [selectedFloorId, setSelectedFloorId] = useState<string>('ALL')
  const [selectedRoomId, setSelectedRoomId] = useState<string>('ALL')
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('ALL')
  const [selectedSessionId, setSelectedSessionId] = useState<string>('ALL')
  const [selectedDayOfWeek, setSelectedDayOfWeek] = useState<string>('ALL')
  const [startDate, setStartDate] = useState<string>(toDateInputValue(-14))
  const [endDate, setEndDate] = useState<string>(toDateInputValue(0))

  const [breakdownDimension, setBreakdownDimension] = useState<AttendanceDashboardDimension>('day_of_week')
  const [trendGranularity, setTrendGranularity] = useState<AttendanceDashboardTrendGranularity>('weekday')
  const [rankingScope, setRankingScope] = useState<AttendanceDashboardRankingScope>('session')

  const [kpis, setKpis] = useState<AttendanceDashboardKpis>(DEFAULT_KPIS)
  const [breakdownData, setBreakdownData] = useState<AttendanceDashboardPoint[]>([])
  const [trendData, setTrendData] = useState<AttendanceDashboardPoint[]>([])
  const [rankingRows, setRankingRows] = useState<AttendanceDashboardRankingRow[]>([])

  const [isLoading, setIsLoading] = useState(true)
  const [isExporting, setIsExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const roomOptions = useMemo(() => {
    if (selectedFloorId === 'ALL') {
      return rooms
    }
    return rooms.filter((room) => room.floor_id === selectedFloorId)
  }, [rooms, selectedFloorId])

  const sessionOptions = useMemo(() => {
    if (selectedRoomId === 'ALL') {
      return sessions
    }
    return sessions.filter((session) => session.room_id === selectedRoomId)
  }, [sessions, selectedRoomId])

  const selectedBuildingLabel = useMemo(() => {
    if (selectedBuildingId === 'ALL') {
      return 'School-Wide'
    }
    const building = buildings.find((item) => item.id === selectedBuildingId)
    return building?.code ?? building?.name ?? 'Selected Building'
  }, [buildings, selectedBuildingId])

  const dashboardFilters = useMemo<AttendanceDashboardFilters>(() => {
    return {
      start_date: startDate,
      end_date: endDate,
      building_id: selectedBuildingId === 'ALL' ? undefined : selectedBuildingId,
      room_id: selectedRoomId === 'ALL' ? undefined : selectedRoomId,
      subject_id: selectedSubjectId === 'ALL' ? undefined : selectedSubjectId,
      session_id: selectedSessionId === 'ALL' ? undefined : selectedSessionId,
      day_of_week: selectedDayOfWeek === 'ALL' ? undefined : Number(selectedDayOfWeek),
    }
  }, [endDate, selectedBuildingId, selectedDayOfWeek, selectedRoomId, selectedSessionId, selectedSubjectId, startDate])

  useEffect(() => {
    let isMounted = true

    async function loadStructure(): Promise<void> {
      setError(null)
      try {
        const buildingData = await getBuildingsOverview()
        if (!isMounted) return

        setBuildings(buildingData)

        const floorsByBuilding = await Promise.all(buildingData.map(async (building) => getBuildingFloors(building.id)))
        if (!isMounted) return

        const allFloors = floorsByBuilding.flat()
        setFloors(allFloors)

        const roomsByFloor = await Promise.all(
          buildingData.flatMap((building, index) =>
            floorsByBuilding[index].map(async (floor) => getFloorRooms(building.id, floor.id)),
          ),
        )
        if (!isMounted) return

        const allRooms = roomsByFloor.flat()
        setRooms(allRooms)

        const activeSessions = await getSessions({ status_filter: 'ACTIVE' })
        if (!isMounted) return

        setSessions(activeSessions)

        const subjectMap = new Map<string, string>()
        activeSessions.forEach((session) => {
          if (session.subject_id) {
            const label = session.subject_name ?? session.subject_id
            subjectMap.set(session.subject_id, label)
          }
        })
        setSubjects(Array.from(subjectMap.entries()).map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)))
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load attendance command center metadata')
      }
    }

    void loadStructure()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    async function loadDashboard(): Promise<void> {
      setIsLoading(true)
      setError(null)

      try {
        const [kpiPayload, breakdownPayload, trendPayload, rankingPayload] = await Promise.all([
          getAttendanceDashboardKpis(dashboardFilters),
          getAttendanceDashboardBreakdown(dashboardFilters, breakdownDimension),
          getAttendanceDashboardTrend(dashboardFilters, trendGranularity),
          getAttendanceDashboardRankings(dashboardFilters, rankingScope),
        ])

        if (!isMounted) return

        setKpis(kpiPayload)
        setBreakdownData(breakdownPayload.points)
        setTrendData(trendPayload.points)
        setRankingRows(rankingPayload.rows)
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load school-wide attendance dashboard')
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    void loadDashboard()

    return () => {
      isMounted = false
    }
  }, [dashboardFilters, breakdownDimension, trendGranularity, rankingScope])

  async function handleExport(format: 'xlsx' | 'csv'): Promise<void> {
    setIsExporting(true)
    setError(null)

    try {
      const blob = await exportAttendanceDashboard(dashboardFilters, format)
      const extension = format === 'xlsx' ? 'xlsx' : 'csv'
      downloadBlob(blob, `attendance-command-center-${startDate}-${endDate}.${extension}`)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Failed to export attendance dashboard')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <AdminBuildingLayout
      title="Attendance Command Center"
      subtitle="School-wide attendance intelligence for board-level monitoring and decision support."
      eyebrow="Campus Command"
      metrics={[
        { label: 'Enrolled', value: kpis.enrolled, tone: 'neutral' },
        { label: 'Present', value: kpis.present, tone: 'safe' },
        { label: 'Late', value: kpis.late, tone: 'warn' },
        { label: 'Absent', value: kpis.absent, tone: kpis.absent > 0 ? 'danger' : 'neutral' },
        { label: 'Attendance Rate', value: `${kpis.attendance_rate.toFixed(1)}%`, tone: kpis.attendance_rate >= 85 ? 'safe' : 'warn' },
      ]}
      sidebarContent={(
        <>
          <div className="filter-group">
            <label htmlFor="attendance-school-building">Building</label>
            <select id="attendance-school-building" value={selectedBuildingId} onChange={(event) => setSelectedBuildingId(event.target.value)}>
              <option value="ALL">All Buildings</option>
              {buildings.map((building) => (
                <option key={building.id} value={building.id}>
                  {building.code ?? 'N/A'} | {building.name}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="attendance-school-floor">Floor</label>
            <select id="attendance-school-floor" value={selectedFloorId} onChange={(event) => setSelectedFloorId(event.target.value)}>
              <option value="ALL">All Floors</option>
              {floors
                .filter((floor) => selectedBuildingId === 'ALL' || floor.building_id === selectedBuildingId)
                .map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    F{floor.floor_number} {floor.name ?? ''}
                  </option>
                ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="attendance-school-room">Room</label>
            <select id="attendance-school-room" value={selectedRoomId} onChange={(event) => setSelectedRoomId(event.target.value)}>
              <option value="ALL">All Rooms</option>
              {roomOptions.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.room_code}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="attendance-school-subject">Subject</label>
            <select id="attendance-school-subject" value={selectedSubjectId} onChange={(event) => setSelectedSubjectId(event.target.value)}>
              <option value="ALL">All Subjects</option>
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.label}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="attendance-school-session">Session</label>
            <select id="attendance-school-session" value={selectedSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>
              <option value="ALL">All Sessions</option>
              {sessionOptions.map((session) => (
                <option key={session.id} value={session.id}>
                  {(session.room_code ?? '-') + ' | ' + session.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="attendance-school-weekday">Day of Week</label>
            <select id="attendance-school-weekday" value={selectedDayOfWeek} onChange={(event) => setSelectedDayOfWeek(event.target.value)}>
              <option value="ALL">All Days</option>
              <option value="0">Monday</option>
              <option value="1">Tuesday</option>
              <option value="2">Wednesday</option>
              <option value="3">Thursday</option>
              <option value="4">Friday</option>
              <option value="5">Saturday</option>
              <option value="6">Sunday</option>
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="attendance-school-start">Start Date</label>
            <input id="attendance-school-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </div>

          <div className="filter-group">
            <label htmlFor="attendance-school-end">End Date</label>
            <input id="attendance-school-end" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </div>

          <p className="muted">Scope: {selectedBuildingLabel}</p>
        </>
      )}
    >
      {isLoading ? <section className="panel">Loading attendance dashboard...</section> : null}
      {error ? <section className="panel error-panel">{error}</section> : null}

      <section className="panel">
        <div className="section-title-row">
          <h2>Session Attendance Breakdown</h2>
          <div className="inline-filters">
            <select value={breakdownDimension} onChange={(event) => setBreakdownDimension(event.target.value as AttendanceDashboardDimension)}>
              <option value="day_of_week">By Day of Week</option>
              <option value="session">By Session</option>
              <option value="subject">By Subject</option>
            </select>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={breakdownData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="present" stackId="attendance" fill="#74a772" name="Present" />
            <Bar dataKey="late" stackId="attendance" fill="#f59e0b" name="Late" />
            <Bar dataKey="absent" stackId="attendance" fill="#dc2626" name="Absent" />
          </BarChart>
        </ResponsiveContainer>
      </section>

      <section className="panel">
        <div className="section-title-row">
          <h2>Attendance Rate Trend</h2>
          <div className="inline-filters">
            <select value={trendGranularity} onChange={(event) => setTrendGranularity(event.target.value as AttendanceDashboardTrendGranularity)}>
              <option value="weekday">Weekday</option>
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
            </select>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" />
            <YAxis domain={[0, 100]} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="attendance_rate" stroke="#4f8f56" strokeWidth={3} dot={{ r: 4 }} name="Attendance Rate %" />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <section className="panel">
        <div className="section-title-row">
          <h2>Attendance Ranking</h2>
          <div className="inline-filters">
            <select value={rankingScope} onChange={(event) => setRankingScope(event.target.value as AttendanceDashboardRankingScope)}>
              <option value="session">Session</option>
              <option value="room">Room</option>
              <option value="subject">Subject</option>
            </select>
            <button type="button" onClick={() => void handleExport('xlsx')} disabled={isExporting}>
              {isExporting ? 'Exporting...' : 'Export XLSX'}
            </button>
            <button type="button" onClick={() => void handleExport('csv')} disabled={isExporting}>
              Export CSV
            </button>
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Scope</th>
                <th>Start Time</th>
                <th>Status</th>
                <th>Enrolled</th>
                <th>Present</th>
                <th>Late</th>
                <th>Absent</th>
                <th>Rate%</th>
              </tr>
            </thead>
            <tbody>
              {rankingRows.map((row) => (
                <tr key={`${row.scope_key}-${row.rank}`}>
                  <td>{row.rank}</td>
                  <td>{row.scope_label}</td>
                  <td>{row.start_time ? new Date(row.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td>{row.session_status ?? '—'}</td>
                  <td>{row.enrolled}</td>
                  <td>{row.present}</td>
                  <td>{row.late}</td>
                  <td>{row.absent}</td>
                  <td>{row.attendance_rate.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AdminBuildingLayout>
  )
}
