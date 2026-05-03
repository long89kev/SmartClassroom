import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Camera, CameraOff, AlertCircle } from 'lucide-react'

type CameraState = 'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR'

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
  const [state, setState] = useState<CameraState>('IDLE')
  const [error, setError] = useState<string | null>(null)

  const updateState = (newState: CameraState) => {
    setState(newState)
    onStateChange?.(newState)
  }

  const startCamera = async (): Promise<CameraState> => {
    if (state !== 'IDLE') return state

    updateState('STARTING')
    setError(null)
    readyRef.current = false

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

  const stopCamera = (): void => {
    if (state !== 'RUNNING') return

    updateState('STOPPING')
    readyRef.current = false

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    updateState('IDLE')
  }

  const captureFrame = (): string | null => {
    const videoElement = videoRef.current
    const canvasElement = canvasRef.current

    if (!videoElement || !canvasElement || !streamRef.current || !readyRef.current) {
      console.debug('[Camera] captureFrame - not ready', { 
        hasVideo: !!videoElement, 
        hasCanvas: !!canvasElement, 
        hasStream: !!streamRef.current, 
        ready: readyRef.current 
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
        {state === 'RUNNING' ? <Camera size={18} /> : <CameraOff size={18} />}
        <span className="camera-status">{state}</span>
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
          <button className="btn btn-primary" onClick={startCamera}>
            Start Camera
          </button>
        ) : state === 'RUNNING' ? (
          <button className="btn btn-danger" onClick={stopCamera}>
            Stop Camera
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
