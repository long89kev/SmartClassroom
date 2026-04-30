import { useEffect, useMemo, useState } from 'react'
import {
  getBuildingFloors,
  getBuildingRefreshIntervalConfig,
  getBuildingsOverview,
  getFloorRooms,
  getRefreshIntervalGroups,
  getRoomRefreshIntervalConfig,
  resetBuildingRefreshInterval,
  resetRoomRefreshInterval,
  updateBuildingRefreshInterval,
  updateRefreshIntervalGroup,
  updateRoomRefreshInterval,
} from '../services/api'
import type {
  BuildingOverview,
  BuildingRefreshIntervalConfig,
  FloorSummary,
  RefreshIntervalGroupRow,
  RefreshIntervalMode,
  RoomRefreshIntervalConfig,
  RoomSummary,
} from '../types'
import { useAuthStore } from '../store/auth'
import { usePermissions } from '../hooks/usePermissions'
import { PERMISSIONS } from '../constants/permissions'

const GROUP_CODES: Array<'A' | 'B' | 'C' | 'LABS'> = ['A', 'B', 'C', 'LABS']

function getValue(values: Array<{ mode: RefreshIntervalMode; interval_ms: number }>, mode: RefreshIntervalMode): number {
  return values.find((item) => item.mode === mode)?.interval_ms ?? (mode === 'TESTING' ? 2000 : 30000)
}

