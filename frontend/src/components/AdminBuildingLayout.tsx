import { useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AdminSidebarNav } from './AdminSidebarNav'
import { getBuildingsOverview } from '../services/api'
import { resolveBuildingFromRouteParam } from '../utils/buildingRoute'

interface AdminMetric {
  label: string
  value: number | string
  tone?: 'safe' | 'warn' | 'danger' | 'neutral'
}

interface AdminBuildingLayoutProps {
  buildingId?: string
  title: string
  subtitle: string
  children: ReactNode
  sidebarContent?: ReactNode
  metrics?: AdminMetric[]
  eyebrow?: string
  showSidebarNav?: boolean
  showCommandLinks?: boolean
  wrapSidebarContentPanel?: boolean
}

export function AdminBuildingLayout({
  buildingId,
  title,
  subtitle,
  children,
  sidebarContent,
  metrics = [],
  eyebrow = 'Campus Management',
  showSidebarNav = true,
  showCommandLinks = true,
  wrapSidebarContentPanel = true,
}: AdminBuildingLayoutProps): JSX.Element {
  const location = useLocation()
  const hasBuildingContext = Boolean(buildingId)
  const [legacyBuildingId, setLegacyBuildingId] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function resolveLegacyBuildingId(): Promise<void> {
      if (!buildingId) {
        if (isMounted) {
          setLegacyBuildingId(null)
        }
        return
      }

      try {
        const buildings = await getBuildingsOverview()
        if (!isMounted) {
          return
        }

        const resolvedBuilding = resolveBuildingFromRouteParam(buildings, buildingId)
        setLegacyBuildingId(resolvedBuilding?.id ?? buildingId)
      } catch {
        if (isMounted) {
          setLegacyBuildingId(buildingId)
        }
      }
    }

    void resolveLegacyBuildingId()

    return () => {
      isMounted = false
    }
  }, [buildingId])

  const activeSection =
    location.pathname.endsWith('/devices')
      ? 'devices'
      : location.pathname.endsWith('/attendance')
        ? 'attendance'
      : 'sessions'

  return (
    <main className="page split-layout campus-bg admin-building-shell">
      <aside className="left-sidebar panel admin-building-sidebar">
        <div className="sidebar-header">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{hasBuildingContext ? 'Building Workspace' : 'Global Workspace'}</h1>
          <p className="muted">{hasBuildingContext ? `Building ${buildingId}` : 'All buildings and rooms'}</p>
        </div>

        {showSidebarNav ? <AdminSidebarNav active={activeSection} buildingId={buildingId} /> : null}

        {showCommandLinks ? (
          <>
            {hasBuildingContext ? (
              <Link className="inline-link" to={`/buildings/${legacyBuildingId ?? buildingId}?legacy=1`}>
                Open Legacy Dashboard
              </Link>
            ) : null}
          </>
        ) : null}

        {sidebarContent ? (
          wrapSidebarContentPanel ? (
            <section className="panel admin-side-panel">{sidebarContent}</section>
          ) : (
            <section className="admin-side-panel">{sidebarContent}</section>
          )
        ) : null}
      </aside>

      <section className="right-content">
        <header className="hero-header admin-page-header">
          <p className="eyebrow">Building Workspace</p>
          <h2>{title}</h2>
          <p className="subcopy">{subtitle}</p>

          {metrics.length > 0 ? (
            <div className="hero-metrics admin-hero-metrics">
              {metrics.map((metric) => (
                <article key={metric.label} className={`stat-card${metric.tone ? ` tone-${metric.tone}` : ''}`}>
                  <div className="admin-metric-stack">
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </header>

        {children}
      </section>
    </main>
  )
}
