export function toLocalDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return '-'

  const now = Date.now()
  const then = new Date(value).getTime()
  const diffMs = now - then
  const diffMinutes = Math.floor(diffMs / 60000)

  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}
