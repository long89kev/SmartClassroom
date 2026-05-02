import { useEffect, useState } from 'react'
import { getEffectiveRefreshInterval, getTutorRoomContext } from '../services/api'

interface UseCameraIntervalOptions {
  /** When provided, skip the tutor room context lookup and use this building directly. */
  overrideBuildingId?: string | null
  /** When provided, skip the tutor room context lookup and use this room directly. */
  overrideRoomId?: string | null
}

interface UseCameraIntervalReturn {
  intervalMs: number | null
  sourceScope: string | null
  buildingId: string | null
  roomId: string | null
  isReady: boolean
  error: string | null
}

export function useCameraInterval(
  sessionMode: 'NORMAL' | 'TESTING',
  options?: UseCameraIntervalOptions,
): UseCameraIntervalReturn {
  const overrideBuildingId = options?.overrideBuildingId ?? null
  const overrideRoomId = options?.overrideRoomId ?? null

  const [intervalMs, setIntervalMs] = useState<number | null>(null)
  const [sourceScope, setSourceScope] = useState<string | null>(null)
  const [buildingId, setBuildingId] = useState<string | null>(null)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function resolveInterval(): Promise<void> {
      setError(null)
      setIsReady(false)

      try {
        let resolvedBuildingId: string | null = overrideBuildingId
        let resolvedRoomId: string | null = overrideRoomId

        // If overrides are not provided, fall back to tutor room context
        if (!resolvedBuildingId || !resolvedRoomId) {
          try {
            const context = await getTutorRoomContext()
            if (!isMounted) return

            resolvedBuildingId = resolvedBuildingId ?? context.building_id
            resolvedRoomId = resolvedRoomId ?? context.room_id
          } catch {
            // Tutor context may fail for non-INSTRUCTOR roles; that's OK if overrides are present
            if (!resolvedBuildingId || !resolvedRoomId) {
              if (!isMounted) return
              setError('No assigned room found')
              return
            }
          }
        }

        if (!resolvedBuildingId || !resolvedRoomId) {
          if (!isMounted) return
          setError('No assigned room found')
          return
        }

        setBuildingId(resolvedBuildingId)
        setRoomId(resolvedRoomId)

        // Step 2: Get effective interval for this mode
        const intervalConfig = await getEffectiveRefreshInterval(
          resolvedBuildingId,
          sessionMode,
          resolvedRoomId,
        )
        if (!isMounted) return

        setIntervalMs(intervalConfig.interval_ms)
        setSourceScope(intervalConfig.source_scope)
        setIsReady(true)
      } catch (err) {
        if (!isMounted) return
        setError(err instanceof Error ? err.message : 'Failed to resolve interval')
        setIsReady(false)
      }
    }

    void resolveInterval()

    return () => {
      isMounted = false
    }
  }, [sessionMode, overrideBuildingId, overrideRoomId])

  return {
    intervalMs,
    sourceScope,
    buildingId,
    roomId,
    isReady,
    error,
  }
}
