import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  addRoomDevice,
  getBuildingFloors,
  getBuildingsOverview,
  getFloorRooms,
  getRoomDevices,
  getRoomDeviceStates,
  removeRoomDevice,
  toggleDevice,
  updateRoomDevice,
} from '../services/api'
import type {
  BuildingOverview,
  DeviceCreatePayload,
  FloorSummary,
  RoomDeviceInventoryItem,
  RoomDeviceState,
  RoomSummary,
} from '../types'
import { toLocalDateTime } from '../utils/time'
import { AdminBuildingLayout } from '../components/AdminBuildingLayout'
import { usePermissions } from '../hooks/usePermissions'
import { PERMISSIONS } from '../constants/permissions'
import { useAuthStore } from '../store/auth'
import { resolveBuildingFromRouteParam } from '../utils/buildingRoute'

interface RoomDirectoryItem {
  building: BuildingOverview
  floor: FloorSummary
  room: RoomSummary
}

interface DeviceWithContext extends RoomDeviceInventoryItem {
  room_id: string
  room_code: string | null
  floor_id: string
  floor_number: number
  building_id: string
  building_code: string | null
  building_name: string
  status: string
  last_updated: string | null
}

const INITIAL_NEW_DEVICE: DeviceCreatePayload = {
  device_type: 'LIGHT',
  location_front_back: 'FRONT',
  location_left_right: 'LEFT',
  power_consumption_watts: 0,
}

const ROOM_DEVICE_FETCH_CONCURRENCY = 6

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  mapper: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return []
  }

  const limitedConcurrency = Math.max(1, Math.min(concurrency, items.length))
  const results = new Array<TResult>(items.length)
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex])
    }
  }

  await Promise.all(Array.from({ length: limitedConcurrency }, () => runWorker()))
  return results
}

function compareDevicesByContext(left: DeviceWithContext, right: DeviceWithContext): number {
  const leftBuilding = left.building_code ?? left.building_name
  const rightBuilding = right.building_code ?? right.building_name

  if (leftBuilding !== rightBuilding) {
    return leftBuilding.localeCompare(rightBuilding)
  }

  if (left.floor_number !== right.floor_number) {
    return left.floor_number - right.floor_number
  }

  const leftRoomCode = left.room_code ?? ''
  const rightRoomCode = right.room_code ?? ''
  if (leftRoomCode !== rightRoomCode) {
    return leftRoomCode.localeCompare(rightRoomCode)
  }

  return left.device_id.localeCompare(right.device_id)
}

function mapRoomDevicesWithContext(
  roomEntry: RoomDirectoryItem,
  inventory: RoomDeviceInventoryItem[],
  states: RoomDeviceState[],
): DeviceWithContext[] {
  const stateById = new Map<string, RoomDeviceState>(states.map((state) => [state.device_id, state]))

  return inventory.map((device) => {
    const state = stateById.get(device.device_id)
    return {
      ...device,
      room_id: roomEntry.room.id,
      room_code: roomEntry.room.room_code,
      floor_id: roomEntry.floor.id,
      floor_number: roomEntry.floor.floor_number,
      building_id: roomEntry.building.id,
      building_code: roomEntry.building.code,
      building_name: roomEntry.building.name,
      status: state?.status ?? 'OFF',
      last_updated: state?.last_updated ?? null,
    }
  })
}

