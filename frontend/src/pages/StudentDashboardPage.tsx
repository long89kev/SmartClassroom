import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { AlertTriangle, CalendarRange, CheckCircle2, Clock3, XCircle } from 'lucide-react'

import {
  getStudentAttendanceSummary,
  getStudentSessionDetail,
  getStudentWeeklySessions,
} from '../services/api'
import type {
  AttendanceStatus,
  StudentAttendanceSummary,
  StudentSessionCalendarItem,
  StudentSessionDetailResponse,
} from '../types'
import { toLocalDateTime } from '../utils/time'

const MINUTES_START = 7 * 60
const MINUTES_END = 22 * 60
const TOTAL_MINUTES = MINUTES_END - MINUTES_START

function getWeekStart(base: Date): Date {
  const copy = new Date(base)
  const day = (copy.getDay() + 6) % 7
  copy.setHours(0, 0, 0, 0)
  copy.setDate(copy.getDate() - day)
  return copy
}

function formatWeekRange(weekStart: Date): string {
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)
  return `${weekStart.toLocaleDateString()} - ${weekEnd.toLocaleDateString()}`
}

function formatTimeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function getAttendanceClass(status: AttendanceStatus): string {
  if (status === 'PRESENT') return 'attendance-badge present'
  if (status === 'LATE') return 'attendance-badge late'
  return 'attendance-badge absent'
}

function getSessionBlockStyle(session: StudentSessionCalendarItem): { top: string; height: string } {
  const startDate = new Date(session.start_time)
  const endDate = session.end_time ? new Date(session.end_time) : new Date(startDate.getTime() + 60 * 60 * 1000)

  const startMinutes = startDate.getHours() * 60 + startDate.getMinutes()
  const endMinutes = endDate.getHours() * 60 + endDate.getMinutes()

  const clampedStart = Math.max(MINUTES_START, Math.min(startMinutes, MINUTES_END - 30))
  const clampedEnd = Math.max(clampedStart + 30, Math.min(endMinutes, MINUTES_END))

  const top = ((clampedStart - MINUTES_START) / TOTAL_MINUTES) * 100
  const height = ((clampedEnd - clampedStart) / TOTAL_MINUTES) * 100

  return {
    top: `${top}%`,
    height: `${Math.max(height, 6)}%`,
  }
}

