import { useCallback, useEffect, useRef, useState } from 'react'
import { ingestLearningMode, ingestTestingMode } from '../services/api'
import type { LearningModeResponse, TestingModeResponse, SessionSummary } from '../types'

interface UseFrameUploadState {
  isUploading: boolean
  lastResponse: LearningModeResponse | TestingModeResponse | null
  lastError: string | null
  framesUploaded: number
  lastUploadAt: Date | null
}

interface UseFrameUploadReturn extends UseFrameUploadState {
  startUploading: () => void
  stopUploading: () => void
  reset: () => void
}

export function useFrameUpload(
  sessionId: string | null,
  intervalMs: number | null,
  session: SessionSummary | null,
  captureFrame: () => string | null | Promise<string | null>,
  confidenceThreshold: number = 0.5,
  inferenceMode: 'LEARNING' | 'TESTING' | null = null,
  stopOnCaptureFailure: boolean = false,
  getSourceFilename?: () => string | null,
  onUploadSuccess?: (response: LearningModeResponse | TestingModeResponse) => void,
  onUploadError?: (errorMessage: string) => void,
): UseFrameUploadReturn {
  const [state, setState] = useState<UseFrameUploadState>({
    isUploading: false,
    lastResponse: null,
    lastError: null,
    framesUploaded: 0,
    lastUploadAt: null,
  })

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const isRunningRef = useRef(false)

  const uploadFrame = useCallback(async (): Promise<boolean> => {
    if (!sessionId || !intervalMs || !isRunningRef.current) return false

    if (inFlightRef.current) {
      console.debug('[FrameUpload] Skip - upload already in flight')
      return false
    }

    inFlightRef.current = true
    const startTime = Date.now()
    console.debug('[FrameUpload] Starting upload cycle', { sessionId, mode: inferenceMode })

    try {
      const dataUri = await Promise.resolve(captureFrame())
      if (!dataUri) {
        const errorMsg = 'Capture returned null - camera might not be ready'
        console.warn('[FrameUpload]', errorMsg)
        onUploadError?.(errorMsg)
        setState(prev => ({ ...prev, lastError: errorMsg }))
        return true // Count as attempted
      }

      console.debug('[FrameUpload] Frame captured, length:', dataUri.length)

      const resolvedMode = inferenceMode ?? (session?.mode === 'TESTING' ? 'TESTING' : 'LEARNING')
      let response: LearningModeResponse | TestingModeResponse

      if (resolvedMode === 'TESTING') {
        response = await ingestTestingMode(sessionId, {
          image_base64: dataUri,
          students_present: session?.students_present || [],
          confidence_threshold: confidenceThreshold,
          source_filename: getSourceFilename?.(),
        })
      } else {
        response = await ingestLearningMode(sessionId, {
          image_base64: dataUri,
          confidence_threshold: confidenceThreshold,
          source_filename: getSourceFilename?.(),
        })
      }

      const duration = Date.now() - startTime
      console.debug('[FrameUpload] Upload success', { 
        duration: `${duration}ms`, 
        detections: response.detection_count 
      })

      setState((prev) => ({
        ...prev,
        lastResponse: response,
        lastError: null,
        framesUploaded: prev.framesUploaded + 1,
        lastUploadAt: new Date(),
      }))

      onUploadSuccess?.(response)
      return true
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Upload failed'
      console.error('[FrameUpload] Error:', errorMsg)
      
      setState((prev) => ({
        ...prev,
        lastError: errorMsg,
      }))
      
      onUploadError?.(errorMsg)
      return true
    } finally {
      inFlightRef.current = false
    }
  }, [
    sessionId,
    session,
    intervalMs,
    captureFrame,
    confidenceThreshold,
    inferenceMode,
    getSourceFilename,
    onUploadSuccess,
    onUploadError,
  ])

  const scheduleNextUpload = useCallback((): void => {
    if (!mountedRef.current || !intervalMs || !isRunningRef.current) return

    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    console.debug(`[FrameUpload] Scheduling next capture in ${intervalMs}ms`)
    timerRef.current = setTimeout(async () => {
      if (!mountedRef.current || !isRunningRef.current) return
      
      await uploadFrame()
      
      if (mountedRef.current && isRunningRef.current) {
        scheduleNextUpload()
      }
    }, intervalMs)
  }, [intervalMs, uploadFrame])

  // Re-schedule when interval changes
  useEffect(() => {
    if (isRunningRef.current) {
      console.debug('[FrameUpload] Context changed, re-scheduling loop')
      scheduleNextUpload()
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [intervalMs, scheduleNextUpload])

  const startUploading = useCallback((): void => {
    if (!mountedRef.current || !sessionId || !intervalMs) {
      console.warn('[FrameUpload] Cannot start - missing requirements', { 
        mounted: mountedRef.current, 
        hasSession: !!sessionId, 
        interval: intervalMs 
      })
      return
    }

    if (isRunningRef.current) return

    console.info('[FrameUpload] Starting capture loop')
    isRunningRef.current = true

    setState((prev) => ({
      ...prev,
      isUploading: true,
      lastError: null,
    }))

    // Initial upload
    void uploadFrame().then(() => {
      if (mountedRef.current && isRunningRef.current) {
        scheduleNextUpload()
      }
    })
  }, [sessionId, intervalMs, uploadFrame, scheduleNextUpload])

  const stopUploading = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    isRunningRef.current = false

    setState((prev) => ({
      ...prev,
      isUploading: false,
    }))

    inFlightRef.current = false
  }, [])

  const reset = useCallback((): void => {
    stopUploading()
    setState({
      isUploading: false,
      lastResponse: null,
      lastError: null,
      framesUploaded: 0,
      lastUploadAt: null,
    })
  }, [stopUploading])

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      isRunningRef.current = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return {
    ...state,
    startUploading,
    stopUploading,
    reset,
  }
}