export function BuildingDevicesPage(): JSX.Element {
  const { buildingId } = useParams<{ buildingId: string }>()
  const currentRole = useAuthStore((state) => state.user?.role ?? null)
  const { hasAny } = usePermissions()

  const isGlobalMode = !buildingId
  const canAccessGlobalWorkspace =
    currentRole === 'SYSTEM_ADMIN' || currentRole === 'FACILITY_STAFF' || currentRole === 'CLEANING_STAFF'

  const canManageDevices = hasAny([PERMISSIONS.DEVICE_MANAGEMENT, PERMISSIONS.SYSTEM_SETTINGS])
  const canToggleDevices =
    canManageDevices ||
    hasAny([PERMISSIONS.ENV_LIGHT, PERMISSIONS.ENV_AC, PERMISSIONS.ENV_FAN]) ||
    currentRole === 'CLEANING_STAFF'

  const [buildings, setBuildings] = useState<BuildingOverview[]>([])
  const [roomDirectory, setRoomDirectory] = useState<RoomDirectoryItem[]>([])
  const [devices, setDevices] = useState<DeviceWithContext[]>([])

  const [selectedBuildingId, setSelectedBuildingId] = useState<string>(buildingId ?? 'ALL')
  const [selectedFloorId, setSelectedFloorId] = useState<string>('ALL')
  const [selectedRoomId, setSelectedRoomId] = useState<string>('ALL')
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [deviceTypeFilter, setDeviceTypeFilter] = useState<string>('ALL')
  const [deviceLocationFilter, setDeviceLocationFilter] = useState<string>('ALL')

  const [newDevice, setNewDevice] = useState<DeviceCreatePayload>(INITIAL_NEW_DEVICE)
  const [editingDeviceId, setEditingDeviceId] = useState<string>('')
  const [editingDeviceRoomId, setEditingDeviceRoomId] = useState<string>('')
  const [editingDeviceFrontBack, setEditingDeviceFrontBack] = useState<'FRONT' | 'BACK'>('FRONT')
  const [editingDeviceLeftRight, setEditingDeviceLeftRight] = useState<'LEFT' | 'RIGHT'>('LEFT')
  const [editingDevicePower, setEditingDevicePower] = useState<string>('0')
  const [createDeviceMessage, setCreateDeviceMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [isAddingDevice, setIsAddingDevice] = useState(false)

  const [isStructureLoading, setIsStructureLoading] = useState(true)
  const [isDevicesLoading, setIsDevicesLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedBuildingId('ALL')
    setSelectedFloorId('ALL')
    setSelectedRoomId('ALL')
  }, [buildingId])

  const floorsInScope = useMemo(() => {
    if (selectedBuildingId === 'ALL') {
      return []
    }

    const uniqueFloors = new Map<string, FloorSummary>()
    roomDirectory.forEach((item) => {
      if (item.building.id === selectedBuildingId) {
        uniqueFloors.set(item.floor.id, item.floor)
      }
    })

    return Array.from(uniqueFloors.values()).sort((left, right) => left.floor_number - right.floor_number)
  }, [roomDirectory, selectedBuildingId])

  const roomsInScope = useMemo(() => {
    return roomDirectory
      .filter((item) => (selectedBuildingId === 'ALL' ? true : item.building.id === selectedBuildingId))
      .filter((item) => (selectedFloorId === 'ALL' ? true : item.floor.id === selectedFloorId))
      .map((item) => item.room)
      .sort((left, right) => left.room_code.localeCompare(right.room_code))
  }, [roomDirectory, selectedBuildingId, selectedFloorId])

  const selectedRoom = useMemo(
    () => (selectedRoomId === 'ALL' ? null : roomsInScope.find((room) => room.id === selectedRoomId) ?? null),
    [roomsInScope, selectedRoomId],
  )

  const showCrudPanel = selectedRoomId !== 'ALL' && selectedRoom !== null

  const scopedRooms = useMemo(() => {
    return roomDirectory.filter((item) => {
      if (selectedBuildingId !== 'ALL' && item.building.id !== selectedBuildingId) {
        return false
      }

      if (selectedFloorId !== 'ALL' && item.floor.id !== selectedFloorId) {
        return false
      }

      if (selectedRoomId !== 'ALL' && item.room.id !== selectedRoomId) {
        return false
      }

      return true
    })
  }, [roomDirectory, selectedBuildingId, selectedFloorId, selectedRoomId])

  const roomContextById = useMemo(() => {
    const map = new Map<string, RoomDirectoryItem>()
    roomDirectory.forEach((entry) => {
      map.set(entry.room.id, entry)
    })
    return map
  }, [roomDirectory])

  const deviceTypeOptions = useMemo(
    () => ['ALL', ...Array.from(new Set(devices.map((device) => device.device_type))).sort()],
    [devices],
  )

  useEffect(() => {
    setSelectedFloorId('ALL')
    setSelectedRoomId('ALL')
  }, [selectedBuildingId])

  useEffect(() => {
    setSelectedRoomId('ALL')
  }, [selectedFloorId])

  useEffect(() => {
    if (selectedRoomId === 'ALL') {
      return
    }

    const roomStillVisible = roomsInScope.some((room) => room.id === selectedRoomId)
    if (!roomStillVisible) {
      setSelectedRoomId('ALL')
    }
  }, [roomsInScope, selectedRoomId])

  useEffect(() => {
    if (isGlobalMode && !canAccessGlobalWorkspace) {
      setIsStructureLoading(false)
      return
    }

    let isMounted = true

    async function loadStructure(): Promise<void> {
      setIsStructureLoading(true)
      setError(null)

      try {
        const buildingData = await getBuildingsOverview()
        const resolvedBuilding = resolveBuildingFromRouteParam(buildingData, buildingId)
        if (buildingId && !resolvedBuilding) {
          throw new Error('Building not found for this route')
        }

        const scopedBuildings = resolvedBuilding ? [resolvedBuilding] : buildingData

        const directoryByBuilding = await Promise.all(
          scopedBuildings.map(async (building) => {
            const floors = await getBuildingFloors(building.id)
            const roomsByFloor = await Promise.all(
              floors.map(async (floor) => {
                const rooms = await getFloorRooms(building.id, floor.id)
                return rooms.map((room) => ({ building, floor, room }))
              }),
            )
            return roomsByFloor.flat()
          }),
        )

        if (!isMounted) return

        setBuildings(buildingData)
        setRoomDirectory(directoryByBuilding.flat())
        if (resolvedBuilding) {
          setSelectedBuildingId(resolvedBuilding.id)
        }
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load building structure')
      } finally {
        if (isMounted) {
          setIsStructureLoading(false)
        }
      }
    }

    void loadStructure()

    return () => {
      isMounted = false
    }
  }, [buildingId, canAccessGlobalWorkspace, isGlobalMode])

  useEffect(() => {
    if (isGlobalMode && !canAccessGlobalWorkspace) {
      setIsDevicesLoading(false)
      return
    }

    let isMounted = true

    async function loadDevices(): Promise<void> {
      if (scopedRooms.length === 0) {
        setDevices([])
        setError(null)
        setIsDevicesLoading(false)
        return
      }

      setIsDevicesLoading(true)
      setError(null)

      try {
        let failedRoomCount = 0
        const roomPayloads = await mapWithConcurrency(scopedRooms, ROOM_DEVICE_FETCH_CONCURRENCY, async (entry) => {
          try {
            const [inventoryData, stateData] = await Promise.all([
              getRoomDevices(entry.room.id),
              getRoomDeviceStates(entry.room.id),
            ])

            if (inventoryData.devices.length === 0) {
              return []
            }

            return mapRoomDevicesWithContext(entry, inventoryData.devices, stateData.device_states)
          } catch {
            failedRoomCount += 1
            return []
          }
        })

        if (!isMounted) return

        const mergedDevices = roomPayloads.flat().sort(compareDevicesByContext)

        setDevices(mergedDevices)

        if (failedRoomCount > 0 && mergedDevices.length === 0) {
          setError('Failed to load devices for the selected scope. Try selecting a specific building or room, then refresh.')
        }
      } catch (loadError) {
        if (!isMounted) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load room devices')
      } finally {
        if (isMounted) {
          setIsDevicesLoading(false)
        }
      }
    }

    void loadDevices()

    return () => {
      isMounted = false
    }
  }, [canAccessGlobalWorkspace, isGlobalMode, scopedRooms])

  const visibleDevices = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()

    return devices.filter((device) => {
      const keyword = [
        device.device_id,
        device.device_type,
        device.location,
        String(device.power_consumption_watts ?? 0),
        device.status,
        device.room_code ?? '',
        device.building_code ?? '',
        device.building_name,
        `floor ${device.floor_number}`,
      ]
        .join(' ')
        .toLowerCase()

      const queryMatch = !normalizedQuery || keyword.includes(normalizedQuery)
      const typeMatch = deviceTypeFilter === 'ALL' || device.device_type === deviceTypeFilter
      const locationMatch =
        deviceLocationFilter === 'ALL' ||
        device.location_front_back === deviceLocationFilter ||
        device.location_left_right === deviceLocationFilter

      return queryMatch && typeMatch && locationMatch
    })
  }, [deviceLocationFilter, deviceTypeFilter, devices, searchQuery])

  const devicesByRoom = useMemo(() => {
    const grouped = new Map<string, DeviceWithContext[]>()

    visibleDevices.forEach((device) => {
      const roomDevices = grouped.get(device.room_id)
      if (roomDevices) {
        roomDevices.push(device)
      } else {
        grouped.set(device.room_id, [device])
      }
    })

    return Array.from(grouped.values()).map((roomDevices) => {
      const first = roomDevices[0]
      return {
        room_id: first.room_id,
        room_code: first.room_code,
        floor_number: first.floor_number,
        building_code: first.building_code,
        building_name: first.building_name,
        devices: roomDevices,
      }
    })
  }, [visibleDevices])

  const onCount = useMemo(
    () => visibleDevices.filter((device) => (device.status ?? 'OFF').toUpperCase() === 'ON').length,
    [visibleDevices],
  )

  const offCount = useMemo(() => visibleDevices.length - onCount, [onCount, visibleDevices.length])

  const refreshRoomDevices = useCallback(
    async (roomId: string): Promise<void> => {
      const roomEntry = roomContextById.get(roomId)
      if (!roomEntry) {
        throw new Error('Room is outside the current workspace scope.')
      }

      const [inventoryData, stateData] = await Promise.all([
        getRoomDevices(roomEntry.room.id),
        getRoomDeviceStates(roomEntry.room.id),
      ])

      const roomDevices = mapRoomDevicesWithContext(roomEntry, inventoryData.devices, stateData.device_states)

      setDevices((previousDevices) => {
        const nextDevices = [...previousDevices.filter((item) => item.room_id !== roomId), ...roomDevices]
        return nextDevices.sort(compareDevicesByContext)
      })
    },
    [roomContextById],
  )

  async function handleToggleDevice(device: DeviceWithContext): Promise<void> {
    if (!canToggleDevices) {
      setError('You do not have permission to toggle devices.')
      return
    }

    try {
      const isOn = (device.status ?? 'OFF').toUpperCase() === 'ON'
      await toggleDevice(device.room_id, device.device_id, { action: isOn ? 'OFF' : 'ON' })
      await refreshRoomDevices(device.room_id)
      setError(null)
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Failed to toggle device')
    }
  }

  function openEditDevice(device: DeviceWithContext): void {
    setEditingDeviceId(device.device_id)
    setEditingDeviceRoomId(device.room_id)
    setEditingDeviceFrontBack(device.location_front_back)
    setEditingDeviceLeftRight(device.location_left_right)
    setEditingDevicePower(String(device.power_consumption_watts ?? 0))
  }

  async function handleUpdateDevice(device: DeviceWithContext): Promise<void> {
    if (!canManageDevices) {
      setError('You do not have permission to update devices.')
      return
    }

    try {
      await updateRoomDevice(device.room_id, device.device_id, {
        location_front_back: editingDeviceFrontBack,
        location_left_right: editingDeviceLeftRight,
        power_consumption_watts: Number(editingDevicePower) || 0,
      })
      await refreshRoomDevices(device.room_id)
      setEditingDeviceId('')
      setEditingDeviceRoomId('')
      setError(null)
      setCreateDeviceMessage({ type: 'success', text: `Device ${device.device_id} updated successfully.` })
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update device')
    }
  }

  async function handleDeleteDevice(device: DeviceWithContext): Promise<void> {
    if (!canManageDevices) {
      setError('You do not have permission to delete devices.')
      return
    }

    if (!window.confirm('Delete this device? This action cannot be undone.')) {
      return
    }

    try {
      await removeRoomDevice(device.room_id, device.device_id)
      setDevices((previousDevices) =>
        previousDevices.filter((item) => !(item.room_id === device.room_id && item.device_id === device.device_id)),
      )

      if (editingDeviceRoomId === device.room_id && editingDeviceId === device.device_id) {
        setEditingDeviceId('')
        setEditingDeviceRoomId('')
      }

      await refreshRoomDevices(device.room_id)
      setError(null)
      setCreateDeviceMessage({ type: 'success', text: `Device ${device.device_id} deleted successfully.` })
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete device')
    }
  }

  async function handleAddDevice(): Promise<void> {
    if (!selectedRoom || selectedRoomId === 'ALL') {
      setCreateDeviceMessage({ type: 'error', text: 'Select a specific room before creating a device.' })
      return
    }

    if (!canManageDevices) {
      setCreateDeviceMessage({ type: 'error', text: 'You do not have permission to add devices.' })
      return
    }

    if (!newDevice.location_front_back || !newDevice.location_left_right) {
      setCreateDeviceMessage({ type: 'error', text: 'Location axis values are required to create a device.' })
      return
    }

    setIsAddingDevice(true)

    try {
      await addRoomDevice(selectedRoom.id, {
        device_type: newDevice.device_type,
        location_front_back: newDevice.location_front_back,
        location_left_right: newDevice.location_left_right,
        power_consumption_watts: newDevice.power_consumption_watts,
      })

      await refreshRoomDevices(selectedRoom.id)

      setNewDevice(INITIAL_NEW_DEVICE)
      setError(null)
      setCreateDeviceMessage({ type: 'success', text: `Device created successfully in room ${selectedRoom.room_code}.` })
    } catch (createError) {
      setCreateDeviceMessage({
        type: 'error',
        text: createError instanceof Error ? createError.message : 'Failed to create device',
      })
    } finally {
      setIsAddingDevice(false)
    }
  }

  if (isGlobalMode && !canAccessGlobalWorkspace) {
    return (
      <main className="page">
        <section className="panel error-panel">
          Global devices workspace is only available for System Admin and operations roles.
        </section>
      </main>
    )
  }

  return (
    <AdminBuildingLayout
      buildingId={buildingId}
      title="Devices Table"
      subtitle={isGlobalMode
        ? 'Global device monitoring, toggle control, and CRUD operations across all rooms.'
        : 'Room-level device monitoring and controls for the selected building.'}
      metrics={[
        { label: 'Devices', value: visibleDevices.length, tone: 'neutral' },
        { label: 'Online', value: onCount, tone: 'safe' },
        { label: 'Offline', value: offCount, tone: offCount > 0 ? 'warn' : 'neutral' },
      ]}
      eyebrow={isGlobalMode ? 'Campus Management' : 'Building Workspace'}
      showCommandLinks={false}
    >
      <section className="panel sessions-toolbar-panel">
        <div className="sessions-toolbar-grid devices-toolbar-grid">
          {isGlobalMode ? (
            <div className="filter-group">
              <label htmlFor="devices-building-filter">Building</label>
              <select
                id="devices-building-filter"
                value={selectedBuildingId}
                onChange={(event) => setSelectedBuildingId(event.target.value)}
              >
                <option value="ALL">All Buildings</option>
                {buildings.map((building) => (
                  <option key={building.id} value={building.id}>
                    {building.code ?? 'N/A'} | {building.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="filter-group">
            <label htmlFor="devices-floor-filter">Floor</label>
            <select
              id="devices-floor-filter"
              value={selectedFloorId}
              onChange={(event) => setSelectedFloorId(event.target.value)}
              disabled={selectedBuildingId === 'ALL'}
            >
              <option value="ALL">All Floors</option>
              {floorsInScope.map((floor) => (
                <option key={floor.id} value={floor.id}>
                  F{floor.floor_number} {floor.name ?? ''}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="devices-room-filter">Room</label>
            <select
              id="devices-room-filter"
              value={selectedRoomId}
              onChange={(event) => setSelectedRoomId(event.target.value)}
              disabled={selectedBuildingId === 'ALL'}
            >
              <option value="ALL">All Rooms</option>
              {roomsInScope.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.room_code} {room.name ?? ''}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="devices-type-filter">Type</label>
            <select
              id="devices-type-filter"
              value={deviceTypeFilter}
              onChange={(event) => setDeviceTypeFilter(event.target.value)}
            >
              {deviceTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="devices-location-filter">Location Axis</label>
            <select
              id="devices-location-filter"
              value={deviceLocationFilter}
              onChange={(event) => setDeviceLocationFilter(event.target.value)}
            >
              <option value="ALL">ALL LOCATION AXES</option>
              <option value="FRONT">FRONT</option>
              <option value="BACK">BACK</option>
              <option value="LEFT">LEFT</option>
              <option value="RIGHT">RIGHT</option>
            </select>
          </div>

          <div className="filter-group sessions-search-group">
            <label htmlFor="devices-search">Search</label>
            <input
              id="devices-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search building, floor, room, id, type, status, or watts"
            />
          </div>
        </div>
      </section>

      {(isStructureLoading || isDevicesLoading) && <section className="panel">Loading devices...</section>}
      {error ? <section className="panel error-panel">{error}</section> : null}

      {showCrudPanel ? (
        <section className="panel device-subpanel">
          <div className="section-title-row">
            <h3>CRUD Activities Panel</h3>
            <span>Target room: {selectedRoom.room_code}</span>
          </div>

          {createDeviceMessage ? (
            <div className={`message-banner ${createDeviceMessage.type}`}>
              {createDeviceMessage.text}
            </div>
          ) : null}

          <p className="muted">
            {canToggleDevices
              ? 'Toggle actions are available on every row. Create action requires a selected room.'
              : 'View-only mode. Your current role does not allow device control actions.'}
          </p>

          <div className="device-create-grid">
            <select
              value={newDevice.device_type}
              onChange={(event) => setNewDevice((prev) => ({ ...prev, device_type: event.target.value }))}
            >
              <option value="LIGHT">LIGHT</option>
              <option value="AC">AC</option>
              <option value="FAN">FAN</option>
              <option value="CAMERA">CAMERA</option>
            </select>

            <select
              value={newDevice.location_front_back}
              onChange={(event) =>
                setNewDevice((prev) => ({
                  ...prev,
                  location_front_back: event.target.value as 'FRONT' | 'BACK',
                }))
              }
            >
              <option value="FRONT">FRONT</option>
              <option value="BACK">BACK</option>
            </select>

            <select
              value={newDevice.location_left_right}
              onChange={(event) =>
                setNewDevice((prev) => ({
                  ...prev,
                  location_left_right: event.target.value as 'LEFT' | 'RIGHT',
                }))
              }
            >
              <option value="LEFT">LEFT</option>
              <option value="RIGHT">RIGHT</option>
            </select>

            <input
              type="number"
              min={0}
              value={newDevice.power_consumption_watts ?? 0}
              onChange={(event) =>
                setNewDevice((prev) => ({
                  ...prev,
                  power_consumption_watts: Number(event.target.value),
                }))
              }
              placeholder="Power (W)"
            />

            <button
              type="button"
              onClick={() => void handleAddDevice()}
              disabled={!canManageDevices || selectedRoomId === 'ALL' || isAddingDevice}
              className={isAddingDevice ? 'loading' : ''}
            >
              {isAddingDevice ? 'Creating...' : 'Create Device'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="section-title-row">
          <h2>Device Operations Table</h2>
          <span>{visibleDevices.length} records</span>
        </div>

        {devicesByRoom.length > 0 ? (
          <div className="facility-room-groups">
            {devicesByRoom.map((roomGroup) => (
              <article key={roomGroup.room_id} className="panel room-device-group">
                <div className="section-title-row">
                  <h3>
                    {roomGroup.building_code ?? roomGroup.building_name} | F{roomGroup.floor_number} | Room {roomGroup.room_code ?? '-'}
                  </h3>
                  <span>{roomGroup.devices.length} devices</span>
                </div>

                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Device</th>
                        <th>Type</th>
                        <th>Location</th>
                        <th>Power (W)</th>
                        <th>Status</th>
                        <th>Last Updated</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roomGroup.devices.map((device) => {
                        const isOn = (device.status ?? 'OFF').toUpperCase() === 'ON'
                        const isEditing = editingDeviceId === device.device_id && editingDeviceRoomId === device.room_id

                        return (
                          <tr key={`${device.room_id}:${device.device_id}`}>
                            <td>{device.device_id}</td>
                            <td>{device.device_type}</td>
                            <td>
                              {isEditing ? (
                                <div className="inline-filters">
                                  <select
                                    value={editingDeviceFrontBack}
                                    onChange={(event) => setEditingDeviceFrontBack(event.target.value as 'FRONT' | 'BACK')}
                                  >
                                    <option value="FRONT">FRONT</option>
                                    <option value="BACK">BACK</option>
                                  </select>
                                  <select
                                    value={editingDeviceLeftRight}
                                    onChange={(event) => setEditingDeviceLeftRight(event.target.value as 'LEFT' | 'RIGHT')}
                                  >
                                    <option value="LEFT">LEFT</option>
                                    <option value="RIGHT">RIGHT</option>
                                  </select>
                                </div>
                              ) : (
                                device.location
                              )}
                            </td>
                            <td>
                              {isEditing ? (
                                <input
                                  type="number"
                                  min={0}
                                  value={editingDevicePower}
                                  onChange={(event) => setEditingDevicePower(event.target.value)}
                                />
                              ) : (
                                device.power_consumption_watts ?? 0
                              )}
                            </td>
                            <td>
                              <span className={`device-status ${isOn ? 'on' : 'off'}`}>{isOn ? 'ON' : 'OFF'}</span>
                            </td>
                            <td>{toLocalDateTime(device.last_updated)}</td>
                            <td>
                              <div className="row-actions device-row-actions">
                                <button
                                  type="button"
                                  onClick={() => void handleToggleDevice(device)}
                                  disabled={!canToggleDevices}
                                >
                                  Toggle
                                </button>

                                {isEditing ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => void handleUpdateDevice(device)}
                                      disabled={!canManageDevices}
                                    >
                                      Save
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingDeviceId('')
                                        setEditingDeviceRoomId('')
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => openEditDevice(device)}
                                    disabled={!canManageDevices}
                                  >
                                    Edit
                                  </button>
                                )}

                                <button
                                  type="button"
                                  onClick={() => void handleDeleteDevice(device)}
                                  disabled={!canManageDevices}
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {!isStructureLoading && !isDevicesLoading && !error && visibleDevices.length === 0 ? (
          <p className="muted">No devices match your current search and filter criteria.</p>
        ) : null}
      </section>
    </AdminBuildingLayout>
  )
}
