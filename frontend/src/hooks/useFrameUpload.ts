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

  const uploadFrame = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return
    if (inFlightRef.current) return
    if (!sessionId || !session || !intervalMs) return

    inFlightRef.current = true

    const resolvedMode = inferenceMode ?? (session.mode === 'TESTING' ? 'TESTING' : 'LEARNING')

    const stopIfConfigured = () => {
      if (!stopOnCaptureFailure) return
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }

      isRunningRef.current = false

      setState((prev) => ({
        ...prev,
        isUploading: false,
      }))
    }

    try {
      const dataUri = await Promise.resolve(captureFrame())
      if (!dataUri) {
        setState((prev) => ({
          ...prev,
          lastError: 'Failed to capture frame',
        }))
        stopIfConfigured()
        inFlightRef.current = false
        return
      }

      // Choose endpoint based on session mode
      let response: LearningModeResponse | TestingModeResponse

      const sourceFilename = getSourceFilename?.() ?? undefined

      if (resolvedMode === 'TESTING') {
        response = await ingestTestingMode(sessionId, {
          image_base64: dataUri,
          students_present: session.students_present,
          confidence_threshold: confidenceThreshold,
          source_filename: sourceFilename,
        })
      } else {
        // NORMAL mode (learning)
        response = await ingestLearningMode(sessionId, {
          image_base64: dataUri,
          confidence_threshold: confidenceThreshold,
          source_filename: sourceFilename,
        })
      }

      if (!mountedRef.current) return

      setState((prev) => ({
        ...prev,
        lastResponse: response,
        lastError: null,
        framesUploaded: prev.framesUploaded + 1,
        lastUploadAt: new Date(),
      }))
    } catch (err) {
      if (!mountedRef.current) return

      const errorMsg = err instanceof Error ? err.message : 'Upload failed'
      setState((prev) => ({
        ...prev,
        lastError: errorMsg,
      }))
      stopIfConfigured()
    } finally {
      inFlightRef.current = false
    }
  }, [sessionId, session, intervalMs, captureFrame, confidenceThreshold, inferenceMode, stopOnCaptureFailure, getSourceFilename])

  const scheduleNextUpload = useCallback((): void => {
    if (!mountedRef.current || !intervalMs) return

    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    timerRef.current = setTimeout(() => {
      if (!mountedRef.current || !isRunningRef.current) return
      void uploadFrame().finally(() => {
        if (mountedRef.current && isRunningRef.current) {
          scheduleNextUpload()
        }
      })
    }, intervalMs)
  }, [intervalMs, uploadFrame])

  // Re-schedule when interval changes
  useEffect(() => {
    if (isRunningRef.current) {
      scheduleNextUpload()
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [intervalMs, scheduleNextUpload])

  const startUploading = useCallback((): void => {
    if (!mountedRef.current || !sessionId || !intervalMs) return

    isRunningRef.current = true

    setState((prev) => ({
      ...prev,
      isUploading: true,
    }))

    // Initial upload
    void uploadFrame().finally(() => {
      if (mountedRef.current && isRunningRef.current) {
        scheduleNextUpload()
      }
    })
  }, [sessionId, intervalMs, uploadFrame])

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
