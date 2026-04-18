import type { BuildingOverview } from '../types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function normalizeBuildingCode(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase()
}

export function isUuidLikeBuildingId(value: string): boolean {
  return UUID_PATTERN.test(value.trim())
}

export function toBuildingRouteParam(building: BuildingOverview): string {
  const normalizedCode = normalizeBuildingCode(building.code)
  return normalizedCode || building.id
}

export function resolveBuildingFromRouteParam(
  buildings: BuildingOverview[],
  routeParam: string | undefined,
): BuildingOverview | null {
  if (!routeParam) {
    return null
  }

  const trimmedParam = routeParam.trim()
  const normalizedCode = trimmedParam.toUpperCase()

  return (
    buildings.find((building) => building.id === trimmedParam)
    ?? buildings.find((building) => normalizeBuildingCode(building.code) === normalizedCode)
    ?? null
  )
}
