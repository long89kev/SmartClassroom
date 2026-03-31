import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, Clock3, ShieldAlert } from 'lucide-react'
import { getIncidents, getLatestSessionFrame, getSessionAnalytics, getSessionAttendanceReport, getSessions } from '../services/api'
import type { AttendanceSessionReport, Incident, SessionAnalytics, SessionSummary } from '../types'
import { timeAgo, toLocalDateTime } from '../utils/time'
import { usePermissions } from '../hooks/usePermissions'
import { PERMISSIONS } from '../constants/permissions'

function ensureDataUri(value: string): string {
  if (value.startsWith('data:image')) return value
  return `data:image/jpeg;base64,${value}`
}

export function SessionDetailPage(): JSX.Element {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const { has, hasAny } = usePermissions()

  const canViewIncidents = has(PERMISSIONS.INCIDENT_VIEW)
  const canViewFrame = hasAny([PERMISSIONS.CAMERA_VIEW_LIVE, PERMISSIONS.CAMERA_VIEW_RECORDED])
  const canViewAnalytics = hasAny([
    PERMISSIONS.REPORT_PERFORMANCE,
    PERMISSIONS.DASHBOARD_VIEW_CLASSROOM,
    PERMISSIONS.DASHBOARD_VIEW_BLOCK,
    PERMISSIONS.DASHBOARD_VIEW_UNIVERSITY,
  ])

  const [session, setSession] = useState<SessionSummary | null>(null)
  const [analytics, setAnalytics] = useState<SessionAnalytics | null>(null)
  const [attendanceReport, setAttendanceReport] = useState<AttendanceSessionReport | null>(null)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [frameSrc, setFrameSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function load(): Promise<void> {
      if (!sessionId) return

      try {
        const [allSessions, analyticsData, incidentsData, frameData, attendanceData] = await Promise.all([
          getSessions(),
          canViewAnalytics ? getSessionAnalytics(sessionId) : Promise.resolve(null),
          canViewIncidents ? getIncidents({ session_id: sessionId }) : Promise.resolve([]),
          canViewFrame
            ? getLatestSessionFrame(sessionId)
            : Promise.resolve({ source: 'none', image_base64: null, captured_at: null }),
          canViewAnalytics ? getSessionAttendanceReport(sessionId) : Promise.resolve(null),
        ])

        if (!isMounted) return

        setSession(allSessions.find((item) => item.id === sessionId) ?? null)
        setAnalytics(analyticsData)
        setAttendanceReport(attendanceData)
        setIncidents(incidentsData)
        setFrameSrc(frameData.image_base64 ? ensureDataUri(frameData.image_base64) : null)
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load session detail')
      }
    }

    void load()

    return () => {
      isMounted = false
    }
  }, [canViewAnalytics, canViewFrame, canViewIncidents, sessionId])

  const studentRows = useMemo(
    () => Object.entries(analytics?.student_performance ?? {}),
    [analytics],
  )

  if (!sessionId) {
    return (
      <main className="page">
        <section className="panel error-panel">Missing session id in route.</section>
      </main>
    )
  }

  return (
    <main className="page campus-bg">
      <section className="panel">
        <button
          type="button"
          className="inline-link inline-link-button"
          onClick={() => navigate(-1)}
        >
          <ChevronLeft size={16} /> Back
        </button>

        <h1>Session Detail</h1>
        <p className="muted">Session ID: {sessionId}</p>

        {error && <div className="error-panel">{error}</div>}

        <div className="detail-kpis">
          <article>
            <Clock3 size={16} />
            <div>
              <p>Started</p>
              <strong>{toLocalDateTime(session?.start_time ?? analytics?.start_time ?? null)}</strong>
            </div>
          </article>
          <article>
            <ShieldAlert size={16} />
            <div>
              <p>Risk Alerts</p>
              <strong>{analytics?.risk_alerts_count ?? 0}</strong>
            </div>
          </article>
        </div>
      </section>

      <section className="content-grid-two">
        <article className="panel">
          <h2>Latest Annotated Frame</h2>
          {canViewFrame ? (
            frameSrc ? <img className="frame-preview" src={frameSrc} alt="Latest frame" /> : <p>No frame available yet.</p>
          ) : (
            <p className="muted">You do not have permission to view session frames.</p>
          )}
        </article>

        <article className="panel">
          <h2>Incidents Timeline</h2>
          {canViewIncidents ? (
            <div className="incident-list">
              {incidents.map((incident) => (
                <div key={incident.id} className="incident-item">
                  <header>
                    <strong>{incident.risk_level}</strong>
                    <span>{timeAgo(incident.flagged_at)}</span>
                  </header>
                  <p>Score: {incident.risk_score.toFixed(2)}</p>
                  <p>Student: {incident.student_id.slice(0, 8)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">You do not have permission to view incidents.</p>
          )}
        </article>
      </section>

      <section className="panel">
        <h2>Student Behavior Breakdown</h2>
        {canViewAnalytics ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Behaviors</th>
                </tr>
              </thead>
              <tbody>
                {studentRows.map(([studentId, behaviorMap]) => (
                  <tr key={studentId}>
                    <td>{studentId.slice(0, 8)}</td>
                    <td>{Object.entries(behaviorMap).map(([name, count]) => `${name}:${count}`).join(', ') || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">You do not have permission to view session analytics.</p>
        )}
      </section>

      <section className="panel">
        <h2>Attendance Summary</h2>
        {canViewAnalytics ? (
          attendanceReport ? (
            <>
              <p className="muted">
                Present: {attendanceReport.totals.present} | Late: {attendanceReport.totals.late} | Absent: {attendanceReport.totals.absent} | Enrolled: {attendanceReport.totals.enrolled}
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Student Code</th>
                      <th>Name</th>
                      <th>Status</th>
                      <th>First Seen</th>
                      <th>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendanceReport.students.map((student) => (
                      <tr key={student.student_id}>
                        <td>{student.student_code}</td>
                        <td>{student.student_name}</td>
                        <td>{student.status}</td>
                        <td>{toLocalDateTime(student.first_seen_at)}</td>
                        <td>{student.confidence != null ? student.confidence.toFixed(2) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="muted">No attendance report available for this session.</p>
          )
        ) : (
          <p className="muted">You do not have permission to view attendance.</p>
        )}
      </section>
    </main>
  )
}
