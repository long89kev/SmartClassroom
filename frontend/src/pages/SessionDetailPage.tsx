import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, Clock3, ShieldAlert } from 'lucide-react'
import { getIncidents, getLatestSessionFrame, getSessionAnalytics, getSessions } from '../services/api'
import type { Incident, SessionAnalytics, SessionSummary } from '../types'
import { timeAgo, toLocalDateTime } from '../utils/time'

function ensureDataUri(value: string): string {
  if (value.startsWith('data:image')) return value
  return `data:image/jpeg;base64,${value}`
}

export function SessionDetailPage(): JSX.Element {
  const { sessionId } = useParams<{ sessionId: string }>()

  const [session, setSession] = useState<SessionSummary | null>(null)
  const [analytics, setAnalytics] = useState<SessionAnalytics | null>(null)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [frameSrc, setFrameSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function load(): Promise<void> {
      if (!sessionId) return

      try {
        const [allSessions, analyticsData, incidentsData, frameData] = await Promise.all([
          getSessions(),
          getSessionAnalytics(sessionId),
          getIncidents({ session_id: sessionId }),
          getLatestSessionFrame(sessionId),
        ])

        if (!isMounted) return

        setSession(allSessions.find((item) => item.id === sessionId) ?? null)
        setAnalytics(analyticsData)
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
  }, [sessionId])

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
        <Link to="/" className="inline-link">
          <ChevronLeft size={16} /> Back to Buildings
        </Link>

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
          {frameSrc ? <img className="frame-preview" src={frameSrc} alt="Latest frame" /> : <p>No frame available yet.</p>}
        </article>

        <article className="panel">
          <h2>Incidents Timeline</h2>
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
        </article>
      </section>

      <section className="panel">
        <h2>Student Behavior Breakdown</h2>
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
      </section>
    </main>
  )
}