export function StudentDashboardPage(): JSX.Element {
  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date()))
  const [sessions, setSessions] = useState<StudentSessionCalendarItem[]>([])
  const [summary, setSummary] = useState<StudentAttendanceSummary | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedSessionDetail, setSelectedSessionDetail] = useState<StudentSessionDetailResponse | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function load(): Promise<void> {
      try {
        setError(null)
        const weekStartIso = weekStart.toISOString()
        const [sessionData, summaryData] = await Promise.all([
          getStudentWeeklySessions(weekStartIso),
          getStudentAttendanceSummary(30),
        ])

        if (!isMounted) return

        setSessions(sessionData)
        setSummary(summaryData)

        if (sessionData.length > 0 && !selectedSessionId) {
          setSelectedSessionId(sessionData[0].session_id)
        }
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load student dashboard')
      }
    }

    void load()

    return () => {
      isMounted = false
    }
  }, [selectedSessionId, weekStart])

  useEffect(() => {
    let isMounted = true

    async function loadDetail(): Promise<void> {
      if (!selectedSessionId) {
        setSelectedSessionDetail(null)
        return
      }

      try {
        setIsLoadingDetail(true)
        const detail = await getStudentSessionDetail(selectedSessionId)
        if (!isMounted) return
        setSelectedSessionDetail(detail)
      } catch (detailError) {
        if (!isMounted) return
        setError(detailError instanceof Error ? detailError.message : 'Failed to load session detail')
      } finally {
        if (isMounted) {
          setIsLoadingDetail(false)
        }
      }
    }

    void loadDetail()

    return () => {
      isMounted = false
    }
  }, [selectedSessionId])

  const sessionsByDay = useMemo(() => {
    const map = new Map<number, StudentSessionCalendarItem[]>()
    for (let i = 0; i < 7; i += 1) {
      map.set(i, [])
    }

    sessions.forEach((session) => {
      const day = new Date(session.start_time)
      const mondayIndex = (day.getDay() + 6) % 7
      const bucket = map.get(mondayIndex)
      if (bucket) {
        bucket.push(session)
      }
    })

    for (const daySessions of map.values()) {
      daySessions.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
    }

    return map
  }, [sessions])

  const dayHeaders = useMemo(() => {
    const labels: string[] = []
    for (let i = 0; i < 7; i += 1) {
      const date = new Date(weekStart)
      date.setDate(weekStart.getDate() + i)
      labels.push(`${date.toLocaleDateString([], { weekday: 'short' })} ${date.getDate()}`)
    }
    return labels
  }, [weekStart])

  function goToPreviousWeek(): void {
    const next = new Date(weekStart)
    next.setDate(weekStart.getDate() - 7)
    setWeekStart(next)
    setSelectedSessionId(null)
  }

  function goToNextWeek(): void {
    const next = new Date(weekStart)
    next.setDate(weekStart.getDate() + 7)
    setWeekStart(next)
    setSelectedSessionId(null)
  }

  function goToCurrentWeek(): void {
    setWeekStart(getWeekStart(new Date()))
    setSelectedSessionId(null)
  }

  return (
    <main className="page campus-bg student-dashboard-page">
      <section className="panel student-dashboard-header">
        <p className="eyebrow">Student Stakeholder</p>
        <h1>My Weekly Schedule</h1>
        <p className="subcopy">
          Calendar view of your enrolled sessions. Click any session block to review attendance, behavior in class,
          and risk incidents.
        </p>

        <div className="student-kpi-header">
          <article className="student-stat-tile">
            <strong>{summary?.present ?? 0}</strong>
            <p>Present (30 days)</p>
          </article>
          <article className="student-stat-tile">
            <strong>{summary?.late ?? 0}</strong>
            <p>Late (30 days)</p>
          </article>
          <article className="student-stat-tile">
            <strong>{summary?.absent ?? 0}</strong>
            <p>Absent (30 days)</p>
          </article>
          <article className="student-stat-tile">
            <strong>{summary?.total_sessions ?? sessions.length}</strong>
            <p>Total Sessions</p>
          </article>
        </div>

        <div className="week-picker">
          <button type="button" onClick={goToPreviousWeek}>Prev</button>
          <strong className="active-week">{formatWeekRange(weekStart)}</strong>
          <button type="button" onClick={goToNextWeek}>Next</button>
          <button type="button" onClick={goToCurrentWeek}>Today</button>
        </div>

        {error ? <div className="error-panel">{error}</div> : null}
      </section>

      <section className="student-dashboard-layout">
        <article className="panel">
          <div className="schedule-grid">
            <div className="schedule-time-axis">
              {Array.from({ length: 16 }).map((_, index) => {
                const hour = 7 + index
                return (
                  <div key={hour} className="schedule-time-mark">
                    {`${hour.toString().padStart(2, '0')}:00`}
                  </div>
                )
              })}
            </div>

            <div className="schedule-week-columns">
              {dayHeaders.map((header, index) => (
                <div key={header} className="schedule-day-column-wrap">
                  <header className="schedule-day-header">{header}</header>
                  <div className="schedule-day-column">
                    {Array.from({ length: 16 }).map((_, slot) => (
                      <div key={`${header}-${slot}`} className="schedule-slot" />
                    ))}

                    {(sessionsByDay.get(index) ?? []).map((session) => {
                      const style = getSessionBlockStyle(session)
                      const isSelected = selectedSessionId === session.session_id
                      return (
                        <button
                          key={session.session_id}
                          type="button"
                          className={`schedule-block ${isSelected ? 'selected' : ''}`}
                          style={style}
                          onClick={() => setSelectedSessionId(session.session_id)}
                        >
                          <p className="schedule-block-title">{session.subject_code ?? session.subject_name ?? 'Session'}</p>
                          <p className="schedule-block-time">
                            {formatTimeLabel(session.start_time)} - {formatTimeLabel(session.end_time ?? session.start_time)}
                          </p>
                          <p className="schedule-block-room">{session.room_code ?? 'Room N/A'}</p>
                          <span className={getAttendanceClass(session.attendance_status)}>{session.attendance_status}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </article>

        <aside className="panel student-session-panel">
          <h2>Session Detail</h2>
          {!selectedSessionId ? <p className="muted">Select a session block to view details.</p> : null}
          {isLoadingDetail ? <p className="muted">Loading details...</p> : null}

          {selectedSessionDetail ? (
            <div className="student-session-detail-grid">
              <article className="student-detail-section">
                <h3>Attendance</h3>
                <p>
                  <CalendarRange size={14} /> {toLocalDateTime(selectedSessionDetail.start_time)}
                </p>
                <p>
                  <Clock3 size={14} /> Grace: {selectedSessionDetail.grace_minutes} min
                </p>
                <p>
                  <CheckCircle2 size={14} /> Status: {selectedSessionDetail.attendance_status}
                </p>
                <p>First seen: {toLocalDateTime(selectedSessionDetail.first_seen_at)}</p>
                <p>Confidence: {selectedSessionDetail.confidence != null ? selectedSessionDetail.confidence.toFixed(2) : '-'}</p>
              </article>

              <article className="student-detail-section">
                <h3>Behavior In Class</h3>
                {selectedSessionDetail.behavior_summary.length === 0 ? (
                  <p className="muted">No behavior events recorded for this session.</p>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Behavior</th>
                          <th>Count</th>
                          <th>Duration (s)</th>
                          <th>Avg Conf.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedSessionDetail.behavior_summary.map((item) => (
                          <tr key={item.behavior_class}>
                            <td>{item.behavior_class}</td>
                            <td>{item.count}</td>
                            <td>{item.duration_seconds}</td>
                            <td>{item.avg_confidence.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </article>

              <article className="student-detail-section">
                <h3>Risk Incidents</h3>
                {selectedSessionDetail.incidents.length === 0 ? (
                  <p className="muted">No incidents for this session.</p>
                ) : (
                  <div className="incident-list">
                    {selectedSessionDetail.incidents.map((incident) => (
                      <div key={incident.id} className="incident-item severity-high">
                        <header>
                          <strong>{incident.risk_level}</strong>
                          <span>{new Date(incident.flagged_at).toLocaleString()}</span>
                        </header>
                        <p>
                          <AlertTriangle size={14} /> Score: {incident.risk_score.toFixed(2)}
                        </p>
                        <p>{incident.reviewed ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {incident.reviewed ? 'Reviewed' : 'Unreviewed'}</p>
                        {incident.reviewer_notes ? <p>Notes: {incident.reviewer_notes}</p> : null}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            </div>
          ) : null}
        </aside>
      </section>
    </main>
  )
}
