import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { BuildingsOverviewPage } from './pages/BuildingsOverviewPage'
import { BuildingGroupPage } from './pages/BuildingGroupPage'
import { BuildingDashboardPage } from './pages/BuildingDashboardPage'
import { SessionDetailPage } from './pages/SessionDetailPage'

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<BuildingsOverviewPage />} />
        <Route path="/building-groups/:groupKey" element={<BuildingGroupPage />} />
        <Route path="/buildings/:buildingId" element={<BuildingDashboardPage />} />
        <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  )
}

export default App
