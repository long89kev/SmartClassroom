import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Building2, DoorOpen, LayoutGrid, Radio, Search } from 'lucide-react'
import { getBuildingsOverview } from '../services/api'
import type { BuildingOverview } from '../types'
import { AdminSidebarNav } from '../components/AdminSidebarNav'

type BuildingGroupKey = 'A' | 'B' | 'C' | 'LABS'

interface BuildingGroupSummary {
  key: BuildingGroupKey
  title: string
  description: string
  buildingCount: number
  totalRooms: number
  roomsOnline: number
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

export function DevicesGroupsOverviewPage(): JSX.Element {
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
        if (isMounted) {
          setBuildings(data)
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load buildings')
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    void load()

    return () => {
      isMounted = false
    }
  }, [])

  const filteredBuildings = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) {
      return buildings
    }

    return buildings.filter((building) =>
      [building.name, building.code ?? '', building.location ?? ''].join(' ').toLowerCase().includes(normalized),
    )
  }, [buildings, query])

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
        }
      })
      .filter((group) => group.buildingCount > 0)
  }, [filteredBuildings])

  const totalRooms = useMemo(
    () => filteredBuildings.reduce((sum, building) => sum + building.total_rooms, 0),
    [filteredBuildings],
  )

  const totalOnlineRooms = useMemo(
    () => filteredBuildings.reduce((sum, building) => sum + building.rooms_online_count, 0),
    [filteredBuildings],
  )

  return (
    <main className="page split-layout campus-bg command-center-layout">
      <aside className="left-sidebar panel command-side-panel">
        <div className="sidebar-header">
          <p className="eyebrow">Navigation</p>
          <h1>Device Control Panel</h1>
          <p className="muted">Choose a building group to open device operations.</p>
        </div>

        <AdminSidebarNav active="devices" />
      </aside>

      <section className="right-content command-center-content">
        <header className="hero-header command-hero">
          <p className="eyebrow">Smart Classroom Platform</p>
          <h1 className="command-title">
            Device <span>Operations</span>
          </h1>
          <p className="subcopy">
            Navigate by campus group first, then open building-scoped device tables for faster query performance.
          </p>

          <div className="hero-metrics command-metrics">
            <article className="stat-card command-metric-card">
              <Building2 size={18} />
              <div>
                <strong>{filteredBuildings.length}</strong>
                <span>Total Buildings</span>
              </div>
            </article>
            <article className="stat-card command-metric-card">
              <DoorOpen size={18} />
              <div>
                <strong>{totalRooms}</strong>
                <span>Total Rooms</span>
              </div>
            </article>
            <article className="stat-card command-metric-card">
              <Radio size={18} />
              <div>
                <strong>{totalOnlineRooms}</strong>
                <span>Rooms Online</span>
              </div>
            </article>
          </div>
        </header>

        <section className="panel search-panel building-search-control command-search-panel">
          <label htmlFor="devices-group-search" className="search-label">
            <Search size={16} />
            Search groups by building name, code, or location
          </label>
          <input
            id="devices-group-search"
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
            <p>Try a broader search to show available device groups.</p>
          </section>
        )}

        <section className="section-title-row command-section-title">
          <div>
            <h2>Device Building Groups</h2>
            <span>Select one group to open building-level device operations.</span>
          </div>
          <span className="command-result-count">
            <LayoutGrid size={14} />
            {groupSummaries.length} groups
          </span>
        </section>

        <section className="building-grid command-grid">
          {groupSummaries.map((group) => {
            const onlineTone = metricTone(group.roomsOnline)
            const statusTone = group.roomsOnline > 0 ? 'safe' : 'neutral'
            const statusLabel = group.roomsOnline > 0 ? 'Live' : 'Idle'

            return (
              <Link key={group.key} to={`/devices/groups/${group.key}`} className="building-card group-card command-group-card">
                <div className="command-card-head">
                  <p className="building-code">{group.key}</p>
                  <span className={`status-pill tone-${statusTone}`}>{statusLabel}</span>
                </div>

                <div>
                  <h2>{group.title}</h2>
                  <p className="building-location">{group.description}</p>
                </div>

                <div className="building-kpis">
                  <div className="kpi-chip tone-neutral">
                    <span className="kpi-label">Buildings</span>
                    <strong>{group.buildingCount}</strong>
                  </div>
                  <div className="kpi-chip tone-safe">
                    <span className="kpi-label">Total Rooms</span>
                    <strong>{group.totalRooms}</strong>
                  </div>
                  <div className={`kpi-chip tone-${onlineTone}`}>
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
