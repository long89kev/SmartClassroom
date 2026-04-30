import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Link, useParams } from 'react-router-dom'
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
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock3, XCircle } from 'lucide-react'

import { getStudentSessionDetail } from '../services/api'
import type { StudentSessionDetailResponse } from '../types'
import { toLocalDateTime } from '../utils/time'

function normalizeSeverity(level: string): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const normalized = level.toUpperCase()
  if (normalized === 'LOW' || normalized === 'MEDIUM' || normalized === 'HIGH' || normalized === 'CRITICAL') {
    return normalized
  }
  return 'MEDIUM'
}

export function StudentSessionPage(): JSX.Element {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [detail, setDetail] = useState<StudentSessionDetailResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function loadSession(): Promise<void> {
      if (!sessionId) {
        setError('Missing session id in route.')
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        const response = await getStudentSessionDetail(sessionId)
        if (!isMounted) return
        setDetail(response)
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load session analytics')
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    void loadSession()

    return () => {
      isMounted = false
    }
  }, [sessionId])

  const behaviorCountData = useMemo(() => {
    return (detail?.behavior_summary ?? []).map((item) => ({
      behavior: item.behavior_class,
      count: item.count,
    }))
  }, [detail])

  const behaviorDurationData = useMemo(() => {
    return (detail?.behavior_summary ?? []).map((item) => ({
      behavior: item.behavior_class,
      duration: item.duration_seconds,
    }))
  }, [detail])

  const riskTrendData = useMemo(() => {
    return (detail?.incidents ?? [])
      .slice()
      .sort((a, b) => new Date(a.flagged_at).getTime() - new Date(b.flagged_at).getTime())
      .map((incident) => ({
        time: new Date(incident.flagged_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        score: Number(incident.risk_score.toFixed(2)),
      }))
  }, [detail])

  const severityData = useMemo(() => {
    const bucket = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
    ;(detail?.incidents ?? []).forEach((incident) => {
      bucket[normalizeSeverity(incident.risk_level)] += 1
    })

    return Object.entries(bucket).map(([severity, count]) => ({ severity, count }))
  }, [detail])

  return (
    <main className="page campus-bg student-session-page">
      <section className="panel student-session-header">
        <div className="section-title-row">
          <h1>Session Analytics</h1>
        </div>

        {isLoading ? <p className="muted">Loading session analytics...</p> : null}
        {error ? <div className="error-panel">{error}</div> : null}

        {detail ? (
          <div className="student-session-meta">
            <div className="student-stat-tile">
              <strong>{detail.subject_name ?? 'Subject N/A'}</strong>
              <p>Subject</p>
            </div>
            <div className="student-stat-tile">
              <strong>{detail.room_code ?? 'Room N/A'}</strong>
              <p>Room</p>
            </div>
            <div className="student-stat-tile">
              <strong>{detail.teacher_name ?? 'Teacher N/A'}</strong>
              <p>Teacher</p>
            </div>
            <div className="student-stat-tile">
              <strong>{detail.attendance_status}</strong>
              <p>Attendance</p>
            </div>
          </div>
        ) : null}
      </section>

      {detail ? (
        <>
          <section className="student-session-analytics-grid">
            <article className="panel">
              <div className="section-title-row">
                <h2>Behavior During Session</h2>
                <span>{detail.behavior_summary.length} behavior classes</span>
              </div>

              {detail.behavior_summary.length === 0 ? (
                <p className="muted">No behavior events recorded for this session.</p>
              ) : (
                <>
                  <div className="student-chart-wrap">
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={behaviorCountData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="behavior" />
                        <YAxis />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="count" name="Event Count" fill="#214b7a" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="student-chart-wrap">
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={behaviorDurationData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="behavior" />
                        <YAxis />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="duration" name="Duration (s)" fill="#4f6f52" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Behavior</th>
                          <th>Count</th>
                          <th>Duration (s)</th>
                          <th>Avg Confidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.behavior_summary.map((item) => (
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
                </>
              )}
            </article>

            <article className="panel">
              <div className="section-title-row">
                <h2>Risk Incidents During Session</h2>
                <span>{detail.incidents.length} incidents</span>
              </div>

              {detail.incidents.length === 0 ? (
                <p className="muted">No risk incidents recorded for this session.</p>
              ) : (
                <>
                  <div className="student-chart-wrap">
                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart data={riskTrendData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="time" />
                        <YAxis />
                        <Tooltip />
                        <Legend />
                        <Line type="monotone" dataKey="score" name="Risk Score" stroke="#b32b24" strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="student-chart-wrap">
                    <ResponsiveContainer width="100%" height={210}>
                      <BarChart data={severityData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="severity" />
                        <YAxis allowDecimals={false} />
                        <Tooltip />
                        <Bar dataKey="count" name="Incidents" fill="#c17d28" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="incident-list">
                    {detail.incidents.map((incident) => (
                      <article key={incident.id} className={`incident-item severity-${normalizeSeverity(incident.risk_level).toLowerCase()}`}>
                        <header>
                          <strong>{incident.risk_level}</strong>
                          <span>{new Date(incident.flagged_at).toLocaleString()}</span>
                        </header>
                        <p>
                          <AlertTriangle size={14} /> Score: {incident.risk_score.toFixed(2)}
                        </p>
                        <p>
                          {incident.reviewed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                          {incident.reviewed ? ' Reviewed' : ' Unreviewed'}
                        </p>
                        {incident.reviewer_notes ? <p>Notes: {incident.reviewer_notes}</p> : null}
                      </article>
                    ))}
                  </div>
                </>
              )}
            </article>
          </section>

          <section className="panel student-session-attendance-panel">
            <div className="section-title-row">
              <h2>Attendance Context</h2>
              <span>{toLocalDateTime(detail.start_time)}</span>
            </div>
            <div className="detail-kpis">
              <article>
                <Clock3 size={16} />
                <span>Grace: {detail.grace_minutes} min</span>
              </article>
              <article>
                <CheckCircle2 size={16} />
                <span>Status: {detail.attendance_status}</span>
              </article>
              <article>
                <span>First seen: {toLocalDateTime(detail.first_seen_at)}</span>
              </article>
              <article>
                <span>Confidence: {detail.confidence != null ? detail.confidence.toFixed(2) : '-'}</span>
              </article>
            </div>
          </section>
        </>
      ) : null}
    </main>
  )
}
