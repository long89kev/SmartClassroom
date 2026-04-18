import type { JSX } from 'react'
import { Link } from 'react-router-dom'
import { ActivitySquare, Monitor, School } from 'lucide-react'

type AdminNavSection = 'sessions' | 'devices' | 'attendance'

interface AdminSidebarNavProps {
  active: AdminNavSection
  buildingId?: string
}

interface NavSection {
  key: AdminNavSection
  label: string
  icon: typeof School
}

const NAV_SECTIONS: NavSection[] = [
  { key: 'sessions', label: 'Sessions', icon: School },
  { key: 'devices', label: 'Devices', icon: Monitor },
  { key: 'attendance', label: 'Attendance', icon: ActivitySquare },
]

function resolveSectionTarget(section: AdminNavSection, buildingId?: string): string | null {
  if (buildingId) {
    if (section === 'attendance') {
      return '/attendance'
    }

    return `/buildings/${buildingId}/${section}`
  }

  if (section === 'sessions') {
    return '/'
  }

  if (section === 'devices') {
    return '/devices'
  }

  if (section === 'attendance') {
    return '/attendance'
  }

  return null
}

export function AdminSidebarNav({ active, buildingId }: AdminSidebarNavProps): JSX.Element {
  return (
    <nav className="admin-side-nav" aria-label="Workspace sections">
      {NAV_SECTIONS.map((section) => {
        const Icon = section.icon
        const target = resolveSectionTarget(section.key, buildingId)

        if (!target) {
          return (
            <span key={section.key} className="admin-side-nav-link is-disabled" aria-disabled="true">
              <Icon size={15} />
              <span>{section.label}</span>
            </span>
          )
        }

        return (
          <Link
            key={section.key}
            to={target}
            className={`admin-side-nav-link${active === section.key ? ' is-active' : ''}`}
          >
            <Icon size={15} />
            <span>{section.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
