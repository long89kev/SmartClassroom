import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Play, Square, AlertCircle, RefreshCw, Upload, Camera, CameraOff, Film, Activity, Check, X } from 'lucide-react'
import { CameraIngestPanel, type CameraIngestPanelHandle } from '../components/CameraIngestPanel'
import { useCameraInterval } from '../hooks/useCameraInterval'
import { useFrameUpload } from '../hooks/useFrameUpload'
import { changeSessionMode, getBehaviorLogs, getRoomHierarchy, getSessions, getTempFrame, getTempOutputFrame, ingestLearningMode, ingestTestingMode, runTempBatchInference, type TempBatchInferenceResponse, uploadAndAnalyzeImage, getSessionAttendanceReport, confirmSessionDetections } from '../services/api'
import type { BehaviorLogEntry, LearningModeResponse, SessionSummary, TempOutputFrameResponse, TestingModeResponse } from '../types'
import './SessionCameraCapturePage.css'

export function SessionCameraCapturePage(): JSX.Element {
  const { sessionId } = useParams<{ sessionId: string }>()

  const cameraRef = useRef<CameraIngestPanelHandle | null>(null)
  const [session, setSession] = useState<SessionSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [behaviorLogs, setBehaviorLogs] = useState<BehaviorLogEntry[]>([])
  const [logOffset, setLogOffset] = useState(0)
  const [logTotal, setLogTotal] = useState(0)
  const [loadingLogs, setLoadingLogs] = useState(false)

  const [, setAnnotatedImage] = useState<string | null>(null)
  const [lastDetections, setLastDetections] = useState<any[]>([])

  const [reviewMode, setReviewMode] = useState(false)
  interface PendingFrame {
    id: string
    timestamp: Date
    mode: 'LEARNING' | 'TESTING'
    detections: any[]
    annotated_image_base64: string
    filename: string
    student_id?: string
  }
  const [pendingApprovals, setPendingApprovals] = useState<PendingFrame[]>([])
  const [captureSource, setCaptureSource] = useState<'LIVE' | 'UPLOAD'>('LIVE')
  const [inferenceMode, setInferenceMode] = useState<'LEARNING' | 'TESTING'>('LEARNING')
  const [tempIndex, setTempIndex] = useState(0)
  const [tempTotal, setTempTotal] = useState(0)
  const [tempFilename, setTempFilename] = useState<string | null>(null)
  const [tempError, setTempError] = useState<string | null>(null)
  const [modeSwitching, setModeSwitching] = useState(false)
  const [modeSwitchError, setModeSwitchError] = useState<string | null>(null)
  const [cameraState, setCameraState] = useState<'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR'>('IDLE')
  const [cameraSourceType, setCameraSourceType] = useState<'CAMERA' | 'VIDEO_FILE'>('CAMERA')
  const [cameraVideoFileName, setCameraVideoFileName] = useState<string | null>(null)
  const [diagnosticLogs, setDiagnosticLogs] = useState<{ id: number; level: string; message: string; time: Date }[]>([])
  const logIdRef = useRef(0)
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null)
  const [enrolledStudents, setEnrolledStudents] = useState<any[]>([])
  const [loadingStudents, setLoadingStudents] = useState(false)

  // Intercept console messages for the UI monitor
  useEffect(() => {
    const originalDebug = console.debug
    const originalInfo = console.info
    const originalWarn = console.warn
    const originalError = console.error

    const addLog = (level: string, ...args: any[]) => {
      const message = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
          const cache = new Set();
          try {
            return JSON.stringify(arg, (key, value) => {
              if (typeof value === 'object' && value !== null) {
                if (cache.has(value)) return '[Circular]';
                cache.add(value);
              }
              return typeof value === 'bigint' ? value.toString() : value;
            }, 2);
          } catch {
            return `[Complex Object: ${Object.prototype.toString.call(arg)}]`;
          } finally {
            cache.clear();
          }
        }
        return String(arg);
      }).join(' ')
      
      const newLog = { id: ++logIdRef.current, level, message, time: new Date() }
      setDiagnosticLogs(prev => [newLog, ...prev].slice(0, 50))
    }

    console.debug = (...args) => {
      originalDebug(...args)
      addLog('DEBUG', ...args)
    }
    console.info = (...args) => {
      originalInfo(...args)
      addLog('INFO', ...args)
    }
    console.warn = (...args) => {
      originalWarn(...args)
      addLog('WARN', ...args)
    }
    console.error = (...args) => {
      originalError(...args)
      addLog('ERROR', ...args)
    }

    return () => {
      console.debug = originalDebug
      console.info = originalInfo
      console.warn = originalWarn
      console.error = originalError
    }
  }, [])
  const [diagnosticMessage, setDiagnosticMessage] = useState<string | null>(null)

  const tempIndexRef = useRef(0)
  const tempFilenameRef = useRef<string | null>(null)

  // --- Gallery Logic ---
  const [galleryImages, setGalleryImages] = useState<{
    url: string
    timestamp: Date
    detections: any[]
  }[]>([])
  const [featuredImage, setFeaturedImage] = useState<{
    url: string
    timestamp: Date
    detections: any[]
  } | null>(null)

  const handleFrameUploadSuccess = useCallback(
    (response: LearningModeResponse | TestingModeResponse): void => {
      if (reviewMode) {
        setPendingApprovals((prev) => [
          ...prev,
          {
            id: Math.random().toString(36).substring(2, 11),
            timestamp: new Date(),
            mode: response.mode as 'LEARNING' | 'TESTING',
            detections: response.detections,
            annotated_image_base64: response.annotated_image_base64,
            filename: response.saved_output_path || `frame_${Date.now()}.jpg`,
            student_id: selectedStudentId || undefined,
          },
        ])
        return
      }

      const newImage = {
        url: response.annotated_image_base64,
        timestamp: new Date(),
        detections: response.detections,
      }

      setGalleryImages((prev) => [newImage, ...prev].slice(0, 12))
      setFeaturedImage(newImage)
      setAnnotatedImage(newImage.url)
      setLastDetections(newImage.detections || [])
    },
    [reviewMode, selectedStudentId],
  )

  const handleFrameUploadError = useCallback((errorMessage: string): void => {
    setDiagnosticMessage(errorMessage)
  }, [])

  const handleSelectFeatured = useCallback((img: any) => {
    setFeaturedImage(img)
    setAnnotatedImage(img.url)
    setLastDetections(img.detections || [])
  }, [])

  const handleConfirmPending = async (frame: PendingFrame) => {
    try {
      if (!sessionId) return
      await confirmSessionDetections(sessionId, {
        mode: frame.mode,
        student_id: frame.student_id,
        detections: frame.detections,
        annotated_image_base64: frame.annotated_image_base64,
        filename: frame.filename,
      })
      
      const newImage = {
        url: frame.annotated_image_base64,
        timestamp: frame.timestamp,
        detections: frame.detections,
      }
      setGalleryImages((prev) => [newImage, ...prev].slice(0, 12))
      setFeaturedImage(newImage)
      setAnnotatedImage(newImage.url)
      setLastDetections(frame.detections || [])
      
      setPendingApprovals(prev => prev.filter(p => p.id !== frame.id))
      setLogOffset(0) // Refresh behavior logs
    } catch (err) {
      console.error('Failed to confirm detections', err)
      setDiagnosticMessage('Failed to confirm detections.')
    }
  }

  const handleRejectPending = (frameId: string) => {
    setPendingApprovals(prev => prev.filter(p => p.id !== frameId))
  }

  const handleConfirmAll = async () => {
    // For simplicity, we just confirm them one by one sequentially
    // A bulk endpoint would be better, but this works for now
    if (!sessionId) return
    
    // Create a copy to iterate
    const framesToConfirm = [...pendingApprovals]
    
    for (const frame of framesToConfirm) {
      try {
        await confirmSessionDetections(sessionId, {
          mode: frame.mode,
          student_id: frame.student_id,
          detections: frame.detections,
          annotated_image_base64: frame.annotated_image_base64,
          filename: frame.filename,
        })
      } catch (err) {
        console.error('Failed to confirm frame in batch', frame.id, err)
        // If one fails, we stop the batch and leave the rest in the queue
        setDiagnosticMessage('Failed to confirm some detections in batch.')
        return
      }
    }
    
    // If all succeeded, clear the queue and add the last one to the featured view
    if (framesToConfirm.length > 0) {
      const lastFrame = framesToConfirm[framesToConfirm.length - 1]
      const newImage = {
        url: lastFrame.annotated_image_base64,
        timestamp: lastFrame.timestamp,
        detections: lastFrame.detections,
      }
      setGalleryImages((prev) => [newImage, ...prev].slice(0, 12))
      setFeaturedImage(newImage)
      setAnnotatedImage(newImage.url)
      setLastDetections(lastFrame.detections || [])
      setLogOffset(0) // Refresh logs
    }
    
    setPendingApprovals([])
  }

  const handleRejectAll = () => {
    setPendingApprovals([])
  }

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
    selectedStudentId,
    handleFrameUploadSuccess,
    handleFrameUploadError,
    reviewMode,
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
          limit: 100, // Fetch more to get enough unique images
          offset: logOffset,
        })

        if (!isMounted) return

        setBehaviorLogs(response.logs)
        setLogTotal(response.total)

        // Populate gallery with unique images from the fetched logs
        const uniqueImages = new Map()
        for (const log of response.logs) {
          if (log.frame_snapshot && !uniqueImages.has(log.frame_snapshot)) {
            uniqueImages.set(log.frame_snapshot, {
              url: log.frame_snapshot as string,
              timestamp: new Date(log.detected_at),
              detections: response.logs
                .filter(l => l.frame_snapshot === log.frame_snapshot)
                .map(l => ({
                  behavior_class: l.behavior_class,
                  confidence: l.yolo_confidence
                }))
            })
          }
        }
        const historyImages = Array.from(uniqueImages.values())
        
        setGalleryImages((prev) => {
          if (logOffset === 0) {
            return historyImages.slice(0, 12)
          }
          const existingUrls = new Set(prev.map(p => p.url))
          const newUnique = historyImages.filter(img => !existingUrls.has(img.url))
          return [...prev, ...newUnique].slice(0, 12)
        })

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

  // Load students in session
  useEffect(() => {
    let isMounted = true

    async function loadStudents(): Promise<void> {
      if (!sessionId) return
      setLoadingStudents(true)
      try {
        const report = await getSessionAttendanceReport(sessionId)
        if (isMounted) {
          setEnrolledStudents(report.students || [])
        }
      } catch (err) {
        console.error('Failed to load students:', err)
      } finally {
        if (isMounted) setLoadingStudents(false)
      }
    }

    void loadStudents()
    return () => {
      isMounted = false
    }
  }, [sessionId])

  const handleStopUploading = useCallback(() => {
    frameUpload.stopUploading()
    setDiagnosticMessage('Capture loop stopped')
  }, [frameUpload])

  const handleTestCapture = useCallback(async () => {
    if (!sessionId || !session) return
    setDiagnosticMessage(null)
    console.info('[Diagnostic] Manually triggering test capture...')
    
    if (cameraState !== 'RUNNING') {
      console.warn('[Diagnostic] Camera not running. Starting it first...')
      const state = await cameraRef.current?.startCamera()
      if (state !== 'RUNNING') {
        console.error('[Diagnostic] Failed to start camera')
        return
      }
    }

    const dataUri = await cameraRef.current?.captureFrame()
    if (!dataUri) {
      console.error('[Diagnostic] Capture returned null')
      setDiagnosticMessage('Capture failed - check console for details')
    } else {
      console.info(`[Diagnostic] Capture success! Length: ${dataUri.length}. Running inference...`)
      setDiagnosticMessage('Capturing & analyzing...')

      try {
        const resolvedMode = inferenceMode === 'TESTING' ? 'TESTING' : 'LEARNING'
        let response: LearningModeResponse | TestingModeResponse

        if (resolvedMode === 'TESTING') {
          response = await ingestTestingMode(sessionId, {
            image_base64: dataUri,
            students_present: session.students_present || [],
            confidence_threshold: 0.5,
          })
        } else {
          response = await ingestLearningMode(sessionId, {
            image_base64: dataUri,
            confidence_threshold: 0.5,
          })
        }

        console.info(`[Diagnostic] Inference success! Detections: ${response.detection_count}`)
        setDiagnosticMessage(`Test capture & inference successful: ${response.detection_count} behaviors found`)
        
        handleFrameUploadSuccess(response)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Inference failed'
        console.error('[Diagnostic] Inference failed:', err)
        setDiagnosticMessage(`Inference failed: ${msg}`)
        
        // Still show the raw image even if inference fails
        const rawImg = {
          url: dataUri,
          timestamp: new Date(),
          detections: []
        }
        setFeaturedImage(rawImg)
        setAnnotatedImage(dataUri)
      }
    }
  }, [cameraState, sessionId, session, inferenceMode, handleFrameUploadSuccess])

  const handleStartUploading = useCallback(async () => {
    setDiagnosticMessage(null)

    const startedState = await cameraRef.current?.startCamera()
    if (startedState !== 'RUNNING') {
      setDiagnosticMessage(`Camera did not become ready. Current state: ${startedState ?? 'UNKNOWN'}`)
      return
    }

    if (typeof intervalMs !== 'number' || intervalMs < 0) {
      setDiagnosticMessage('Refresh interval is invalid or missing.')
      return
    }

    frameUpload.startUploading()
    setDiagnosticMessage(`Capture loop started at ${intervalMs}ms`)
  }, [frameUpload, intervalMs])

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
        student_id: selectedStudentId || undefined,
      })

      if (result.annotated_image_base64) {
        const newImage = {
          url: result.annotated_image_base64,
          timestamp: new Date(),
          detections: result.detections,
        }

        setGalleryImages((prev) => [newImage, ...prev].slice(0, 12))
        setFeaturedImage(newImage)
        setAnnotatedImage(newImage.url)
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
      <main className="capture-page">
        <section className="panel error-panel">Missing session id in route.</section>
      </main>
    )
  }

  if (loading) {
    return (
      <main className="capture-page">
        <section className="panel">Loading session details...</section>
      </main>
    )
  }

  if (error) {
    return (
      <main className="capture-page">
        <section className="panel error-panel">
          <AlertCircle size={18} />
          <p>{error}</p>
        </section>
      </main>
    )
  }

  if (!session) {
    return (
      <main className="capture-page">
        <section className="panel error-panel">Session not found.</section>
      </main>
    )
  }

  const logsPerPage = 20

  return (
    <main className="capture-page campus-bg">
      <section className="panel">

        <h1>Camera Capture & Inference</h1>
        <p className="muted">Session: {sessionId.split('-')[0].toUpperCase()}</p>

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

      <section className="capture-grid">
        <article className="panel">
          <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ margin: 0 }}>Capture Feed</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 600, color: '#666' }}>
              {cameraState === 'RUNNING' ? (
                cameraSourceType === 'VIDEO_FILE' ? <Film size={16} /> : <Camera size={16} />
              ) : (
                <CameraOff size={16} />
              )}
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {cameraState === 'RUNNING' && cameraSourceType === 'VIDEO_FILE'
                  ? `VIDEO: ${cameraVideoFileName || 'file'}`
                  : cameraState}
              </span>
            </div>
          </div>
          {captureSource === 'LIVE' ? (
            <CameraIngestPanel 
              ref={cameraRef} 
              onStateChange={setCameraState} 
              onSourceChange={(source, fileName) => {
                setCameraSourceType(source)
                setCameraVideoFileName(fileName || null)
              }}
            />
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
                <p style={{ marginTop: '8px', fontSize: '12px', color: '#2e8b4e' }}>
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
            {captureSource === 'UPLOAD' ? (
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
              <div className="button-group-row">
                <button
                  className={`btn ${frameUpload.isUploading ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => {
                    if (frameUpload.isUploading) {
                      handleStopUploading()
                    } else {
                      void handleStartUploading()
                    }
                  }}
                  disabled={!canStartCapture}
                >
                  {frameUpload.isUploading ? (
                    <><Square size={16} /> Stop Uploading</>
                  ) : (
                    <><Play size={16} /> Start Uploading</>
                  )}
                </button>

                {!frameUpload.isUploading && captureSource === 'LIVE' && (
                  <button 
                    className="btn btn-outline" 
                    onClick={handleTestCapture}
                    title="Run a single test capture"
                  >
                    <Camera size={16} /> Test Capture
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="capture-options" style={{ marginTop: '20px', display: 'flex', gap: '16px' }}>
            <div className="control-block" style={{ flex: 1 }}>
              <span className="control-label">Source</span>
              <div className="toggle-group" style={{ display: 'flex', gap: '4px' }}>
                <button
                  className={`btn btn-sm ${captureSource === 'LIVE' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setCaptureSource('LIVE')}
                  disabled={frameUpload.isUploading}
                  style={{ flex: 1 }}
                >
                  Live
                </button>
                <button
                  className={`btn btn-sm ${captureSource === 'UPLOAD' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setCaptureSource('UPLOAD')}
                  disabled={frameUpload.isUploading}
                  style={{ flex: 1 }}
                >
                  Upload
                </button>
              </div>
            </div>

            <div className="control-block" style={{ flex: 1 }}>
              <span className="control-label">Inference</span>
              <div className="toggle-group" style={{ display: 'flex', gap: '4px' }}>
                <button
                  className={`btn btn-sm ${inferenceMode === 'LEARNING' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setInferenceMode('LEARNING')}
                  disabled={frameUpload.isUploading}
                  style={{ flex: 1 }}
                >
                  Learning
                </button>
                <button
                  className={`btn btn-sm ${inferenceMode === 'TESTING' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setInferenceMode('TESTING')}
                  disabled={frameUpload.isUploading}
                  style={{ flex: 1 }}
                >
                  Testing
                </button>
              </div>
            </div>

            <div className="control-block" style={{ flex: 1 }}>
              <span className="control-label">Manual Review Mode</span>
              <div className="toggle-group" style={{ display: 'flex', gap: '4px' }}>
                <button
                  className={`btn btn-sm ${reviewMode ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setReviewMode(true)}
                  disabled={frameUpload.isUploading || uploadProcessing}
                  style={{ flex: 1 }}
                >
                  Enabled
                </button>
                <button
                  className={`btn btn-sm ${!reviewMode ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setReviewMode(false)}
                  disabled={frameUpload.isUploading || uploadProcessing}
                  style={{ flex: 1 }}
                >
                  Disabled
                </button>
              </div>
            </div>
          </div>

          <div className="capture-options" style={{ marginTop: '16px' }}>
            <div className="control-block" style={{ flex: '1 1 100%' }}>
              <span className="control-label">Target Student</span>
              <select 
                className="select-input"
                style={{ 
                  width: '100%', 
                  padding: '8px', 
                  borderRadius: '6px', 
                  border: '1px solid #d6dbe1',
                  backgroundColor: '#fff',
                  fontSize: '13px'
                }}
                value={selectedStudentId || ''} 
                onChange={(e) => setSelectedStudentId(e.target.value || null)}
                disabled={frameUpload.isUploading || uploadProcessing}
              >
                <option value="">-- All Students (Auto-Detect / Unknown) --</option>
                {enrolledStudents.map((s) => (
                  <option key={s.student_id} value={s.student_id}>
                    {s.student_name} ({s.student_code})
                  </option>
                ))}
              </select>
              {loadingStudents && <p className="muted" style={{ fontSize: '10px', marginTop: '4px' }}>Loading student list...</p>}
            </div>
          </div>

          <div style={{ 
            marginTop: '24px', 
            fontSize: '15px', 
            lineHeight: '1.6',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '12px 40px',
            borderTop: '1px solid #f0f0f0',
            paddingTop: '24px'
          }}>
            <p style={{ margin: 0 }}>
              <strong>Status:</strong>{' '}
              <span style={{ color: '#2e8b4e', fontWeight: 600 }}>
                {batchProcessing ? 'Batch Processing...' : uploadProcessing ? 'Analyzing...' : frameUpload.isUploading ? 'Capturing' : 'Idle'}
              </span>
            </p>
            <p style={{ margin: 0 }}>
              <strong>Camera:</strong> {cameraState}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Source:</strong> {captureSource}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Inference:</strong> {inferenceMode}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Session:</strong> {session.mode}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Interval:</strong> {intervalMs}ms
            </p>
            <p style={{ margin: 0 }}>
              <strong>Detections:</strong> {lastDetections.length}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Uploaded:</strong> {frameUpload.framesUploaded}
            </p>
            {diagnosticMessage && (
              <p className="muted" style={{ margin: 0, gridColumn: 'span 2', fontSize: '13px', borderTop: '1px dashed #eee', paddingTop: '12px', marginTop: '4px' }}>
                <strong>Diagnostic:</strong> {diagnosticMessage}
              </p>
            )}
            {batchResult && (
              <div style={{ gridColumn: 'span 2', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', marginTop: '4px', borderTop: '1px dashed #eee', paddingTop: '8px' }}>
                <p style={{ margin: 0 }}>
                  <strong>Batch:</strong> {batchResult.processed}/{batchResult.total_input}
                </p>
                <p style={{ margin: 0 }}>
                  <strong>Total Det:</strong> {batchResult.results.reduce((sum, r) => sum + r.detection_count, 0)}
                </p>
              </div>
            )}
          </div>
        </article>

        <article className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ margin: 0 }}>Annotated Preview</h2>
            {featuredImage && (
              <span className="timestamp muted" style={{ fontSize: '12px' }}>
                Last detected: {featuredImage.timestamp.toLocaleTimeString()}
              </span>
            )}
          </div>

          <div className="preview-container" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            {featuredImage ? (
              <div className="featured-view" style={{ marginBottom: '1.5rem' }}>
                <img 
                  src={featuredImage.url} 
                  alt="Annotated Preview" 
                  style={{ width: '100%', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} 
                />
                <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
                  <span className="count-badge" style={{ backgroundColor: '#2e8b4e', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '12px' }}>
                    {featuredImage.detections.length} Detections
                  </span>
                </div>
              </div>
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
                  marginBottom: '1.5rem'
                }}
              >
                {batchProcessing ? 'Processing frames through YOLO...' : 'No preview available yet'}
              </div>
            )}

            <div className="gallery-section" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <h4 style={{ marginBottom: '0.75rem', fontSize: '14px', borderBottom: '1px solid #eee', paddingBottom: '4px' }}>History</h4>
              <div className="image-gallery" style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(4, 1fr)', 
                gap: '8px',
                flex: 1,
                overflowY: 'auto',
                padding: '4px',
                minHeight: '200px'
              }}>
                {galleryImages.map((img, idx) => (
                  <div 
                    key={idx} 
                    className={`gallery-item ${featuredImage?.url === img.url ? 'active' : ''}`}
                    onClick={() => handleSelectFeatured(img)}
                    style={{ 
                      cursor: 'pointer',
                      borderRadius: '4px',
                      overflow: 'hidden',
                      border: featuredImage?.url === img.url ? '2px solid #2e8b4e' : '2px solid transparent',
                      position: 'relative',
                      transition: 'transform 0.2s',
                      aspectRatio: '16/9'
                    }}
                  >
                    <img src={img.url} alt={`Frame ${idx}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    <div style={{ 
                      position: 'absolute', 
                      bottom: 0, 
                      left: 0, 
                      right: 0, 
                      backgroundColor: 'rgba(0,0,0,0.5)', 
                      color: 'white', 
                      fontSize: '10px', 
                      textAlign: 'center',
                      padding: '2px 0'
                    }}>
                      {img.timestamp.toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })}
                    </div>
                  </div>
                ))}
                {galleryImages.length === 0 && (
                  <div className="empty-gallery muted" style={{ gridColumn: 'span 4', textAlign: 'center', padding: '20px', fontSize: '13px' }}>
                    No frames captured yet
                  </div>
                )}
              </div>
            </div>
          </div>
        </article>
      </section>

      {captureSource === 'TEMP' && (
        <section className="panel">
          <h2>Output Gallery (Temp_output)</h2>

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
      )}      {reviewMode && pendingApprovals.length > 0 && (
        <section className="panel" style={{ border: '1px solid #e0e0e0', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <h2 style={{ color: '#2e8b4e', margin: 0 }}>Pending Approvals ({pendingApprovals.length})</h2>
              <span style={{ fontSize: '12px', color: '#a1a1aa' }}>Focus Mode</span>
            </div>
            {/* Header buttons removed, moved to sidebar split-buttons */}
          </div>
          
          {/* Active Review Panel */}
          {(() => {
            const activeFrame = pendingApprovals[0];
            return (
              <div style={{ display: 'flex', gap: '24px', backgroundColor: '#fafafa', border: '1px solid #e4e4e7', borderRadius: '8px', padding: '16px' }}>
                {/* Left Side: Large Image (Increased to 70%) */}
                <div style={{ flex: '1 1 70%', minWidth: 0 }}>
                  <img src={activeFrame.annotated_image_base64} alt="Active pending frame" style={{ width: '100%', borderRadius: '8px', display: 'block', border: '1px solid #e4e4e7' }} />
                </div>
                
                {/* Right Side: Details & Actions (Decreased to 30%) */}
                <div style={{ flex: '1 1 30%', display: 'flex', flexDirection: 'column' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '4px', color: '#18181b' }}>Review Required</h3>
                  <div style={{ fontSize: '13px', color: '#71717a', marginBottom: '16px' }}>
                    {activeFrame.timestamp.toLocaleTimeString()} • {activeFrame.mode}
                  </div>
                  
                  <div style={{ flex: 1, overflowY: 'auto', marginBottom: '20px' }}>
                    <h4 style={{ fontSize: '12px', color: '#71717a', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Detections</h4>
                    {activeFrame.detections.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                        {Object.entries(
                          activeFrame.detections.reduce((acc: Record<string, number>, det: any) => {
                            acc[det.behavior_class] = (acc[det.behavior_class] || 0) + 1;
                            return acc;
                          }, {})
                        ).map(([behavior, count]) => (
                          <span key={behavior} style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            backgroundColor: '#f4f4f5',
                            color: '#3f3f46',
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: 600,
                            border: '1px solid #e4e4e7'
                          }}>
                            {behavior} <span style={{ marginLeft: '6px', opacity: 0.6 }}>{count as number}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p style={{ fontSize: '14px', color: '#a1a1aa', margin: 0 }}>No behaviors detected.</p>
                    )}

                    {/* Up Next moved inside right panel */}
                    {pendingApprovals.length > 1 && (
                      <div style={{ marginTop: '24px' }}>
                        <h4 style={{ fontSize: '12px', color: '#71717a', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Up Next ({pendingApprovals.length - 1})</h4>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '8px' }}>
                          {pendingApprovals.slice(1, 5).map((frame) => (
                            <div key={frame.id} style={{ opacity: 0.6 }}>
                              <img 
                                src={frame.annotated_image_base64} 
                                alt="Thumbnail" 
                                style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: '4px', border: '1px solid #e4e4e7' }} 
                              />
                            </div>
                          ))}
                          {pendingApprovals.length > 5 && (
                            <div style={{ 
                              display: 'flex', alignItems: 'center', justifyContent: 'center', 
                              backgroundColor: '#f4f4f5', borderRadius: '4px', border: '1px solid #e4e4e7',
                              fontSize: '11px', color: '#71717a'
                            }}>
                              +{pendingApprovals.length - 5} more
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: 'auto' }}>
                    {/* Confirm Split Button */}
                    <div style={{ display: 'flex', gap: '2px', overflow: 'hidden', borderRadius: '8px' }}>
                      <button 
                        style={{ 
                          flex: 3, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          backgroundColor: '#16a34a', padding: '12px', fontSize: '14px', fontWeight: 'bold',
                          border: 'none', cursor: 'pointer'
                        }}
                        onClick={() => handleConfirmPending(activeFrame)}
                      >
                        <Check size={18} style={{ marginRight: '8px' }} /> Confirm Frame
                      </button>
                      <button 
                        style={{ 
                          flex: 1, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          backgroundColor: '#15803d', padding: '12px', fontSize: '12px', fontWeight: 'bold',
                          border: 'none', cursor: 'pointer'
                        }}
                        onClick={handleConfirmAll}
                        title="Confirm All Pending Frames"
                      >
                        All
                      </button>
                    </div>

                    {/* Reject Split Button */}
                    <div style={{ display: 'flex', gap: '2px', overflow: 'hidden', borderRadius: '8px' }}>
                      <button 
                        style={{ 
                          flex: 3, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          backgroundColor: '#dc2626', padding: '12px', fontSize: '14px', fontWeight: '500',
                          border: 'none', cursor: 'pointer'
                        }}
                        onClick={() => handleRejectPending(activeFrame.id)}
                      >
                        <X size={18} style={{ marginRight: '8px' }} /> Reject
                      </button>
                      <button 
                        style={{ 
                          flex: 1, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          backgroundColor: '#b91c1c', padding: '12px', fontSize: '12px', fontWeight: '500',
                          border: 'none', cursor: 'pointer'
                        }}
                        onClick={handleRejectAll}
                        title="Reject All Pending Frames"
                      >
                        All
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </section>
      )}

      {!reviewMode && (
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
      )}

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
      {/* Diagnostic Log Monitor */}
      <div className="diagnostic-log-monitor panel">
        <div className="monitor-header">
          <Activity size={16} />
          <h3>Live Diagnostic Logs</h3>
          <button 
            className="btn btn-sm btn-text" 
            onClick={() => setDiagnosticLogs([])}
            style={{ marginLeft: 'auto' }}
          >
            Clear
          </button>
        </div>
        <div className="monitor-body">
          {diagnosticLogs.length === 0 ? (
            <div className="empty-log">No logs captured yet. Click "Start Uploading" or "Test Capture".</div>
          ) : (
            diagnosticLogs.map(log => {
              const safeLevel = (log.level || 'INFO').toUpperCase();
              return (
                <div key={log.id} className={`log-entry log-${safeLevel.toLowerCase()}`}>
                  <span className="log-time">{log.time.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  <span className="log-level">[{safeLevel}]</span>
                  <span className="log-msg">{log.message}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </main>
  )
}
