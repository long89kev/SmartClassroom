import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Camera, CameraOff, AlertCircle, Film } from 'lucide-react'

type CameraState = 'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR'

/** Tracks whether the RUNNING state is fed by a live camera or a local video file. */
type SourceType = 'CAMERA' | 'VIDEO_FILE'

export interface CameraIngestPanelHandle {
  startCamera: () => Promise<CameraState>
  stopCamera: () => void
  captureFrame: () => string | null
  getState: () => CameraState
}

interface CameraIngestPanelProps {
  onCapture?: (dataUri: string) => void
  onStateChange?: (state: CameraState) => void
}

export const CameraIngestPanel = forwardRef<CameraIngestPanelHandle, CameraIngestPanelProps>(
  function CameraIngestPanel({ onCapture, onStateChange }: CameraIngestPanelProps, ref): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const readyRef = useRef(false)
  const objectUrlRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<CameraState>('IDLE')
  const [error, setError] = useState<string | null>(null)
  const [sourceType, setSourceType] = useState<SourceType>('CAMERA')
  const [videoFileName, setVideoFileName] = useState<string | null>(null)

  const updateState = (newState: CameraState) => {
    setState(newState)
    onStateChange?.(newState)
  }

  // ─── Live Camera ───────────────────────────────────────────
  const startCamera = async (): Promise<CameraState> => {
    if (state !== 'IDLE') return state

    updateState('STARTING')
    setError(null)
    readyRef.current = false
    setSourceType('CAMERA')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })

      streamRef.current = stream
      console.debug('[Camera] startCamera - stream acquired')

      const videoElement = videoRef.current
      if (videoElement) {
        videoElement.srcObject = stream
        // Wait for video to load
        await new Promise<void>((resolve) => {
          const handler = () => {
            videoElement.removeEventListener('loadedmetadata', handler)
            resolve()
          }
          videoElement.addEventListener('loadedmetadata', handler)
        })
      }

      // Wait for video dimensions to become non-zero before allowing capture.
      let attempts = 0
      while (
        attempts < 20 &&
        videoElement !== null &&
        (videoElement.videoWidth === 0 || videoElement.videoHeight === 0)
      ) {
        await new Promise((r) => setTimeout(r, 100))
        attempts++
      }

      if (!videoElement || videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        readyRef.current = false
        setError('Camera stream is not ready yet. Please try again.')
        updateState('ERROR')
        return 'ERROR'
      }

      readyRef.current = true
      console.debug('[Camera] ready', { videoWidth: videoElement.videoWidth, videoHeight: videoElement.videoHeight })
      updateState('RUNNING')

      return 'RUNNING'
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : 'Failed to access camera. Check permissions.'
      console.debug('[Camera] startCamera error', err)
      setError(errorMsg)
      updateState('ERROR')
      return 'ERROR'
    }
  }

  // ─── Video File Loader ─────────────────────────────────────
  const handleVideoFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Clean up any previous source
    cleanupSource()

    updateState('STARTING')
    setError(null)
    readyRef.current = false
    setSourceType('VIDEO_FILE')
    setVideoFileName(file.name)

    const url = URL.createObjectURL(file)
    objectUrlRef.current = url

    const videoElement = videoRef.current
    if (!videoElement) {
      setError('Video element not available')
      updateState('ERROR')
      return
    }

    // Remove any live stream srcObject so <video> uses the src attribute instead
    videoElement.srcObject = null
    videoElement.src = url
    videoElement.loop = true

    try {
      // Wait for metadata to load
      await new Promise<void>((resolve, reject) => {
        const onLoaded = () => {
          videoElement.removeEventListener('loadedmetadata', onLoaded)
          videoElement.removeEventListener('error', onError)
          resolve()
        }
        const onError = () => {
          videoElement.removeEventListener('loadedmetadata', onLoaded)
          videoElement.removeEventListener('error', onError)
          reject(new Error('Failed to load video file. Ensure it is a valid MP4.'))
        }
        videoElement.addEventListener('loadedmetadata', onLoaded)
        videoElement.addEventListener('error', onError)
      })

      // Wait for dimensions
      let attempts = 0
      while (
        attempts < 20 &&
        (videoElement.videoWidth === 0 || videoElement.videoHeight === 0)
      ) {
        await new Promise((r) => setTimeout(r, 100))
        attempts++
      }

      if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        setError('Video dimensions are zero. The file may be corrupted.')
        updateState('ERROR')
        return
      }

      await videoElement.play()
      readyRef.current = true
      console.debug('[Camera] video file ready', {
        name: file.name,
        videoWidth: videoElement.videoWidth,
        videoHeight: videoElement.videoHeight,
      })
      updateState('RUNNING')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to play video file.'
      console.error('[Camera] video file error', err)
      setError(errorMsg)
      updateState('ERROR')
    }

    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // ─── Cleanup Helper ────────────────────────────────────────
  const cleanupSource = () => {
    readyRef.current = false

    // Stop live camera stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    // Revoke video file object URL
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }

    const videoElement = videoRef.current
    if (videoElement) {
      videoElement.pause()
      videoElement.srcObject = null
      videoElement.removeAttribute('src')
      videoElement.load() // Reset the element
    }

    setVideoFileName(null)
  }

  // ─── Stop (works for both camera and video) ────────────────
  const stopCamera = (): void => {
    if (state !== 'RUNNING') return

    updateState('STOPPING')
    cleanupSource()
    updateState('IDLE')
  }

  // ─── Frame Capture (unchanged — works for both sources) ────
  const captureFrame = (): string | null => {
    const videoElement = videoRef.current
    const canvasElement = canvasRef.current

    // For video file mode we don't have a stream, so skip the stream check
    const isVideoFile = sourceType === 'VIDEO_FILE'
    if (!videoElement || !canvasElement || (!isVideoFile && !streamRef.current) || !readyRef.current) {
      console.debug('[Camera] captureFrame - not ready', { 
        hasVideo: !!videoElement, 
        hasCanvas: !!canvasElement, 
        hasStream: !!streamRef.current, 
        ready: readyRef.current,
        sourceType,
      })
      return null
    }

    const ctx = canvasElement.getContext('2d')
    if (!ctx) {
      console.error('[Camera] captureFrame - could not get canvas context')
      return null
    }

    // Match canvas size to video dimensions - ensure they are valid
    const width = videoElement.videoWidth
    const height = videoElement.videoHeight
    
    if (width === 0 || height === 0) {
      console.warn('[Camera] captureFrame - video dimensions are zero')
      return null
    }

    canvasElement.width = width
    canvasElement.height = height

    // Draw video frame to canvas
    try {
      ctx.drawImage(videoElement, 0, 0)
      
      // Convert to JPEG data URI (70% quality for smaller payload)
      const dataUri = canvasElement.toDataURL('image/jpeg', 0.7)
      
      if (!dataUri || dataUri === 'data:,') {
        console.warn('[Camera] captureFrame - produced empty data URI')
        return null
      }

      console.debug('[Camera] captureFrame - success', { length: dataUri.length })
      onCapture?.(dataUri)
      return dataUri
    } catch (err) {
      console.error('[Camera] captureFrame - error during draw or conversion', err)
      return null
    }
  }

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
      readyRef.current = false
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      startCamera,
      stopCamera,
      captureFrame,
      getState: () => state,
    }),
    [state],
  )

  return (
    <div className="camera-panel">
      <div className="camera-header">
        {state === 'RUNNING' ? (
          sourceType === 'VIDEO_FILE' ? <Film size={18} /> : <Camera size={18} />
        ) : (
          <CameraOff size={18} />
        )}
        <span className="camera-status">
          {state === 'RUNNING' && sourceType === 'VIDEO_FILE'
            ? `VIDEO: ${videoFileName || 'file'}`
            : state}
        </span>
      </div>

      {error && (
        <div className="camera-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="camera-feed-wrapper">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="camera-feed"
          style={{
            display: state === 'RUNNING' ? 'block' : 'none',
            width: '100%',
            backgroundColor: '#000',
            borderRadius: '8px',
          }}
        />
        {state !== 'RUNNING' && (
          <div
            className="camera-placeholder"
            style={{
              width: '100%',
              aspectRatio: '16/9',
              backgroundColor: '#1a1a1a',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CameraOff size={48} color="#666" />
          </div>
        )}
      </div>

      <div className="camera-controls">
        {state === 'IDLE' || state === 'ERROR' ? (
          <>
            <button className="btn btn-primary" onClick={startCamera}>
              Start Camera
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => fileInputRef.current?.click()}
              style={{ marginLeft: '8px' }}
            >
              <Film size={16} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
              Load Test Video
            </button>
            {/* Hidden file input for video selection */}
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/webm,video/ogg,video/*"
              onChange={handleVideoFileSelect}
              style={{ display: 'none' }}
            />
          </>
        ) : state === 'RUNNING' ? (
          <button className="btn btn-danger" onClick={stopCamera}>
            {sourceType === 'VIDEO_FILE' ? 'Stop Video' : 'Stop Camera'}
          </button>
        ) : (
          <button className="btn" disabled>
            {state}...
          </button>
        )}
      </div>

      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  )
  },
)

export { type CameraState, type CameraIngestPanelProps }
