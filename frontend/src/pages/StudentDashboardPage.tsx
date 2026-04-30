import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  getStudentAttendanceSummary,
  getStudentWeeklySessions,
} from '../services/api'
import type {
  AttendanceStatus,
  StudentAttendanceSummary,
  StudentSessionCalendarItem,
} from '../types'

const MINUTES_START = 7 * 60
const MINUTES_END = 19 * 60
const TOTAL_MINUTES = MINUTES_END - MINUTES_START // 720 mins (12 hours)

type ViewMode = 'DAY' | 'WEEK' | 'MONTH'

function getRangeStart(base: Date, mode: ViewMode): Date {
  const copy = new Date(base)
  copy.setHours(0, 0, 0, 0)
  if (mode === 'DAY') return copy
  if (mode === 'WEEK') {
    const day = (copy.getDay() + 6) % 7
    copy.setDate(copy.getDate() - day)
    return copy
  }
  // MONTH: Start at the first day of the month, then back up to the nearest Monday
  copy.setDate(1)
  const day = (copy.getDay() + 6) % 7
  copy.setDate(copy.getDate() - day)
  return copy
}

function getRangeDays(mode: ViewMode): number {
  if (mode === 'DAY') return 1
  if (mode === 'WEEK') return 7
  return 35 // 5 weeks for month view
}

