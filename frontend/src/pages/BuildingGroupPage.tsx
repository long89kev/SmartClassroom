import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, DoorOpen, Radio, School, Search } from 'lucide-react'
import { getBuildingsOverview } from '../services/api'
import type { BuildingOverview } from '../types'

type BuildingGroupKey = 'A' | 'B' | 'C' | 'LABS'

interface GroupMeta {
  key: BuildingGroupKey
  title: string
  description: string
}

const GROUP_META: Record<BuildingGroupKey, GroupMeta> = {
  A: { key: 'A', title: 'A Buildings', description: 'A1-A5, each building has 3 floors and 15 rooms per floor.' },
  B: { key: 'B', title: 'B Buildings', description: 'B1-B11, each building has 6 floors and 5 rooms per floor.' },
  C: { key: 'C', title: 'C Buildings', description: 'C4-C6, each building has 2 floors and 5 rooms per floor.' },
  LABS: { key: 'LABS', title: 'Labs', description: '10 specialized research and training centers.' },
}

function metricTone(value: number): 'safe' | 'warn' | 'danger' {
  if (value === 0) return 'safe'
  if (value <= 2) return 'warn'
  return 'danger'
}

function getBuildingGroup(building: BuildingOverview): BuildingGroupKey | null {
  const code = (building.code ?? '').trim().toUpperCase()

  if (code.startsWith('LAB')) return 'LABS'
  if (code.startsWith('A')) return 'A'
  if (code.startsWith('B')) return 'B'
  if (code.startsWith('C')) return 'C'

  return null
}

function isGroupKey(value: string): value is BuildingGroupKey {
  return value === 'A' || value === 'B' || value === 'C' || value === 'LABS'
}

export function BuildingGroupPage(): JSX.Element {
  const { groupKey } = useParams<{ groupKey: string }>()

  const [buildings, setBuildings] = useState<BuildingOverview[]>([])
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const normalizedGroupKey = (groupKey ?? '').toUpperCase()
  const validGroupKey = isGroupKey(normalizedGroupKey) ? normalizedGroupKey : null
  const meta = validGroupKey ? GROUP_META[validGroupKey] : null

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

  const groupBuildings = useMemo(() => {
    if (!validGroupKey) return []

    const normalizedQuery = query.trim().toLowerCase()

    return buildings
      .filter((building) => getBuildingGroup(building) === validGroupKey)
      .filter((building) => {
        if (!normalizedQuery) return true
        return [building.name, building.code ?? '', building.location ?? '']
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery)
      })
      .sort((a, b) => (a.code ?? a.name).localeCompare(b.code ?? b.name))
  }, [buildings, query, validGroupKey])

  const totalRooms = useMemo(() => groupBuildings.reduce((sum, building) => sum + building.total_rooms, 0), [groupBuildings])
  const totalActiveSessions = useMemo(
    () => groupBuildings.reduce((sum, building) => sum + building.active_sessions_count, 0),
    [groupBuildings],
  )

  if (!meta) {
    return (
      <main className="page campus-bg">
        <section className="panel error-panel">Unknown building group. Please return to the group overview.</section>
        <Link to="/" className="inline-link">
          <ChevronLeft size={16} />
          Back to Group Overview
        </Link>
      </main>
    )
  }

  return (
    <main className="page campus-bg">
      <header className="hero-header">
        <p className="eyebrow">Campus Group View</p>
        <h1>{meta.title}</h1>
        <p className="subcopy">{meta.description} Click a building to open its real-time dashboard.</p>

        <div className="hero-metrics">
          <article className="stat-card">
            <School size={18} />
            <span>{groupBuildings.length} Buildings</span>
          </article>
          <article className="stat-card">
            <DoorOpen size={18} />
            <span>{totalRooms} Rooms</span>
          </article>
          <article className="stat-card">
            <Radio size={18} />
            <span>{totalActiveSessions} Active Sessions</span>
          </article>
        </div>
      </header>

      <section className="panel group-tools-panel">
        <Link to="/" className="inline-link">
          <ChevronLeft size={16} />
          Back to Group Overview
        </Link>

        <div>
          <label htmlFor="group-building-search" className="search-label">
            <Search size={16} />
            Search buildings in this group
          </label>
          <input
            id="group-building-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type building code or name"
          />
        </div>
      </section>

      {isLoading && <section className="panel">Loading buildings...</section>}
      {error && <section className="panel error-panel">{error}</section>}

      {!isLoading && !error && groupBuildings.length === 0 && (
        <section className="panel empty-state">
          <h2>No buildings match this filter</h2>
          <p>Try another search to view buildings in {meta.title}.</p>
        </section>
      )}

      <section className="building-grid">
        {groupBuildings.map((building) => {
          const sessionTone = metricTone(building.active_sessions_count)

          return (
            <Link key={building.id} to={`/buildings/${building.id}`} className="building-card">
              <div>
                <p className="building-code">{building.code ?? 'N/A code'}</p>
                <h2>{building.name}</h2>
                <p className="building-location">{building.location ?? 'No location set'}</p>
              </div>

              <div className="building-kpis">
                <div className={`kpi-chip tone-${sessionTone}`}>
                  <span className="kpi-label">Active Sessions</span>
                  <strong>{building.active_sessions_count}</strong>
                </div>
                <div className="kpi-chip tone-safe">
                  <span className="kpi-label">Rooms Online</span>
                  <strong>{building.rooms_online_count}</strong>
                </div>
                <div className="kpi-chip tone-neutral">
                  <span className="kpi-label">Total Rooms</span>
                  <strong>{building.total_rooms}</strong>
                </div>
              </div>
            </Link>
          )
        })}
      </section>
    </main>
  )
}
