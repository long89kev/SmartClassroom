import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CheckCircle2, Clock, RefreshCw, UserX, Video, VideoOff, Wifi, WifiOff } from 'lucide-react'
import type { AttendanceSessionReport } from '../types'
import { getSessionAttendanceReport } from '../services/api'
import { toLocalDateTime } from '../utils/time'
import './AttendanceLivePanel.css'

interface AttendanceLivePanelProps {
  sessionId: string
  streamUrl?: string  // defaults to http://localhost:5050
}

interface ServiceStatus {
  session_id: string | null
  is_running: boolean
  total_recognized: number
  camera_active: boolean
  recognized_students: Array<{
    student_code: string
    student_name: string
    confidence: number
    timestamp: string
  }>
  last_recognition_at: string | null
}

const DEFAULT_STREAM_URL = 'http://localhost:5051'

export function AttendanceLivePanel({ sessionId, streamUrl }: AttendanceLivePanelProps): JSX.Element {
  const baseUrl = streamUrl ?? DEFAULT_STREAM_URL

  const [report, setReport] = useState<AttendanceSessionReport | null>(null)
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null)
  const [streamReachable, setStreamReachable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchReport = useCallback(async () => {
    try {
      const data = await getSessionAttendanceReport(sessionId)
      setReport(data)
      setLastRefresh(new Date())
    } catch {
      // silently fail — session might not have attendance configured
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  const fetchServiceStatus = useCallback(async () => {
    try {
      const resp = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(2000) })
      if (resp.ok) {
        const data: ServiceStatus = await resp.json()
        setServiceStatus(data)
        setStreamReachable(true)
      } else {
        setStreamReachable(false)
      }
    } catch {
      setStreamReachable(false)
      setServiceStatus(null)
    }
  }, [baseUrl])

  // Initial load
  useEffect(() => {
    void fetchReport()
    void fetchServiceStatus()
  }, [fetchReport, fetchServiceStatus])

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    intervalRef.current = setInterval(() => {
      void fetchReport()
      void fetchServiceStatus()
    }, 5000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoRefresh, fetchReport, fetchServiceStatus])

  const totals = report?.totals ?? { present: 0, late: 0, absent: 0, enrolled: 0 }
  const attendanceRate = totals.enrolled > 0 ? ((totals.present + totals.late) / totals.enrolled * 100) : 0

  return (
    <div className="attendance-live-panel">
      {/* Header */}
      <div className="alp-header">
        <div className="alp-header-left">
          <Camera size={20} />
          <h2>Live Attendance</h2>
          <span className={`alp-service-badge ${streamReachable ? 'alp-online' : 'alp-offline'}`}>
            {streamReachable ? <><Wifi size={12} /> Service Online</> : <><WifiOff size={12} /> Service Offline</>}
          </span>
        </div>
        <div className="alp-header-right">
          <label className="alp-toggle" id="attendance-auto-refresh-toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>Auto-refresh</span>
          </label>
          <button
            type="button"
            className="alp-btn-refresh"
            id="attendance-refresh-btn"
            onClick={() => { void fetchReport(); void fetchServiceStatus() }}
            title="Refresh now"
          >
            <RefreshCw size={14} />
          </button>
          {lastRefresh && (
            <span className="alp-last-refresh">
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="alp-summary-cards">
        <div className="alp-card alp-card-enrolled">
          <span className="alp-card-value">{totals.enrolled}</span>
          <span className="alp-card-label">Enrolled</span>
        </div>
        <div className="alp-card alp-card-present">
          <CheckCircle2 size={16} />
          <span className="alp-card-value">{totals.present}</span>
          <span className="alp-card-label">Present</span>
        </div>
        <div className="alp-card alp-card-late">
          <Clock size={16} />
          <span className="alp-card-value">{totals.late}</span>
          <span className="alp-card-label">Late</span>
        </div>
        <div className="alp-card alp-card-absent">
          <UserX size={16} />
          <span className="alp-card-value">{totals.absent}</span>
          <span className="alp-card-label">Absent</span>
        </div>
        <div className="alp-card alp-card-rate">
          <span className="alp-card-value">{attendanceRate.toFixed(0)}%</span>
          <span className="alp-card-label">Rate</span>
        </div>
      </div>

      {/* Main Content: Camera + Student Table */}
      <div className="alp-content">
        {/* Camera Feed */}
        <div className="alp-camera-section">
          <div className="alp-camera-header">
            {streamReachable ? <Video size={16} /> : <VideoOff size={16} />}
            <span>Camera Feed</span>
          </div>
          <div className="alp-camera-feed" id="attendance-camera-feed">
            {streamReachable ? (
              <img
                src={`${baseUrl}/video_feed`}
                alt="Live webcam feed"
                className="alp-camera-img"
              />
            ) : (
              <div className="alp-camera-offline">
                <VideoOff size={48} />
                <p>Attendance service not running</p>
                <p className="alp-camera-hint">
                  Start with: <code>python attendance_service.py</code>
                </p>
              </div>
            )}
          </div>
          {serviceStatus && streamReachable && (
            <div className="alp-camera-stats">
              <span>Recognized: <strong>{serviceStatus.total_recognized}</strong></span>
              {serviceStatus.last_recognition_at && (
                <span>Last: {new Date(serviceStatus.last_recognition_at).toLocaleTimeString()}</span>
              )}
            </div>
          )}
        </div>

        {/* Student Roster */}
        <div className="alp-roster-section">
          <div className="alp-roster-header">
            <span>Student Roster</span>
            {report && (
              <span className="alp-roster-count">{report.students.length} students</span>
            )}
          </div>
          <div className="alp-roster-table-wrapper" id="attendance-roster-table">
            {loading ? (
              <div className="alp-loading">Loading attendance data...</div>
            ) : report && report.students.length > 0 ? (
              <table className="alp-roster-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Time</th>
                    <th>Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {report.students.map((s) => (
                    <tr key={s.student_id} className={`alp-row-${s.status.toLowerCase()}`}>
                      <td className="alp-code">{s.student_code}</td>
                      <td>{s.student_name}</td>
                      <td>
                        <span className={`alp-status-badge alp-status-${s.status.toLowerCase()}`}>
                          {s.status}
                        </span>
                      </td>
                      <td className="alp-time">
                        {s.first_seen_at ? toLocalDateTime(s.first_seen_at) : '—'}
                      </td>
                      <td className="alp-conf">
                        {s.confidence != null ? `${(s.confidence * 100).toFixed(0)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="alp-empty">No attendance data for this session yet.</div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Recognitions Feed (from service) */}
      {serviceStatus && serviceStatus.recognized_students.length > 0 && (
        <div className="alp-recent-feed">
          <h3>Recent Recognitions</h3>
          <div className="alp-recent-list">
            {[...serviceStatus.recognized_students].reverse().slice(0, 5).map((r, i) => (
              <div key={`${r.student_code}-${i}`} className="alp-recent-item">
                <CheckCircle2 size={14} className="alp-recent-icon" />
                <span className="alp-recent-name">{r.student_name}</span>
                <span className="alp-recent-code">{r.student_code}</span>
                <span className="alp-recent-conf">{(r.confidence * 100).toFixed(0)}%</span>
                <span className="alp-recent-time">{new Date(r.timestamp).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