function formatRangeLabel(start: Date, mode: ViewMode): string {
  if (mode === 'DAY') return start.toLocaleDateString()
  if (mode === 'WEEK') {
    const end = new Date(start)
    end.setDate(start.getDate() + 6)
    return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`
  }
  // MONTH: Show month name
  const middle = new Date(start)
  middle.setDate(start.getDate() + 15)
  return middle.toLocaleDateString([], { month: 'long', year: 'numeric' })
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
  const navigate = useNavigate()
  const [viewMode, setViewMode] = useState<ViewMode>('WEEK')
  const [rangeStart, setRangeStart] = useState<Date>(() => getRangeStart(new Date(), 'WEEK'))
  const [sessions, setSessions] = useState<StudentSessionCalendarItem[]>([])
  const [summary, setSummary] = useState<StudentAttendanceSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function load(): Promise<void> {
      try {
        setError(null)
        const startIso = rangeStart.toISOString()
        const days = getRangeDays(viewMode)
        const [sessionData, summaryData] = await Promise.all([
          getStudentWeeklySessions(startIso, days),
          getStudentAttendanceSummary(30),
        ])

        if (!isMounted) return

        setSessions(sessionData)
        setSummary(summaryData)
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load student dashboard')
      }
    }

    void load()

    return () => {
      isMounted = false
    }
  }, [rangeStart, viewMode])

  const sessionsByDay = useMemo(() => {
    const daysCount = getRangeDays(viewMode)
    const map = new Map<number, StudentSessionCalendarItem[]>()
    for (let i = 0; i < daysCount; i += 1) {
      map.set(i, [])
    }

    const startTime = rangeStart.getTime()

    sessions.forEach((session) => {
      const day = new Date(session.start_time)
      day.setHours(0, 0, 0, 0)
      const diffDays = Math.floor((day.getTime() - startTime) / (24 * 60 * 60 * 1000))

      const bucket = map.get(diffDays)
      if (bucket) {
        bucket.push(session)
      }
    })

    for (const daySessions of map.values()) {
      daySessions.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
    }

    return map
  }, [sessions, rangeStart, viewMode])

  const dayHeaders = useMemo(() => {
    const daysCount = getRangeDays(viewMode)
    const labels: string[] = []
    for (let i = 0; i < daysCount; i += 1) {
      const date = new Date(rangeStart)
      date.setDate(rangeStart.getDate() + i)
      labels.push(`${date.toLocaleDateString([], { weekday: 'short' })} ${date.getDate()}`)
    }
    return labels
  }, [rangeStart, viewMode])

  function goToPrevious(): void {
    const next = new Date(rangeStart)
    const step = viewMode === 'MONTH' ? 28 : getRangeDays(viewMode)
    next.setDate(rangeStart.getDate() - step)
    setRangeStart(next)
  }

  function goToNext(): void {
    const next = new Date(rangeStart)
    const step = viewMode === 'MONTH' ? 28 : getRangeDays(viewMode)
    next.setDate(rangeStart.getDate() + step)
    setRangeStart(next)
  }

  function goToToday(): void {
    setRangeStart(getRangeStart(new Date(), viewMode))
  }

  function switchView(mode: ViewMode): void {
    setViewMode(mode)
    setRangeStart(getRangeStart(new Date(), mode))
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
          <article className="student-stat-tile tone-safe">
            <strong>{summary?.present ?? 0}</strong>
            <p>Present (30 days)</p>
          </article>
          <article className="student-stat-tile tone-warn">
            <strong>{summary?.late ?? 0}</strong>
            <p>Late (30 days)</p>
          </article>
          <article className="student-stat-tile tone-danger">
            <strong>{summary?.absent ?? 0}</strong>
            <p>Absent (30 days)</p>
          </article>
          <article className="student-stat-tile tone-neutral">
            <strong>{summary?.total_sessions ?? sessions.length}</strong>
            <p>Total Sessions</p>
          </article>
        </div>

        <div className="week-picker dashboard-controls">
          <div className="picker-nav">
            <button type="button" onClick={goToPrevious}>Prev</button>
            <strong className="active-week">{formatRangeLabel(rangeStart, viewMode)}</strong>
            <button type="button" onClick={goToNext}>Next</button>
            <button type="button" onClick={goToToday}>Today</button>
          </div>

          <div className="view-selector">
            <button
              type="button"
              className={viewMode === 'DAY' ? 'active' : ''}
              onClick={() => switchView('DAY')}
            >
              Day
            </button>
            <button
              type="button"
              className={viewMode === 'WEEK' ? 'active' : ''}
              onClick={() => switchView('WEEK')}
            >
              Week
            </button>
            <button
              type="button"
              className={viewMode === 'MONTH' ? 'active' : ''}
              onClick={() => switchView('MONTH')}
            >
              Month
            </button>
          </div>
        </div>

        {error ? <div className="error-panel">{error}</div> : null}
      </section>

      <section className={`student-dashboard-layout-full view-${viewMode.toLowerCase()}`}>
        <article className="panel">
          <div className={`schedule-grid view-${viewMode.toLowerCase()}`}>
            {viewMode !== 'MONTH' && (
              <div className="schedule-time-axis">
                {Array.from({ length: 13 }).map((_, index) => {
                  const hour = 7 + index
                  return (
                    <div key={hour} className="schedule-time-mark">
                      {`${hour.toString().padStart(2, '0')}:00`}
                    </div>
                  )
                })}
              </div>
            )}

            <div className={`schedule-columns layout-${viewMode.toLowerCase()}`}>
              {dayHeaders.map((header, index) => (
                <div key={`${header}-${index}`} className="schedule-day-column-wrap">
                  <header className="schedule-day-header">{header}</header>
                  <div className="schedule-day-column">
                    {viewMode !== 'MONTH' &&
                      Array.from({ length: 12 }).map((_, slot) => (
                        <div key={`${header}-${slot}`} className="schedule-slot" />
                      ))}

                    {(sessionsByDay.get(index) ?? []).map((session) => {
                      const style = viewMode === 'MONTH' ? {} : getSessionBlockStyle(session)
                      return (
                        <button
                          key={session.session_id}
                          type="button"
                          className={`schedule-block ${viewMode === 'MONTH' ? 'month-block' : ''}`}
                          style={style}
                          onClick={() => navigate(`/students/me/sessions/${session.session_id}`)}
                        >
                          <p className="schedule-block-title">
                            {session.subject_code ?? session.subject_name ?? 'Session'}
                          </p>
                          {viewMode !== 'MONTH' && (
                            <>
                              <p className="schedule-block-time">
                                {formatTimeLabel(session.start_time)} -{' '}
                                {formatTimeLabel(session.end_time ?? session.start_time)}
                              </p>
                              <p className="schedule-block-room">{session.room_code ?? 'Room N/A'}</p>
                            </>
                          )}
                          <span className={getAttendanceClass(session.attendance_status)}>
                            {session.attendance_status}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </article>
      </section>
    </main>
  )
}
