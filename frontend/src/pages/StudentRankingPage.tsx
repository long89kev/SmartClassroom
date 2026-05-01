import { useEffect, useMemo, useState } from 'react'
import { Search, UserCheck, AlertTriangle, TrendingUp, Info } from 'lucide-react'
import {
  getStudentRankings,
  getSessions,
} from '../services/api'
import type {
  AttendanceDashboardFilters,
  StudentRankingRow,
  FloorSummary,
  RoomSummary,
  SessionSummary,
} from '../types'
import { AdminBuildingLayout } from '../components/AdminBuildingLayout'

export function StudentRankingPage(): JSX.Element {
  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [subjects, setSubjects] = useState<Array<{ id: string; label: string }>>([])

  const [selectedFloorId, setSelectedFloorId] = useState<string>('ALL')
  const [selectedRoomId, setSelectedRoomId] = useState<string>('ALL')
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('ALL')
  const [startDate, setStartDate] = useState<string>('')
  const [endDate, setEndDate] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState<string>('')

  const [rankings, setRankings] = useState<StudentRankingRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const dashboardFilters = useMemo<AttendanceDashboardFilters>(() => {
    return {
      start_date: startDate || undefined,
      end_date: endDate || undefined,
      room_id: selectedRoomId === 'ALL' ? undefined : selectedRoomId,
      subject_id: selectedSubjectId === 'ALL' ? undefined : selectedSubjectId,
      query: searchQuery || undefined,
    }
  }, [endDate, selectedRoomId, selectedSubjectId, startDate, searchQuery])

  useEffect(() => {
    async function loadStructure(): Promise<void> {
      try {
        const activeSessions = await getSessions({ status_filter: 'ACTIVE' })
        setSessions(activeSessions)

        const subjectMap = new Map<string, string>()
        activeSessions.forEach((s) => {
          if (s.subject_id) subjectMap.set(s.subject_id, s.subject_name ?? s.subject_id)
        })
        setSubjects(Array.from(subjectMap.entries()).map(([id, label]) => ({ id, label })))
      } catch (err) {
        console.error('Failed to load structure', err)
      }
    }
    void loadStructure()
  }, [])

  useEffect(() => {
    let isMounted = true
    async function loadRankings(): Promise<void> {
      setIsLoading(true)
      try {
        const data = await getStudentRankings(dashboardFilters)
        if (isMounted) setRankings(data.rows)
      } catch (err) {
        if (isMounted) setError(err instanceof Error ? err.message : 'Failed to load rankings')
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }
    void loadRankings()
    return () => { isMounted = false }
  }, [dashboardFilters])

  const stats = useMemo(() => {
    if (!rankings.length) return { avgAtt: 0, avgPerf: 0, highRisk: 0 }
    const sumAtt = rankings.reduce((acc, r) => acc + r.attendance_rate, 0)
    const sumPerf = rankings.reduce((acc, r) => acc + r.avg_performance_score, 0)
    const highRiskCount = rankings.filter(r => r.risk_level !== 'STABLE').length
    return {
      avgAtt: sumAtt / rankings.length,
      avgPerf: sumPerf / rankings.length,
      highRisk: highRiskCount
    }
  }, [rankings])

  return (
    <AdminBuildingLayout
      title="Student Performance Ranking"
      subtitle="Comprehensive student analytics combining attendance consistency and behavioral focus scores."
      eyebrow="Academic Intelligence"
      metrics={[
        { label: 'Students Tracked', value: rankings.length, tone: 'neutral' },
        { label: 'Avg Attendance', value: `${stats.avgAtt.toFixed(1)}%`, tone: stats.avgAtt > 85 ? 'safe' : 'warn' },
        { label: 'Avg Perf Score', value: stats.avgPerf.toFixed(1), tone: 'neutral' },
        { label: 'At Risk Count', value: stats.highRisk, tone: stats.highRisk > 0 ? 'danger' : 'safe' },
      ]}
      sidebarContent={(
        <>
          <div className="filter-group">
            <label htmlFor="student-search">Search Student</label>
            <div className="search-input-wrapper" style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
              <input
                id="student-search"
                type="text"
                placeholder="Name or ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ paddingLeft: '36px', width: '100%' }}
              />
            </div>
          </div>

          <div className="filter-group">
            <label htmlFor="rank-subject">Subject</label>
            <select id="rank-subject" value={selectedSubjectId} onChange={(e) => setSelectedSubjectId(e.target.value)}>
              <option value="ALL">All Subjects</option>
              {subjects.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>

          <div className="filter-group">
            <label>Date Range</label>
            <div style={{ display: 'grid', gap: '8px' }}>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          
          <div className="sidebar-note">
            <Info size={16} />
            <p style={{ fontSize: '12px', margin: 0 }}>Risk score is aggregated from all behavioral incidents per session.</p>
          </div>
        </>
      )}
    >
      {error && <section className="panel error-panel">{error}</section>}

      <section className="panel">
        <div className="section-title-row">
          <h2>Academic Ranking List</h2>
          <div className="inline-filters">
             <span className="muted" style={{ fontSize: '13px' }}>Showing top {rankings.length} students</span>
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Student</th>
                <th>Class</th>
                <th>Attendance</th>
                <th>Perf. Score</th>
                <th>Risk Score</th>
                <th>Risk Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: '40px' }}>Loading ranking data...</td></tr>
              ) : rankings.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: '40px' }}>No students found matching filters.</td></tr>
              ) : (
                rankings.map((row) => (
                  <tr key={row.student_id}>
                    <td><strong>#{row.rank}</strong></td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 600 }}>{row.student_name}</span>
                        <span className="muted" style={{ fontSize: '11px' }}>{row.student_code}</span>
                      </div>
                    </td>
                    <td>{row.student_class || '—'}</td>
                    <td>
                       <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                         <div style={{ width: '40px', height: '4px', background: '#e2e8f0', borderRadius: '2px', overflow: 'hidden' }}>
                            <div style={{ width: `${row.attendance_rate}%`, height: '100%', background: row.attendance_rate > 85 ? '#10b981' : '#f59e0b' }} />
                         </div>
                         <span>{row.attendance_rate.toFixed(1)}%</span>
                       </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <TrendingUp size={14} className="tone-safe" />
                        {row.avg_performance_score.toFixed(1)}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <AlertTriangle size={14} className={row.avg_risk_score > 5 ? 'tone-danger' : 'tone-neutral'} />
                        {row.avg_risk_score.toFixed(1)}
                      </div>
                    </td>
                    <td>
                      <span className={`status-pill ${row.risk_level === 'CRITICAL' ? 'tone-danger' : row.risk_level === 'HIGH' ? 'tone-warn' : 'tone-safe'}`}>
                        {row.risk_level}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AdminBuildingLayout>
  )
}
