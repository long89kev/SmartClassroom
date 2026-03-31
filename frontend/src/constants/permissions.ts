export const PERMISSIONS = {
  DASHBOARD_VIEW_CLASSROOM: 'dashboard:view_classroom',
  DASHBOARD_VIEW_BLOCK: 'dashboard:view_block',
  DASHBOARD_VIEW_UNIVERSITY: 'dashboard:view_university',
  DASHBOARD_VIEW_MINIMAL: 'dashboard:view_minimal',

  DEVICE_MANAGEMENT: 'deploy:device_management',
  SYSTEM_SETTINGS: 'deploy:system_settings',
  ENV_THRESHOLDS: 'env_control:thresholds',
  ENV_LIGHT: 'env_control:light',
  ENV_AC: 'env_control:ac',
  ENV_FAN: 'env_control:fan',

  MODE_SWITCH_LEARNING: 'mode:switch_learning',
  MODE_SWITCH_TESTING: 'mode:switch_testing',

  INCIDENT_VIEW: 'incident:view',
  INCIDENT_VIEW_SELF: 'incident:view_self',
  INCIDENT_AUDIT: 'incident:audit',
  INCIDENT_RESOLVE: 'incident:resolve',
  ALERT_ACKNOWLEDGE: 'ai_alerts:acknowledge',

  CAMERA_VIEW_LIVE: 'camera:view_live',
  CAMERA_VIEW_RECORDED: 'camera:view_recorded',

  REPORT_PERFORMANCE: 'report:performance',
  REPORT_ATTENDANCE_SELF: 'report:attendance_self',
  REPORT_BEHAVIOR_SELF: 'report:behavior_self',
  DASHBOARD_VIEW_STUDENT_SELF: 'dashboard:view_student_self',
} as const

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]
