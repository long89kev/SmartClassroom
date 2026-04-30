import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Play, Square, AlertCircle, RefreshCw } from 'lucide-react'
import { CameraIngestPanel, type CameraIngestPanelHandle } from '../components/CameraIngestPanel'
import { useCameraInterval } from '../hooks/useCameraInterval'
import { useFrameUpload } from '../hooks/useFrameUpload'
import { getSessions, getBehaviorLogs } from '../services/api'
import type { SessionSummary, BehaviorLogEntry } from '../types'
import './SessionCameraCapturePage.css'

export function SessionCameraCapturePage(): JSX.Element {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()

  const cameraRef = useRef<CameraIngestPanelHandle | null>(null)
  const [session, setSession] = useState<SessionSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [behaviorLogs, setBehaviorLogs] = useState<BehaviorLogEntry[]>([])
  const [logOffset, setLogOffset] = useState(0)
  const [logTotal, setLogTotal] = useState(0)
  const [loadingLogs, setLoadingLogs] = useState(false)

  const [annotatedImage, setAnnotatedImage] = useState<string | null>(null)
  const [lastDetections, setLastDetections] = useState<any[]>([])

  // Use hooks
  const { intervalMs, sourceScope, isReady: intervalReady, error: intervalError } = useCameraInterval(
    session?.mode === 'TESTING' ? 'TESTING' : 'NORMAL',
  )

  const frameUpload = useFrameUpload(
    sessionId || null,
    intervalMs,
    session,
    () => cameraRef.current?.captureFrame() || null,
    0.5,
  )

  // Load session
  useEffect(() => {
    let isMounted = true

    async function load(): Promise<void> {
      if (!sessionId) return
      setLoading(true)
      setError(null)

      try {
        const sessions = await getSessions()
        const foundSession = sessions.find((s) => s.id === sessionId)

        if (!isMounted) return

        if (!foundSession) {
          setError('Session not found')
          return
        }

        if (foundSession.status !== 'ACTIVE') {
          setError('Session is not active')
          return
        }

        setSession(foundSession)
      } catch (err) {
        if (!isMounted) return
        setError(err instanceof Error ? err.message : 'Failed to load session')
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    void load()

    return () => {
      isMounted = false
    }
  }, [sessionId])

  // Load behavior logs
  useEffect(() => {
    let isMounted = true

    async function loadLogs(): Promise<void> {
      if (!sessionId) return

      setLoadingLogs(true)

      try {
        const response = await getBehaviorLogs(sessionId, {
          limit: 20,
          offset: logOffset,
        })

        if (!isMounted) return

        setBehaviorLogs(response.logs)
        setLogTotal(response.total)
      } catch (err) {
        if (!isMounted) return
        // Silent fail for logs
      } finally {
        if (isMounted) setLoadingLogs(false)
      }
    }

    void loadLogs()

    return () => {
      isMounted = false
    }
  }, [sessionId, logOffset])

  // Handle last response updates
  useEffect(() => {
    if (frameUpload.lastResponse) {
      setAnnotatedImage(frameUpload.lastResponse.annotated_image_base64)
      setLastDetections(frameUpload.lastResponse.detections || [])
    }
  }, [frameUpload.lastResponse])

  if (!sessionId) {
    return (
      <main className="page">
        <section className="panel error-panel">Missing session id in route.</section>
      </main>
    )
  }

  if (loading) {
    return (
      <main className="page">
        <section className="panel">Loading session details...</section>
      </main>
    )
  }

  if (error) {
    return (
      <main className="page">
        <section className="panel error-panel">
          <AlertCircle size={18} />
          <p>{error}</p>
        </section>
      </main>
    )
  }

  if (!session) {
    return (
      <main className="page">
        <section className="panel error-panel">Session not found.</section>
      </main>
    )
  }

  const logsPerPage = 20

  return (
    <main className="page campus-bg">
      <section className="panel">

        <h1>Camera Capture & Inference</h1>
        <p className="muted">Session: {sessionId}</p>

        {intervalError && (
          <div className="error-panel">
            <AlertCircle size={16} />
            <p>{intervalError}</p>
          </div>
        )}

        {frameUpload.lastError && (
          <div className="error-panel">
            <AlertCircle size={16} />
            <p>{frameUpload.lastError}</p>
          </div>
        )}
      </section>

      <section className="content-grid-two">
        <article className="panel">
          <h2>Live Camera Feed</h2>
          <CameraIngestPanel ref={cameraRef} />

          <div style={{ marginTop: '12px' }}>
            {frameUpload.isUploading ? (
              <button
                className="btn btn-danger"
                onClick={() => {
                  frameUpload.stopUploading()
                  cameraRef.current?.stopCamera()
                }}
                style={{ width: '100%' }}
              >
                <Square size={16} /> Stop Uploading
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={async () => {
                  await cameraRef.current?.startCamera()
                  if (cameraRef.current?.getState() === 'RUNNING') {
                    frameUpload.startUploading()
                  }
                }}
                disabled={!intervalReady}
                style={{ width: '100%' }}
              >
                <Play size={16} /> Start Uploading
              </button>
            )}
          </div>

          <div style={{ marginTop: '16px', fontSize: '12px', lineHeight: '1.6' }}>
            <p>
              <strong>Status:</strong> {frameUpload.isUploading ? 'Capturing' : 'Idle'}
            </p>
            <p>
              <strong>Interval:</strong> {intervalMs}ms ({sourceScope} scope)
            </p>
            <p>
              <strong>Mode:</strong> {session.mode}
            </p>
            <p>
              <strong>Detections:</strong> {lastDetections.length}
            </p>
            <p>
              <strong>Frames Uploaded:</strong> {frameUpload.framesUploaded}
            </p>
            {frameUpload.lastUploadAt && (
              <p>
                <strong>Last Upload:</strong>{' '}
                {frameUpload.lastUploadAt.toLocaleTimeString()}
              </p>
            )}
          </div>
        </article>

        <article className="panel">
          <h2>Annotated Preview</h2>
          {annotatedImage ? (
            <img src={annotatedImage} alt="Annotated frame" style={{ width: '100%', borderRadius: '8px' }} />
          ) : (
            <div
              style={{
                width: '100%',
                aspectRatio: '16/9',
                backgroundColor: '#f0f0f0',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#999',
              }}
            >
              No preview available yet
            </div>
          )}
        </article>
      </section>

      <section className="panel">
        <h2>Latest Detections ({lastDetections.length})</h2>
        {lastDetections.length > 0 ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Behavior Class</th>
                  <th>Confidence</th>
                  <th>Actor Type</th>
                  <th>Source Model</th>
                </tr>
              </thead>
              <tbody>
                {lastDetections.map((det, idx) => (
                  <tr key={idx}>
                    <td>{det.behavior_class}</td>
                    <td>{(det.confidence * 100).toFixed(1)}%</td>
                    <td>{det.actor_type || '-'}</td>
                    <td>{det.source_model || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No detections yet. Start capturing to see results.</p>
        )}
      </section>

      <section className="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2>Behavior Log History</h2>
          <button className="btn btn-sm" onClick={() => setLogOffset(0)} disabled={logOffset === 0 || loadingLogs}>
            <RefreshCw size={14} /> Reset
          </button>
        </div>

        {loadingLogs && <p className="muted">Loading logs...</p>}

        {behaviorLogs.length > 0 ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Actor ID</th>
                    <th>Behavior Class</th>
                    <th>Count</th>
                    <th>Confidence</th>
                    <th>Detected At</th>
                  </tr>
                </thead>
                <tbody>
                  {behaviorLogs.map((log) => (
                    <tr key={log.id}>
                      <td>{log.actor_id ? log.actor_id.slice(0, 8) : 'Unknown'}</td>
                      <td>{log.behavior_class}</td>
                      <td>{log.count}</td>
                      <td>{(log.yolo_confidence * 100).toFixed(1)}%</td>
                      <td>{new Date(log.detected_at).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'space-between' }}>
              <p className="muted">
                Showing {logOffset + 1}–{Math.min(logOffset + logsPerPage, logTotal)} of {logTotal}
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => setLogOffset(Math.max(0, logOffset - logsPerPage))}
                  disabled={logOffset === 0 || loadingLogs}
                >
                  Previous
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => setLogOffset(logOffset + logsPerPage)}
                  disabled={logOffset + logsPerPage >= logTotal || loadingLogs}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="muted">No behavior logs yet.</p>
        )}
      </section>
    </main>
  )
}
