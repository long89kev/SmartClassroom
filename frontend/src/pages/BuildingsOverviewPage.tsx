import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Building2, DoorOpen, Radio, Search } from 'lucide-react'
import { getBuildingsOverview } from '../services/api'
import type { BuildingOverview } from '../types'

type BuildingGroupKey = 'A' | 'B' | 'C' | 'LABS'

interface BuildingGroupSummary {
  key: BuildingGroupKey
  title: string
  description: string
  buildingCount: number
  totalRooms: number
  activeSessions: number
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
  const [buildings, setBuildings] = useState<BuildingOverview[]>([])
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  const filteredBuildings = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return buildings

    return buildings.filter((building) =>
      [building.name, building.code ?? '', building.location ?? ''].join(' ').toLowerCase().includes(normalized),
    )
  }, [buildings, query])

  const totalActiveSessions = useMemo(
    () => buildings.reduce((sum, building) => sum + building.active_sessions_count, 0),
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
          activeSessions: groupBuildings.reduce((sum, building) => sum + building.active_sessions_count, 0),
        }
      })
      .filter((group) => group.buildingCount > 0)
  }, [filteredBuildings])

  return (
    <main className="page campus-bg">
      <header className="hero-header">
        <p className="eyebrow">Smart Classroom Command Center</p>
        <h1>Campus Building Grid</h1>
        <p className="subcopy">
          Select a group first (A, B, C, Labs), then choose a building inside that group.
        </p>

        <div className="hero-metrics">
          <article className="stat-card">
            <Building2 size={18} />
            <span>{buildings.length} Buildings</span>
          </article>
          <article className="stat-card">
            <Radio size={18} />
            <span>{totalActiveSessions} Active Sessions</span>
          </article>
          <article className="stat-card">
            <DoorOpen size={18} />
            <span>{totalOnlineRooms} Rooms Online</span>
          </article>
        </div>
      </header>

      <section className="panel search-panel">
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
          <p>Try a broader search or create sessions to populate live data.</p>
          <div className="quick-actions">
            <span>Quick actions:</span>
            <ul>
              <li>Review all incidents from the current dashboard filters.</li>
              <li>Open a building and start a classroom session.</li>
              <li>Validate camera feed and YOLO inference with testing mode.</li>
            </ul>
          </div>
        </section>
      )}

      <section className="building-grid">
        {groupSummaries.map((group) => {
          const sessionTone = metricTone(group.activeSessions)

          return (
            <Link key={group.key} to={`/building-groups/${group.key}`} className="building-card group-card">
              <div>
                <p className="building-code">{group.key}</p>
                <h2>{group.title}</h2>
                <p className="building-location">{group.description}</p>
              </div>

              <div className="building-kpis">
                <div className={`kpi-chip tone-${sessionTone}`}>
                  <span className="kpi-label">Buildings</span>
                  <strong>{group.buildingCount}</strong>
                </div>
                <div className="kpi-chip tone-safe">
                  <span className="kpi-label">Total Rooms</span>
                  <strong>{group.totalRooms}</strong>
                </div>
                <div className="kpi-chip tone-neutral">
                  <span className="kpi-label">Active Sessions</span>
                  <strong>{group.activeSessions}</strong>
                </div>
              </div>
            </Link>
          )
        })}
      </section>
    </main>
  )
}