export function AdminSettingsPage(): JSX.Element {
  const currentRole = useAuthStore((state) => state.user?.role)
  const { has } = usePermissions()
  const canManageSystemSettings = currentRole === 'ACADEMIC_MANAGER' && has(PERMISSIONS.SYSTEM_SETTINGS)

  const [groups, setGroups] = useState<RefreshIntervalGroupRow[]>([])
  const [groupDraft, setGroupDraft] = useState<Record<string, { normal: string; testing: string }>>({})
  const [buildings, setBuildings] = useState<BuildingOverview[]>([])
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('')
  const [buildingConfig, setBuildingConfig] = useState<BuildingRefreshIntervalConfig | null>(null)
  const [buildingDraft, setBuildingDraft] = useState<{ normal: string; testing: string }>({ normal: '', testing: '' })
  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [selectedRoomId, setSelectedRoomId] = useState<string>('')
  const [roomConfig, setRoomConfig] = useState<RoomRefreshIntervalConfig | null>(null)
  const [roomDraft, setRoomDraft] = useState<{ normal: string; testing: string }>({ normal: '', testing: '' })
  const [message, setMessage] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'GROUP' | 'BUILDING' | 'ROOM'>('GROUP')

  const minInterval = useMemo(() => {
    if (buildingConfig?.min_interval_ms) return buildingConfig.min_interval_ms
    if (roomConfig?.min_interval_ms) return roomConfig.min_interval_ms
    return 1000
  }, [buildingConfig, roomConfig])

  const maxInterval = useMemo(() => {
    if (buildingConfig?.max_interval_ms) return buildingConfig.max_interval_ms
    if (roomConfig?.max_interval_ms) return roomConfig.max_interval_ms
    return 120000
  }, [buildingConfig, roomConfig])

  useEffect(() => {
    if (!canManageSystemSettings) return

    let isMounted = true
    async function loadInitial(): Promise<void> {
      setError(null)
      try {
        const [groupData, buildingData] = await Promise.all([getRefreshIntervalGroups(), getBuildingsOverview()])
        if (!isMounted) return

        setGroups(groupData.groups)
        const nextGroupDraft: Record<string, { normal: string; testing: string }> = {}
        groupData.groups.forEach((group) => {
          nextGroupDraft[group.group_code] = {
            normal: String(group.normal_interval_ms),
            testing: String(group.testing_interval_ms),
          }
        })
        setGroupDraft(nextGroupDraft)
        setBuildings(buildingData)

        if (buildingData.length > 0) {
          setSelectedBuildingId(buildingData[0].id)
        }
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load admin settings')
      }
    }

    void loadInitial()

    return () => {
      isMounted = false
    }
  }, [canManageSystemSettings])

  useEffect(() => {
    if (!canManageSystemSettings || !selectedBuildingId) return

    let isMounted = true
    async function loadBuildingContext(): Promise<void> {
      try {
        const [config, floorData] = await Promise.all([
          getBuildingRefreshIntervalConfig(selectedBuildingId),
          getBuildingFloors(selectedBuildingId),
        ])
        const roomsByFloor = await Promise.all(
          floorData.map(async (floor) => getFloorRooms(selectedBuildingId, floor.id)),
        )
        if (!isMounted) return

        setBuildingConfig(config)
        setBuildingDraft({
          normal: String(getValue(config.values, 'NORMAL')),
          testing: String(getValue(config.values, 'TESTING')),
        })
        setFloors(floorData)
        const flattenedRooms = roomsByFloor.flat()
        setRooms(flattenedRooms)
        setSelectedRoomId(flattenedRooms[0]?.id ?? '')
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load building settings')
      }
    }

    void loadBuildingContext()

    return () => {
      isMounted = false
    }
  }, [canManageSystemSettings, selectedBuildingId])

  useEffect(() => {
    if (!canManageSystemSettings || !selectedRoomId) {
      setRoomConfig(null)
      setRoomDraft({ normal: '', testing: '' })
      return
    }

    let isMounted = true
    async function loadRoomConfig(): Promise<void> {
      try {
        const config = await getRoomRefreshIntervalConfig(selectedRoomId)
        if (!isMounted) return
        setRoomConfig(config)
        setRoomDraft({
          normal: String(getValue(config.values, 'NORMAL')),
          testing: String(getValue(config.values, 'TESTING')),
        })
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load room settings')
      }
    }

    void loadRoomConfig()

    return () => {
      isMounted = false
    }
  }, [canManageSystemSettings, selectedRoomId])

  if (!canManageSystemSettings) {
    return (
      <main className="page">
        <section className="panel error-panel">Only ACADEMIC_MANAGER with system settings permission can access this page.</section>
      </main>
    )
  }

  function parseInterval(value: string): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < minInterval || parsed > maxInterval) {
      throw new Error(`Interval must be between ${minInterval} and ${maxInterval} ms`)
    }
    return Math.floor(parsed)
  }

  async function saveGroup(groupCode: 'A' | 'B' | 'C' | 'LABS', mode: RefreshIntervalMode): Promise<void> {
    setError(null)
    setMessage('')
    try {
      const value = mode === 'NORMAL' ? groupDraft[groupCode]?.normal ?? '' : groupDraft[groupCode]?.testing ?? ''
      await updateRefreshIntervalGroup(groupCode, mode, parseInterval(value))
      const refreshed = await getRefreshIntervalGroups()
      setGroups(refreshed.groups)
      setMessage(`Saved ${mode} interval for group ${groupCode}`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save group interval')
    }
  }

  async function saveBuilding(mode: RefreshIntervalMode): Promise<void> {
    if (!selectedBuildingId) return
    setError(null)
    setMessage('')
    try {
      const value = mode === 'NORMAL' ? buildingDraft.normal : buildingDraft.testing
      await updateBuildingRefreshInterval(selectedBuildingId, mode, parseInterval(value))
      const refreshed = await getBuildingRefreshIntervalConfig(selectedBuildingId)
      setBuildingConfig(refreshed)
      setBuildingDraft({
        normal: String(getValue(refreshed.values, 'NORMAL')),
        testing: String(getValue(refreshed.values, 'TESTING')),
      })
      setMessage(`Saved ${mode} building override`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save building override')
    }
  }

  async function resetBuilding(mode: RefreshIntervalMode): Promise<void> {
    if (!selectedBuildingId) return
    setError(null)
    setMessage('')
    try {
      await resetBuildingRefreshInterval(selectedBuildingId, mode)
      const refreshed = await getBuildingRefreshIntervalConfig(selectedBuildingId)
      setBuildingConfig(refreshed)
      setBuildingDraft({
        normal: String(getValue(refreshed.values, 'NORMAL')),
        testing: String(getValue(refreshed.values, 'TESTING')),
      })
      setMessage(`Reset ${mode} building override`) 
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Failed to reset building override')
    }
  }

  async function saveRoom(mode: RefreshIntervalMode): Promise<void> {
    if (!selectedRoomId) return
    setError(null)
    setMessage('')
    try {
      const value = mode === 'NORMAL' ? roomDraft.normal : roomDraft.testing
      await updateRoomRefreshInterval(selectedRoomId, mode, parseInterval(value))
      const refreshed = await getRoomRefreshIntervalConfig(selectedRoomId)
      setRoomConfig(refreshed)
      setRoomDraft({
        normal: String(getValue(refreshed.values, 'NORMAL')),
        testing: String(getValue(refreshed.values, 'TESTING')),
      })
      setMessage(`Saved ${mode} room override`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save room override')
    }
  }

  async function resetRoom(mode: RefreshIntervalMode): Promise<void> {
    if (!selectedRoomId) return
    setError(null)
    setMessage('')
    try {
      await resetRoomRefreshInterval(selectedRoomId, mode)
      const refreshed = await getRoomRefreshIntervalConfig(selectedRoomId)
      setRoomConfig(refreshed)
      setRoomDraft({
        normal: String(getValue(refreshed.values, 'NORMAL')),
        testing: String(getValue(refreshed.values, 'TESTING')),
      })
      setMessage(`Reset ${mode} room override`)
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Failed to reset room override')
    }
  }

  return (
    <main className="page campus-bg">
      <header className="hero-header">
        <p className="eyebrow">SYSTEM ADMIN</p>
        <h1>Refresh Interval Settings</h1>
        <p className="subcopy">
          Configure polling interval defaults by group, then override at building and room scope for NORMAL and TESTING modes.
        </p>
      </header>

      {message && <section className="panel">{message}</section>}
      {error && <section className="panel error-panel">{error}</section>}

      <section className="panel">
        <div className="section-title-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <h2>Configuration Scope</h2>
            <select 
              value={activeTab} 
              onChange={(e) => setActiveTab(e.target.value as 'GROUP' | 'BUILDING' | 'ROOM')}
              style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #c9c2b8', fontFamily: 'inherit' }}
            >
              <option value="GROUP">Group Defaults</option>
              <option value="BUILDING">Building Overrides</option>
              <option value="ROOM">Room Overrides</option>
            </select>
          </div>
          <span>
            {activeTab === 'GROUP' ? `${minInterval} - ${maxInterval} ms` : ''}
            {activeTab === 'BUILDING' ? (buildingConfig?.building_code ?? '-') : ''}
            {activeTab === 'ROOM' ? (roomConfig?.room_code ?? '-') : ''}
          </span>
        </div>

        {activeTab === 'GROUP' && (
          <div className="table-scroll">
            <table className="settings-ratio-table">
              <colgroup>
                <col className="col-scope" />
                <col className="col-normal" />
                <col className="col-testing" />
                <col className="col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>NORMAL (ms)</th>
                  <th>TESTING (ms)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {GROUP_CODES.map((groupCode) => {
                  const row = groups.find((item) => item.group_code === groupCode)
                  const draft = groupDraft[groupCode] ?? {
                    normal: String(row?.normal_interval_ms ?? 30000),
                    testing: String(row?.testing_interval_ms ?? 2000),
                  }
                  return (
                    <tr key={groupCode}>
                      <td>{groupCode}</td>
                      <td>
                        <input
                          type="number"
                          min={minInterval}
                          max={maxInterval}
                          value={draft.normal}
                          onChange={(event) =>
                            setGroupDraft((prev) => ({
                              ...prev,
                              [groupCode]: { ...draft, normal: event.target.value },
                            }))
                          }
                          style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #c9c2b8' }}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={minInterval}
                          max={maxInterval}
                          value={draft.testing}
                          onChange={(event) =>
                            setGroupDraft((prev) => ({
                              ...prev,
                              [groupCode]: { ...draft, testing: event.target.value },
                            }))
                          }
                          style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #c9c2b8' }}
                        />
                      </td>
                      <td>
                        <div className="row-actions">
                          <button type="button" onClick={() => void saveGroup(groupCode, 'NORMAL')}>Save NORMAL</button>
                          <button type="button" onClick={() => void saveGroup(groupCode, 'TESTING')}>Save TESTING</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'BUILDING' && (
          <>
            <div className="inline-filters" style={{ marginBottom: '1rem' }}>
              <select 
                value={selectedBuildingId} 
                onChange={(event) => setSelectedBuildingId(event.target.value)}
                style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #c9c2b8', fontFamily: 'inherit' }}
              >
                {buildings.map((building) => (
                  <option key={building.id} value={building.id}>
                    {building.code ?? building.name}
                  </option>
                ))}
              </select>
            </div>
            {buildingConfig && (
              <div className="table-scroll">
                <table className="settings-ratio-table">
                  <colgroup>
                    <col className="col-scope" />
                    <col className="col-normal" />
                    <col className="col-source" />
                    <col className="col-testing" />
                    <col className="col-actions" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Mode</th>
                      <th>Effective (ms)</th>
                      <th>Source</th>
                      <th>Override Input (ms)</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['NORMAL', 'TESTING'] as RefreshIntervalMode[]).map((mode) => {
                      const value = buildingConfig.values.find((item) => item.mode === mode)
                      return (
                        <tr key={mode}>
                          <td>{mode}</td>
                          <td>{value?.interval_ms ?? '-'}</td>
                          <td>{value ? `${value.source_scope}${value.is_override ? ' (override)' : ''}` : '-'}</td>
                          <td>
                            <input
                              type="number"
                              min={minInterval}
                              max={maxInterval}
                              value={mode === 'NORMAL' ? buildingDraft.normal : buildingDraft.testing}
                              onChange={(event) =>
                                setBuildingDraft((prev) =>
                                  mode === 'NORMAL'
                                    ? { ...prev, normal: event.target.value }
                                    : { ...prev, testing: event.target.value },
                                )
                              }
                              style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #c9c2b8' }}
                            />
                          </td>
                          <td>
                            <div className="row-actions">
                              <button type="button" onClick={() => void saveBuilding(mode)}>Save Override</button>
                              <button type="button" onClick={() => void resetBuilding(mode)}>Reset</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {activeTab === 'ROOM' && (
          <>
            <div className="inline-filters" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <select 
                value={selectedRoomId} 
                onChange={(event) => setSelectedRoomId(event.target.value)}
                style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #c9c2b8', fontFamily: 'inherit' }}
              >
                <option value="">Select room</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.room_code}
                  </option>
                ))}
              </select>
              <span className="muted">{floors.length} floors / {rooms.length} rooms loaded</span>
            </div>

            {roomConfig && (
              <div className="table-scroll">
                <table className="settings-ratio-table">
                  <colgroup>
                    <col className="col-scope" />
                    <col className="col-normal" />
                    <col className="col-source" />
                    <col className="col-testing" />
                    <col className="col-actions" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Mode</th>
                      <th>Effective (ms)</th>
                      <th>Source</th>
                      <th>Override Input (ms)</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['NORMAL', 'TESTING'] as RefreshIntervalMode[]).map((mode) => {
                      const value = roomConfig.values.find((item) => item.mode === mode)
                      return (
                        <tr key={mode}>
                          <td>{mode}</td>
                          <td>{value?.interval_ms ?? '-'}</td>
                          <td>{value ? `${value.source_scope}${value.is_override ? ' (override)' : ''}` : '-'}</td>
                          <td>
                            <input
                              type="number"
                              min={minInterval}
                              max={maxInterval}
                              value={mode === 'NORMAL' ? roomDraft.normal : roomDraft.testing}
                              onChange={(event) =>
                                setRoomDraft((prev) =>
                                  mode === 'NORMAL'
                                    ? { ...prev, normal: event.target.value }
                                    : { ...prev, testing: event.target.value },
                                )
                              }
                              style={{ width: '100%', padding: '6px', borderRadius: '4px', border: '1px solid #c9c2b8' }}
                            />
                          </td>
                          <td>
                            <div className="row-actions">
                              <button type="button" onClick={() => void saveRoom(mode)}>Save Override</button>
                              <button type="button" onClick={() => void resetRoom(mode)}>Reset</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  )
}
