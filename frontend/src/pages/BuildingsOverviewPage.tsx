import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Building2, DoorOpen, LayoutGrid, Radio, Search, ShieldAlert, Users2 } from 'lucide-react'
import { getBuildingsOverview, getIncidents, reviewIncident } from '../services/api'
import { usePermissions } from '../hooks/usePermissions'
import { PERMISSIONS } from '../constants/permissions'
import { useAuthStore } from '../store/auth'
import type { BuildingOverview, Incident } from '../types'

type BuildingGroupKey = 'A' | 'B' | 'C' | 'LABS'

interface BuildingGroupSummary {
  key: BuildingGroupKey
  title: string
  description: string
  buildingCount: number
  totalRooms: number
  activeSessions: number
}

type BoardWindowKey = '7D' | '14D' | '30D'

const BOARD_WINDOW_DAYS: Record<BoardWindowKey, number> = {
  '7D': 7,
  '14D': 14,
  '30D': 30,
}

const STUDENT_BEHAVIOR_KEYS = ['student_bow_turn', 'student_discuss', 'student_hand_read_write']
const TEACHER_BEHAVIOR_KEYS = ['teacher_behavior']

function getBehaviorCount(incident: Incident, keys: string[]): number {
  return keys.reduce((sum, key) => sum + (incident.triggered_behaviors[key] ?? 0), 0)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function getWindowStart(windowKey: BoardWindowKey): Date {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (BOARD_WINDOW_DAYS[windowKey] - 1))
  return start
}

function getBuildingGroup(building: BuildingOverview): BuildingGroupKey | null {
  const code = (building.code ?? '').trim().toUpperCase()

  if (code.startsWith('LAB')) return 'LABS'
  if (code.startsWith('A')) return 'A'
  if (code.startsWith('B')) return 'B'
  if (code.startsWith('C')) return 'C'

  return null
}

function metricTone(value: number): 'safe' | 'warn' | 'danger' {
  if (value === 0) return 'safe'
  if (value <= 2) return 'warn'
  return 'danger'
}

