import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Play, Square, AlertCircle, RefreshCw, ChevronLeft, ChevronRight, Upload } from 'lucide-react'
import { CameraIngestPanel, type CameraIngestPanelHandle } from '../components/CameraIngestPanel'
import { useCameraInterval } from '../hooks/useCameraInterval'
import { useFrameUpload } from '../hooks/useFrameUpload'
import { changeSessionMode, getBehaviorLogs, getRoomHierarchy, getSessions, getTempFrame, getTempOutputFrame, runTempBatchInference, type TempBatchInferenceResponse, uploadAndAnalyzeImage } from '../services/api'
import type { SessionSummary, BehaviorLogEntry, TempOutputFrameResponse } from '../types'
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

  const [captureSource, setCaptureSource] = useState<'LIVE' | 'TEMP' | 'UPLOAD'>('LIVE')
  const [inferenceMode, setInferenceMode] = useState<'LEARNING' | 'TESTING'>('LEARNING')
  const [tempIndex, setTempIndex] = useState(0)
  const [tempTotal, setTempTotal] = useState(0)
  const [tempFilename, setTempFilename] = useState<string | null>(null)
  const [tempError, setTempError] = useState<string | null>(null)
  const [modeSwitching, setModeSwitching] = useState(false)
  const [modeSwitchError, setModeSwitchError] = useState<string | null>(null)

  const tempIndexRef = useRef(0)
  const tempFilenameRef = useRef<string | null>(null)

  // Resolved room context for the session (needed for admin users who have no room assignments)
  const [sessionBuildingId, setSessionBuildingId] = useState<string | null>(null)
  const [sessionRoomId, setSessionRoomId] = useState<string | null>(null)

  const intervalMode = inferenceMode === 'TESTING' ? 'TESTING' : 'NORMAL'

  // Use hooks — pass session room overrides so admin users bypass tutor-room-context
  const { intervalMs, sourceScope, isReady: intervalReady, error: intervalError } = useCameraInterval(intervalMode, {
    overrideBuildingId: sessionBuildingId,
    overrideRoomId: sessionRoomId,
  })

  const fetchTempFrame = useCallback(async (): Promise<string | null> => {
    if (!sessionId) return null

    try {
      const response = await getTempFrame(sessionId, {
        index: tempIndexRef.current,
        sort: 'name',
      })

      setTempIndex(response.index)
      setTempTotal(response.total)
      setTempFilename(response.filename)
      setTempError(null)

      tempIndexRef.current = response.next_index ?? response.index + 1
      tempFilenameRef.current = response.filename

      return response.image_base64
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load temp frame'
      setTempError(message)
      return null
    }
  }, [sessionId])

  const captureFrame = useCallback((): string | null | Promise<string | null> => {
    if (captureSource === 'TEMP') {
      return fetchTempFrame()
    }

    return cameraRef.current?.captureFrame() || null
  }, [captureSource, fetchTempFrame])

  const getSourceFilename = useCallback((): string | null => {
    if (captureSource !== 'TEMP') return null
    return tempFilenameRef.current
  }, [captureSource])

  const frameUpload = useFrameUpload(
    sessionId || null,
    intervalMs,
    session,
    captureFrame,
    0.5,
    inferenceMode,
    captureSource === 'TEMP',
    getSourceFilename,
  )

  // Output gallery state
  const [outputFrame, setOutputFrame] = useState<TempOutputFrameResponse | null>(null)
  const [outputIndex, setOutputIndex] = useState(0)
  const [outputLoading, setOutputLoading] = useState(false)
  const [outputError, setOutputError] = useState<string | null>(null)

  // Batch inference state
  const [batchProcessing, setBatchProcessing] = useState(false)
  const [batchResult, setBatchResult] = useState<TempBatchInferenceResponse | null>(null)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [autoPlayIndex, setAutoPlayIndex] = useState(0)
  const autoPlayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Upload inference state
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadProcessing, setUploadProcessing] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load session and resolve room hierarchy
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

        // Resolve the room hierarchy to get building_id for the interval hook
        if (foundSession.room_id) {
          try {
            const hierarchy = await getRoomHierarchy(foundSession.room_id)
            if (isMounted) {
              setSessionBuildingId(hierarchy.building.id)
              setSessionRoomId(foundSession.room_id)
            }
          } catch {
            // Non-fatal: the interval hook will try tutor context as fallback
            if (isMounted) {
              setSessionRoomId(foundSession.room_id)
            }
          }
        }
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

  useEffect(() => {
    if (!session) return
    setInferenceMode(session.mode === 'TESTING' ? 'TESTING' : 'LEARNING')
  }, [session?.mode])

  useEffect(() => {
    frameUpload.reset()
    setModeSwitchError(null)
  }, [inferenceMode, frameUpload.reset])

  useEffect(() => {
    frameUpload.reset()
    setTempError(null)
    tempIndexRef.current = 0
    setTempIndex(0)
    setTempTotal(0)
    setTempFilename(null)

    if (captureSource === 'TEMP') {
      cameraRef.current?.stopCamera()
    }
  }, [captureSource, frameUpload.reset])

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

  // Reload output gallery whenever a new frame is uploaded
  useEffect(() => {
    if (!sessionId || captureSource !== 'TEMP') return
    if (frameUpload.framesUploaded === 0) return

    let isMounted = true

    async function loadLatestOutput(): Promise<void> {
      setOutputLoading(true)
      try {
        const response = await getTempOutputFrame(sessionId!, {
          index: outputIndex,
          sort: 'mtime',
        })
        if (isMounted) {
          setOutputFrame(response)
          setOutputError(null)
          // After upload, jump to the latest output frame
          setOutputIndex(response.total > 0 ? response.total - 1 : 0)
        }
      } catch {
        if (isMounted) setOutputError('No annotated output frames yet')
      } finally {
        if (isMounted) setOutputLoading(false)
      }
    }

    void loadLatestOutput()

    return () => {
      isMounted = false
    }
  }, [sessionId, captureSource, frameUpload.framesUploaded])

  const loadOutputFrame = useCallback(async (idx: number) => {
    if (!sessionId) return
    setOutputLoading(true)
    try {
      const response = await getTempOutputFrame(sessionId, {
        index: idx,
        sort: 'name',
      })
      setOutputFrame(response)
      setOutputIndex(idx)
      setAnnotatedImage(response.image_base64)
      setOutputError(null)
    } catch {
      setOutputError('Failed to load output frame')
    } finally {
      setOutputLoading(false)
    }
  }, [sessionId])

  // Batch inference handler - called by Start Replay button
  const handleStartBatchInference = useCallback(async () => {
    if (!sessionId) return
    setBatchProcessing(true)
    setBatchError(null)
    setBatchResult(null)
    setAnnotatedImage(null)
    setOutputFrame(null)
    setAutoPlayIndex(0)

    try {
      const result = await runTempBatchInference(sessionId, {
        mode: inferenceMode,
        confidence_threshold: 0.5,
      })
      setBatchResult(result)

      // Show the last annotated image immediately
      if (result.last_annotated_image_base64) {
        setAnnotatedImage(result.last_annotated_image_base64)
      }

      // Load the first output frame to start the gallery
      if (result.processed > 0) {
        try {
          const firstFrame = await getTempOutputFrame(sessionId, { index: 0, sort: 'name' })
          setOutputFrame(firstFrame)
          setOutputIndex(0)
          setAnnotatedImage(firstFrame.image_base64)

          // Collect total detections from all results
          const allDetections = result.results.map(r => ({
            behavior_class: 'batch_detection',
            confidence: 0,
            detection_count: r.detection_count,
            filename: r.filename,
          }))
          setLastDetections(allDetections)
        } catch {
          // Still OK, we have the last_annotated from the batch response
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Batch inference failed'
      setBatchError(message)
    } finally {
      setBatchProcessing(false)
    }
  }, [sessionId, inferenceMode])

  // Auto-play through output frames
  const handleAutoPlay = useCallback(() => {
    if (!sessionId || !batchResult || batchResult.processed === 0) return

    if (autoPlayTimerRef.current) {
      clearInterval(autoPlayTimerRef.current)
      autoPlayTimerRef.current = null
      return
    }

    let idx = 0
    setAutoPlayIndex(0)
    void loadOutputFrame(0)

    autoPlayTimerRef.current = setInterval(() => {
      idx += 1
      if (idx >= (batchResult?.processed ?? 0)) {
        if (autoPlayTimerRef.current) {
          clearInterval(autoPlayTimerRef.current)
          autoPlayTimerRef.current = null
        }
        return
      }
      setAutoPlayIndex(idx)
      void loadOutputFrame(idx)
    }, 1500)
  }, [sessionId, batchResult, loadOutputFrame])

  // Cleanup auto-play on unmount
  useEffect(() => {
    return () => {
      if (autoPlayTimerRef.current) {
        clearInterval(autoPlayTimerRef.current)
      }
    }
  }, [])

  // Upload inference handler
  const handleUploadAndAnalyze = useCallback(async () => {
    if (!sessionId || !selectedFile) return
    setUploadProcessing(true)
    setUploadError(null)
    setAnnotatedImage(null)

    try {
      const result = await uploadAndAnalyzeImage(sessionId, selectedFile, {
        mode: inferenceMode,
        confidence_threshold: 0.5,
      })

      if (result.annotated_image_base64) {
        setAnnotatedImage(result.annotated_image_base64)
      }

      if (result.detections) {
        setLastDetections(result.detections)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Image upload failed'
      setUploadError(message)
    } finally {
      setUploadProcessing(false)
    }
  }, [sessionId, selectedFile, inferenceMode])

  const targetSessionMode = inferenceMode === 'TESTING' ? 'TESTING' : 'NORMAL'
  const modeMismatch = session ? session.mode !== targetSessionMode : false
  const canStartCapture = intervalReady && !modeMismatch

  const handleSwitchSessionMode = useCallback(async () => {
    if (!session) return
    if (session.mode === targetSessionMode) return

    setModeSwitching(true)
    setModeSwitchError(null)

    try {
      await changeSessionMode(session.id, targetSessionMode)
      setSession((prev) => (prev ? { ...prev, mode: targetSessionMode } : prev))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to switch session mode'
      setModeSwitchError(message)
    } finally {
      setModeSwitching(false)
    }
  }, [session, targetSessionMode])

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

        {tempError && captureSource === 'TEMP' && (
          <div className="error-panel">
            <AlertCircle size={16} />
            <p>{tempError}</p>
          </div>
        )}

        {modeMismatch && (
          <div className="warning-panel">
            <AlertCircle size={16} />
            <div className="warning-content">
              <p>
                Inference mode requires the session to be in <strong>{targetSessionMode}</strong>.
              </p>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleSwitchSessionMode}
                disabled={modeSwitching}
              >
                {modeSwitching ? 'Switching...' : `Switch to ${targetSessionMode}`}
              </button>
            </div>
          </div>
        )}

        {modeSwitchError && (
          <div className="error-panel">
            <AlertCircle size={16} />
            <p>{modeSwitchError}</p>
          </div>
        )}
      </section>

      <section className="content-grid-two">
        <article className="panel">
          <h2>Capture Source</h2>

          <div className="capture-options">
            <div className="control-block">
              <span className="control-label">Source</span>
              <div className="toggle-group">
                <button
                  className={`btn btn-sm ${captureSource === 'LIVE' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setCaptureSource('LIVE')}
                  disabled={frameUpload.isUploading}
                >
                  Live Camera
                </button>
                <button
                  className={`btn btn-sm ${captureSource === 'TEMP' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setCaptureSource('TEMP')}
                  disabled={frameUpload.isUploading}
                >
                  Temp Replay
                </button>
                <button
                  className={`btn btn-sm ${captureSource === 'UPLOAD' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setCaptureSource('UPLOAD')}
                  disabled={frameUpload.isUploading}
                >
                  Image Upload
                </button>
              </div>
            </div>

            <div className="control-block">
              <span className="control-label">Inference</span>
              <div className="toggle-group">
                <button
                  className={`btn btn-sm ${inferenceMode === 'LEARNING' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setInferenceMode('LEARNING')}
                  disabled={frameUpload.isUploading}
                >
                  Learning
                </button>
                <button
                  className={`btn btn-sm ${inferenceMode === 'TESTING' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setInferenceMode('TESTING')}
                  disabled={frameUpload.isUploading}
                >
                  Testing
                </button>
              </div>
            </div>
          </div>

          {captureSource === 'LIVE' ? (
            <CameraIngestPanel ref={cameraRef} />
          ) : captureSource === 'TEMP' ? (
            <div className="temp-replay-panel">
              <p className="muted">Streaming frames from backend/app/services/Temp.</p>
              <p>
                <strong>Frame:</strong>{' '}
                {tempTotal > 0 ? `${tempIndex + 1} / ${tempTotal}` : 'Waiting for frames'}
              </p>
              <p>
                <strong>Filename:</strong> {tempFilename ?? '-'}
              </p>
            </div>
          ) : (
            <div className="upload-panel">
              <p className="muted" style={{ marginBottom: '12px' }}>
                Select an image file from your device to analyze with YOLO inference.
              </p>
              <input 
                type="file" 
                accept="image/jpeg, image/png"
                ref={fileInputRef}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    setSelectedFile(e.target.files[0])
                    setAnnotatedImage(null) // clear previous
                  }
                }}
                className="file-input"
              />
              {selectedFile && (
                <p style={{ marginTop: '8px', fontSize: '12px', color: '#0066cc' }}>
                  Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                </p>
              )}
              {uploadError && (
                <div className="error-panel" style={{ marginTop: '12px' }}>
                  <AlertCircle size={16} />
                  <p>{uploadError}</p>
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: '12px' }}>
            {captureSource === 'TEMP' ? (
              /* Temp Replay: Use batch inference directly */
              <button
                className="btn btn-primary"
                onClick={handleStartBatchInference}
                disabled={batchProcessing}
                style={{ width: '100%' }}
              >
                {batchProcessing ? (
                  <><RefreshCw size={16} className="spin" /> Processing all frames...</>
                ) : (
                  <><Play size={16} /> Start Replay</>
                )}
              </button>
            ) : captureSource === 'UPLOAD' ? (
              /* Upload Image: Use the single upload endpoint */
              <button
                className="btn btn-primary"
                onClick={handleUploadAndAnalyze}
                disabled={uploadProcessing || !selectedFile}
                style={{ width: '100%' }}
              >
                {uploadProcessing ? (
                  <><RefreshCw size={16} className="spin" /> Analyzing Image...</>
                ) : (
                  <><Upload size={16} /> Upload & Analyze</>
                )}
              </button>
            ) : (
              /* Live Camera: Use the existing frame upload hooks */
              frameUpload.isUploading ? (
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
                  disabled={!canStartCapture}
                  style={{ width: '100%' }}
                >
                  <Play size={16} /> Start Uploading
                </button>
              )
            )}
          </div>

          <div style={{ marginTop: '16px', fontSize: '12px', lineHeight: '1.6' }}>
            <p>
              <strong>Status:</strong>{' '}
              {batchProcessing ? 'Batch Processing...' : uploadProcessing ? 'Analyzing...' : frameUpload.isUploading ? 'Capturing' : 'Idle'}
            </p>
            <p>
              <strong>Source:</strong> {captureSource}
            </p>
            <p>
              <strong>Inference:</strong> {inferenceMode}
            </p>
            <p>
              <strong>Session Mode:</strong> {session.mode}
            </p>
            <p>
              <strong>Interval:</strong> {intervalMs}ms ({sourceScope} scope)
            </p>
            {batchResult && (
              <>
                <p>
                  <strong>Batch Result:</strong> {batchResult.processed}/{batchResult.total_input} frames processed
                </p>
                <p>
                  <strong>Total Detections:</strong>{' '}
                  {batchResult.results.reduce((sum, r) => sum + r.detection_count, 0)}
                </p>
                {batchResult.errors > 0 && (
                  <p style={{ color: '#e53e3e' }}>
                    <strong>Errors:</strong> {batchResult.errors}
                  </p>
                )}
              </>
            )}
            {batchError && (
              <p style={{ color: '#e53e3e' }}>
                <strong>Error:</strong> {batchError}
              </p>
            )}
            {captureSource === 'LIVE' && (
              <>
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
              </>
            )}
          </div>
        </article>

        <article className="panel">
          <h2>Annotated Preview</h2>
          {annotatedImage ? (
            <>
              <img src={annotatedImage} alt="Annotated frame" style={{ width: '100%', borderRadius: '8px' }} />
              {outputFrame && (
                <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <p className="muted" style={{ margin: 0 }}>
                    {outputFrame.filename} — {outputIndex + 1} / {outputFrame.total}
                  </p>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={() => void loadOutputFrame(outputIndex - 1)}
                      disabled={outputIndex <= 0 || outputLoading}
                    >
                      <ChevronLeft size={14} /> Prev
                    </button>
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={handleAutoPlay}
                      disabled={!batchResult || batchResult.processed === 0}
                    >
                      {autoPlayTimerRef.current ? '⏸ Pause' : '▶ Play All'}
                    </button>
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={() => void loadOutputFrame(outputIndex + 1)}
                      disabled={!outputFrame.has_next || outputLoading}
                    >
                      Next <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              )}
            </>
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
              {batchProcessing ? 'Processing frames through YOLO...' : 'No preview available yet'}
            </div>
          )}
        </article>
      </section>

      {captureSource === 'TEMP' && (
        <section className="panel">
          <h2>Output Gallery (Temp_output)</h2>
          <p className="muted">
            Labeled images saved to <code>backend/app/services/Temp_output</code>
          </p>

          {outputError && (
            <p className="muted">{outputError}</p>
          )}

          {outputFrame ? (
            <>
              <img
                src={outputFrame.image_base64}
                alt={`Annotated output: ${outputFrame.filename}`}
                style={{ width: '100%', borderRadius: '8px', marginTop: '12px' }}
              />
              <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p className="muted">
                  {outputFrame.filename} — {outputIndex + 1} / {outputFrame.total}
                </p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => void loadOutputFrame(outputIndex - 1)}
                    disabled={outputIndex <= 0 || outputLoading}
                  >
                    Previous
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => void loadOutputFrame(outputIndex + 1)}
                    disabled={!outputFrame.has_next || outputLoading}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
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
                marginTop: '12px',
              }}
            >
              {outputLoading ? 'Loading...' : 'No output frames yet. Start a Temp Replay to generate labeled images.'}
            </div>
          )}
        </section>
      )}

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
