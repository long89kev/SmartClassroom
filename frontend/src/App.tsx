import type { JSX } from 'react'
import { useEffect } from 'react'
import { BrowserRouter as Router, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import './App.css'
import { BuildingsOverviewPage } from './pages/BuildingsOverviewPage'
import { BuildingGroupPage } from './pages/BuildingGroupPage'
import { BuildingDashboardPage } from './pages/BuildingDashboardPage'
import { SessionDetailPage } from './pages/SessionDetailPage'
import { StudentDashboardPage } from './pages/StudentDashboardPage'
import { LoginPage } from './pages/LoginPage'
import { ProtectedRoute } from './components/ProtectedRoute'
import { useAuthStore } from './store/auth'
import { getCurrentPermissions, getCurrentUser, logout } from './services/auth'

function AuthenticatedLayout(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const token = useAuthStore((state) => state.token)
  const user = useAuthStore((state) => state.user)
  const setAuthSession = useAuthStore((state) => state.setAuthSession)
  const setPermissions = useAuthStore((state) => state.setPermissions)
  const clearAuth = useAuthStore((state) => state.clearAuth)

  useEffect(() => {
    let isMounted = true

    async function hydrateAuthContext(): Promise<void> {
      if (!token) {
        return
      }

      try {
        const [freshUser, permissions] = await Promise.all([
          getCurrentUser(),
          getCurrentPermissions(),
        ])

        if (!isMounted) {
          return
        }

        if (!user) {
          setAuthSession(token, freshUser, permissions)
          return
        }

        setPermissions(permissions)
      } catch {
        if (!isMounted) {
          return
        }

        clearAuth()
        navigate('/login', { replace: true })
      }
    }

    void hydrateAuthContext()

    return () => {
      isMounted = false
    }
  }, [clearAuth, navigate, setAuthSession, setPermissions, token, user])

  function handleLogout(): void {
    void logout().catch(() => undefined)
    clearAuth()
    navigate('/login', { replace: true })
  }

  const showBack = location.pathname !== '/'

  return (
    <>
      <header className="auth-topbar">
        <div className="auth-topbar-inner">
          <div className="auth-topbar-left">
            {showBack ? (
              <button
                type="button"
                className="inline-link inline-link-button auth-topbar-back"
                onClick={() => navigate(-1)}
              >
                Back
              </button>
            ) : null}
            <p className="auth-user">Signed in as {user?.username ?? 'Unknown'}</p>
          </div>
          <button type="button" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </header>
      <Outlet />
    </>
  )
}

function HomeRoute(): JSX.Element {
  const user = useAuthStore((state) => state.user)

  if (user?.role === 'STUDENT') {
    return <Navigate to="/students/me/dashboard" replace />
  }

  return <BuildingsOverviewPage />
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AuthenticatedLayout />}>
            <Route path="/" element={<HomeRoute />} />
            <Route path="/building-groups/:groupKey" element={<BuildingGroupPage />} />
            <Route path="/buildings/:buildingId" element={<BuildingDashboardPage />} />
            <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
            <Route path="/students/me/dashboard" element={<StudentDashboardPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  )
}

export default App