export function BuildingsOverviewPage(): JSX.Element {
  const currentRole = useAuthStore((state) => state.user?.role)
  const isAcademicBoard = currentRole === 'ACADEMIC_MANAGER'
  const { hasAny } = usePermissions()
  const canAuditIncidents = hasAny([PERMISSIONS.INCIDENT_AUDIT, PERMISSIONS.INCIDENT_RESOLVE, PERMISSIONS.ALERT_ACKNOWLEDGE])

  const [buildings, setBuildings] = useState<BuildingOverview[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [query, setQuery] = useState('')
  const [boardWindow, setBoardWindow] = useState<BoardWindowKey>('7D')
  const [incidentActionMessage, setIncidentActionMessage] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isIncidentLoading, setIsIncidentLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [incidentError, setIncidentError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function load(): Promise<void> {
      setIsLoading(true)
      setError(null)
      try {
        const data = await getBuildingsOverview()
        if (isMounted) setBuildings(data)
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load buildings')
        }
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    void load()
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!isAcademicBoard) {
      setIncidents([])
      setIncidentError(null)
      setIsIncidentLoading(false)
      return
    }

    let isMounted = true

    async function loadBoardIncidents(): Promise<void> {
      setIsIncidentLoading(true)
      setIncidentError(null)
      try {
        const data = await getIncidents()
        if (isMounted) setIncidents(data)
      } catch (loadError) {
        if (isMounted) {
          setIncidentError(loadError instanceof Error ? loadError.message : 'Failed to load incident analytics')
        }
      } finally {
        if (isMounted) setIsIncidentLoading(false)
      }
    }

    void loadBoardIncidents()

    return () => {
      isMounted = false
    }
  }, [isAcademicBoard])

  const filteredBuildings = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return buildings

    return buildings.filter((building) =>
      [building.name, building.code ?? '', building.location ?? ''].join(' ').toLowerCase().includes(normalized),
    )
  }, [buildings, query])

  const totalRooms = useMemo(
    () => buildings.reduce((sum, building) => sum + building.total_rooms, 0),
    [buildings],
  )

  const totalOnlineRooms = useMemo(
    () => buildings.reduce((sum, building) => sum + building.rooms_online_count, 0),
    [buildings],
  )

  const groupSummaries = useMemo<BuildingGroupSummary[]>(() => {
    const definitions: Array<{ key: BuildingGroupKey; title: string; description: string }> = [
      { key: 'A', title: 'A Buildings', description: 'A1-A5, 3 floors, 15 rooms each floor' },
      { key: 'B', title: 'B Buildings', description: 'B1-B11, 6 floors, 5 rooms each floor' },
      { key: 'C', title: 'C Buildings', description: 'C4-C6, 2 floors, 5 rooms each floor' },
      { key: 'LABS', title: 'Labs', description: '10 specialized research and training labs' },
    ]

    return definitions
      .map((definition) => {
        const groupBuildings = filteredBuildings.filter((building) => getBuildingGroup(building) === definition.key)

        return {
          key: definition.key,
          title: definition.title,
          description: definition.description,
          buildingCount: groupBuildings.length,
          totalRooms: groupBuildings.reduce((sum, building) => sum + building.total_rooms, 0),
          roomsOnline: groupBuildings.reduce((sum, building) => sum + building.rooms_online_count, 0),
          activeSessions: groupBuildings.reduce((sum, building) => sum + building.active_sessions_count, 0),
        }
      })
      .filter((group) => group.buildingCount > 0)
  }, [filteredBuildings])

  const filteredBoardIncidents = useMemo(() => {
    const start = getWindowStart(boardWindow)
    return incidents.filter((incident) => {
      const flagged = new Date(incident.flagged_at)
      return !Number.isNaN(flagged.getTime()) && flagged >= start
    })
  }, [boardWindow, incidents])

  const boardRiskSummary = useMemo(() => {
    const summary = {
      total: filteredBoardIncidents.length,
      highCritical: 0,
      unreviewed: 0,
      uniqueStudents: 0,
      avgRiskScore: 0,
      severity: {
        LOW: 0,
        MEDIUM: 0,
        HIGH: 0,
        CRITICAL: 0,
      },
    }

    if (filteredBoardIncidents.length === 0) {
      return summary
    }

    const studentIds = new Set<string>()
    let totalRiskScore = 0

    for (const incident of filteredBoardIncidents) {
      const normalizedLevel = incident.risk_level.toUpperCase()
      if (normalizedLevel in summary.severity) {
        summary.severity[normalizedLevel as keyof typeof summary.severity] += 1
      }
      if (normalizedLevel === 'HIGH' || normalizedLevel === 'CRITICAL') {
        summary.highCritical += 1
      }
      if (!incident.reviewed) {
        summary.unreviewed += 1
      }

      studentIds.add(incident.student_id)
      totalRiskScore += incident.risk_score
    }

    summary.uniqueStudents = studentIds.size
    summary.avgRiskScore = Number((totalRiskScore / filteredBoardIncidents.length).toFixed(1))
    return summary
  }, [filteredBoardIncidents])

  const boardStudentBehavior = useMemo(() => {
    const counts = new Map<string, number>()
    let studentBehaviorEvents = 0

    for (const incident of filteredBoardIncidents) {
      for (const [behaviorKey, count] of Object.entries(incident.triggered_behaviors)) {
        if (!behaviorKey.startsWith('student_')) continue
        counts.set(behaviorKey, (counts.get(behaviorKey) ?? 0) + count)
        studentBehaviorEvents += count
      }
    }

    const ranked = Array.from(counts.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)

    const topRiskSessions = Array.from(
      filteredBoardIncidents.reduce((acc, incident) => {
        const studentEventCount = getBehaviorCount(incident, STUDENT_BEHAVIOR_KEYS)
        if (studentEventCount === 0) return acc
        const current = acc.get(incident.session_id) ?? { incidents: 0, events: 0 }
        current.incidents += 1
        current.events += studentEventCount
        acc.set(incident.session_id, current)
        return acc
      }, new Map<string, { incidents: number; events: number }>()),
    )
      .map(([sessionId, value]) => ({ sessionId, ...value }))
      .sort((a, b) => b.events - a.events)
      .slice(0, 5)

    return {
      totalEvents: studentBehaviorEvents,
      ranked,
      topRiskSessions,
    }
  }, [filteredBoardIncidents])

  const boardTeacherBehavior = useMemo(() => {
    const teacherSignalIncidents = filteredBoardIncidents.filter(
      (incident) => getBehaviorCount(incident, TEACHER_BEHAVIOR_KEYS) > 0,
    )

    const teacherSignalEvents = teacherSignalIncidents.reduce(
      (sum, incident) => sum + getBehaviorCount(incident, TEACHER_BEHAVIOR_KEYS),
      0,
    )

    const sessionRank = Array.from(
      teacherSignalIncidents.reduce((acc, incident) => {
        const count = getBehaviorCount(incident, TEACHER_BEHAVIOR_KEYS)
        const current = acc.get(incident.session_id) ?? { incidents: 0, events: 0 }
        current.incidents += 1
        current.events += count
        acc.set(incident.session_id, current)
        return acc
      }, new Map<string, { incidents: number; events: number }>()),
    )
      .map(([sessionId, value]) => ({ sessionId, ...value }))
      .sort((a, b) => b.events - a.events)
      .slice(0, 5)

    const dailyTrend = Array.from(
      teacherSignalIncidents.reduce((acc, incident) => {
        const dateKey = new Date(incident.flagged_at).toISOString().slice(0, 10)
        acc.set(dateKey, (acc.get(dateKey) ?? 0) + 1)
        return acc
      }, new Map<string, number>()),
    )
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date > b.date ? 1 : -1))

    const incidentShare = filteredBoardIncidents.length
      ? Number(((teacherSignalIncidents.length / filteredBoardIncidents.length) * 100).toFixed(1))
      : 0

    return {
      incidentCount: teacherSignalIncidents.length,
      signalEvents: teacherSignalEvents,
      incidentShare,
      sessionRank,
      dailyTrend,
    }
  }, [filteredBoardIncidents])

  async function handleAcknowledgeIncident(incidentId: string): Promise<void> {
    if (!canAuditIncidents) {
      setIncidentActionMessage('Your role does not allow incident acknowledgement.')
      return
    }

    setIncidentActionMessage(null)
    try {
      await reviewIncident(incidentId, { reviewer_notes: 'Acknowledged by board dashboard' })
      setIncidents((previous) =>
        previous.map((incident) => (incident.id === incidentId ? { ...incident, reviewed: true } : incident)),
      )
      setIncidentActionMessage('Incident acknowledged successfully.')
    } catch (actionError) {
      setIncidentActionMessage(actionError instanceof Error ? actionError.message : 'Failed to acknowledge incident')
    }
  }



  return (
    <main className="page campus-bg">
      <section className="right-content command-center-content">
        <header className="hero-header command-hero">
          <p className="eyebrow">Smart Classroom Platform</p>
          <h1 className="command-title">
            Command <span>Center</span>
          </h1>
          <p className="subcopy">
            Monitor buildings, session health, and room readiness from one operations workspace.
          </p>

          <div className="hero-metrics command-metrics admin-hero-metrics">
            <article className="stat-card command-metric-card tone-safe">
              <Building2 size={18} />
              <div>
                <strong>{buildings.length}</strong>
                <span>Total Buildings</span>
              </div>
            </article>
            <article className="stat-card command-metric-card tone-warn">
              <DoorOpen size={18} />
              <div>
                <strong>{totalRooms}</strong>
                <span>Total Rooms</span>
              </div>
            </article>
            <article className="stat-card command-metric-card tone-neutral">
              <Radio size={18} />
              <div>
                <strong>{totalOnlineRooms}</strong>
                <span>Rooms Online</span>
              </div>
            </article>
          </div>
        </header>

        <section className="panel search-panel building-search-control command-search-panel">
          <label htmlFor="building-search" className="search-label">
            <Search size={16} />
            Search groups by building name, code, or location
          </label>
          <input
            id="building-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type A1, B10, C4, LAB, location, or center name"
          />
        </section>

        {isLoading && <section className="panel">Loading buildings...</section>}
        {error && <section className="panel error-panel">{error}</section>}

        {!isLoading && !error && groupSummaries.length === 0 && (
          <section className="panel empty-state">
            <h2>No matching building group</h2>
            <p>Try a broader search to show available campus groups.</p>
          </section>
        )}

        <section className="section-title-row command-section-title">
          <div>
            <h2>Campus Building Groups</h2>
            <span>Select one group to open building-level monitoring.</span>
          </div>
          <span className="command-result-count">
            <LayoutGrid size={14} />
            {groupSummaries.length} groups
          </span>
        </section>

        <section className="building-grid command-grid">
          {groupSummaries.map((group) => {
            const sessionTone = metricTone(group.activeSessions)
            const statusTone = group.activeSessions > 0 ? 'safe' : 'neutral'
            const statusLabel = group.activeSessions > 0 ? 'Live' : 'Idle'

            return (
              <Link key={group.key} to={`/building-groups/${group.key}`} className="building-card group-card command-group-card">
                <div className="command-card-head">
                  <p className="building-code">{group.key}</p>
                  <span className={`status-pill tone-${statusTone}`}>{statusLabel}</span>
                </div>

                <div>
                  <h2>{group.title}</h2>
                  <p className="building-location">{group.description}</p>
                </div>

                <div className="building-kpis">
                  <div className="kpi-chip tone-safe">
                    <span className="kpi-label">Buildings</span>
                    <strong>{group.buildingCount}</strong>
                  </div>
                  <div className="kpi-chip tone-warn">
                    <span className="kpi-label">Total Rooms</span>
                    <strong>{group.totalRooms}</strong>
                  </div>
                  <div className="kpi-chip tone-neutral">
                    <span className="kpi-label">Rooms Online</span>
                    <strong>{group.roomsOnline}</strong>
                  </div>
                </div>
              </Link>
            )
          })}
        </section>
      </section>
    </main>
  )
}
