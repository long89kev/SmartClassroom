-- ============================================================================
-- SMART AI-IOT CLASSROOM SYSTEM - POSTGRESQL SCHEMA
-- ============================================================================
-- Initialization script to set up all required tables and configurations

-- Create UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. UNIVERSITY CORE TABLES (Hierarchical Structure)
-- ============================================================================

-- Buildings
CREATE TABLE IF NOT EXISTS buildings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  location VARCHAR(255),
  code VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- USERS & AUTHENTICATION (Must come early - referenced by many tables)
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'LECTURER',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CHECK (role IN ('LECTURER', 'EXAM_PROCTOR', 'ACADEMIC_BOARD', 'SYSTEM_ADMIN', 'FACILITY_STAFF', 'CLEANING_STAFF', 'STUDENT'))
);

-- Floors
CREATE TABLE IF NOT EXISTS floors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor_number INT NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(building_id, floor_number)
);

-- Rooms
CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id UUID NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  room_code VARCHAR(50) NOT NULL UNIQUE, -- e.g., B1-103
  name VARCHAR(255),
  capacity INT DEFAULT 30,
  devices JSONB DEFAULT '{"device_list": []}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Subjects
CREATE TABLE IF NOT EXISTS subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  code VARCHAR(50) UNIQUE,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Teachers
CREATE TABLE IF NOT EXISTS teachers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  phone VARCHAR(20),
  department VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Students
CREATE TABLE IF NOT EXISTS students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  student_id VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  class VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enrollments (Many-to-Many: Students <-> Subjects)
CREATE TABLE IF NOT EXISTS enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  enrollment_date TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id, subject_id)
);

-- ============================================================================
-- 2. TIMETABLE & SESSION MANAGEMENT
-- ============================================================================

-- University Timetable (Fixed schedule)`
CREATE TABLE IF NOT EXISTS timetable (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  day_of_week INT NOT NULL, -- 0=Monday, 6=Sunday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  expected_students INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Class Sessions (Runtime sessions based on timetable)
CREATE TABLE IF NOT EXISTS class_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES teachers(id),
  subject_id UUID NOT NULL REFERENCES subjects(id),
  timetable_id UUID REFERENCES timetable(id),
  mode VARCHAR(20) DEFAULT 'NORMAL', -- NORMAL or TESTING
  start_time TIMESTAMP DEFAULT NOW(),
  end_time TIMESTAMP,
  students_present JSONB DEFAULT '[]', -- List of student UUIDs present
  final_performance_score FLOAT,
  final_risk_score FLOAT,
  status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, COMPLETED, CANCELLED
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 2B. ATTENDANCE TRACKING
-- ============================================================================

-- Per-session attendance configuration
CREATE TABLE IF NOT EXISTS attendance_session_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL UNIQUE REFERENCES class_sessions(id),
  grace_minutes INT NOT NULL DEFAULT 10,
  min_confidence FLOAT NOT NULL DEFAULT 0.75,
  auto_checkin_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CHECK (grace_minutes >= 0 AND grace_minutes <= 90),
  CHECK (min_confidence >= 0.0 AND min_confidence <= 1.0)
);

-- Face embedding templates for attendance recognition
CREATE TABLE IF NOT EXISTS attendance_face_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id),
  embedding JSONB NOT NULL,
  quality_score FLOAT DEFAULT 0.0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CHECK (quality_score >= 0.0 AND quality_score <= 1.0)
);

-- Attendance recognition events from door camera or mock ingest
CREATE TABLE IF NOT EXISTS attendance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES class_sessions(id),
  student_id UUID NOT NULL REFERENCES students(id),
  source VARCHAR(50) DEFAULT 'DOOR_CAMERA',
  face_confidence FLOAT DEFAULT 0.0,
  is_recognized BOOLEAN DEFAULT FALSE,
  occurred_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  CHECK (face_confidence >= 0.0 AND face_confidence <= 1.0)
);

-- ============================================================================
-- 3. AI MODEL TRACKING & BEHAVIOR LOGS
-- ============================================================================

-- Behavior Classes (Configurable learning mode behaviors)
CREATE TABLE IF NOT EXISTS behavior_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_name VARCHAR(100) NOT NULL UNIQUE,
  actor_type VARCHAR(20) NOT NULL, -- STUDENT or TEACHER
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Behavior Logs (Real-time detections from YOLO)
CREATE TABLE IF NOT EXISTS behavior_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL, -- Student or Teacher UUID
  actor_type VARCHAR(20) NOT NULL, -- STUDENT or TEACHER
  behavior_class VARCHAR(100) NOT NULL, -- References behavior_classes.class_name
  count INT DEFAULT 1, -- Frequency of behavior
  duration_seconds INT DEFAULT 0, -- Duration if applicable
  detected_at TIMESTAMP DEFAULT NOW(),
  frame_snapshot BYTEA, -- Snapshot image as binary
  yolo_confidence FLOAT DEFAULT 0.0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Performance Session Aggregates (Pre-calculated per session per actor)
CREATE TABLE IF NOT EXISTS performance_aggregates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL,
  actor_type VARCHAR(20) NOT NULL,
  total_score FLOAT DEFAULT 0.0,
  behavior_breakdown JSONB DEFAULT '{}', -- {behavior: score, ...}
  calculated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(session_id, actor_id)
);

-- ============================================================================
-- 4. CHEAT DETECTION & RISK INCIDENTS
-- ============================================================================

-- Risk Behaviors (Testing mode - what triggers cheat detection)
CREATE TABLE IF NOT EXISTS risk_behaviors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  behavior_name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Risk Incidents (Cheat detection alerts)
CREATE TABLE IF NOT EXISTS risk_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id),
  risk_score FLOAT NOT NULL,
  risk_level VARCHAR(20) NOT NULL, -- CRITICAL, HIGH, MEDIUM, LOW
  triggered_behaviors JSONB NOT NULL, -- {"head_turns": 5, "talk_events": 3, "phone_duration": 45}
  frame_snapshot BYTEA, -- Snapshot of suspicious moment
  flagged_at TIMESTAMP DEFAULT NOW(),
  reviewed BOOLEAN DEFAULT FALSE,
  reviewer_id UUID REFERENCES teachers(id),
  reviewer_notes VARCHAR(500),
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 5. IOT DEVICE MANAGEMENT & AUTO-RULES
-- ============================================================================

-- IoT Auto-Rules (Conditional automation rules)
CREATE TABLE IF NOT EXISTS iot_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name VARCHAR(255) NOT NULL,
  scope_type VARCHAR(20) NOT NULL CHECK (scope_type IN ('GLOBAL', 'BUILDING', 'ROOM')),
  building_id UUID REFERENCES buildings(id) ON DELETE CASCADE,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  condition_type VARCHAR(50) NOT NULL, -- OCCUPANCY, TIMETABLE, ZERO_OCCUPANCY, TIME_BASED
  condition_params JSONB NOT NULL, -- {"min_occupancy": 1, "duration_minutes": 2}
  actions JSONB NOT NULL, -- [{"device_type": "AC", "action": "ON"}, ...]
  is_active BOOLEAN DEFAULT TRUE,
  priority INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_triggered TIMESTAMP,
  CHECK (
    (scope_type = 'GLOBAL' AND building_id IS NULL AND room_id IS NULL) OR
    (scope_type = 'BUILDING' AND building_id IS NOT NULL AND room_id IS NULL) OR
    (scope_type = 'ROOM' AND room_id IS NOT NULL AND building_id IS NULL)
  )
);

-- Device States (Current real-time status of all devices)
CREATE TABLE IF NOT EXISTS device_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  device_type VARCHAR(50) NOT NULL, -- LIGHT, FAN, AC, PROJECTOR, SENSOR, etc.
  status VARCHAR(20) NOT NULL DEFAULT 'OFF', -- ON, OFF, ERROR, STANDBY
  last_toggled_by UUID REFERENCES teachers(id), -- Manual override by whom
  manual_override BOOLEAN DEFAULT FALSE,
  override_until TIMESTAMP,
  last_updated TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(room_id, device_id)
);

-- Room Devices (Normalized inventory source-of-truth for layout imports)
CREATE TABLE IF NOT EXISTS room_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  device_type VARCHAR(50) NOT NULL,
  location_front_back VARCHAR(10) NOT NULL CHECK (location_front_back IN ('FRONT', 'BACK')),
  location_left_right VARCHAR(10) NOT NULL CHECK (location_left_right IN ('LEFT', 'RIGHT')),
  x_percent NUMERIC(5,2),
  y_percent NUMERIC(5,2),
  power_consumption_watts INT DEFAULT 0 CHECK (power_consumption_watts >= 0),
  is_active BOOLEAN DEFAULT TRUE,
  source VARCHAR(20) NOT NULL DEFAULT 'MANUAL', -- MANUAL | IMPORT
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(room_id, device_id)
);

-- Room Layout Import Jobs (File-level audit trail)
CREATE TABLE IF NOT EXISTS room_layout_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(20) NOT NULL, -- CSV | JSON | XLSX
  file_sha256 VARCHAR(64),
  import_mode VARCHAR(20) NOT NULL, -- REPLACE | MERGE | VALIDATE_ONLY
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING | SUCCESS | PARTIAL | FAILED
  total_rows INT DEFAULT 0,
  success_rows INT DEFAULT 0,
  failed_rows INT DEFAULT 0,
  error_summary TEXT,
  imported_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Room Layout Import Rows (Row-level parse/validation results)
CREATE TABLE IF NOT EXISTS room_layout_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_job_id UUID NOT NULL REFERENCES room_layout_import_jobs(id) ON DELETE CASCADE,
  row_number INT NOT NULL,
  raw_payload JSONB NOT NULL,
  parsed_device_id VARCHAR(255),
  parsed_device_type VARCHAR(50),
  parsed_location_front_back VARCHAR(10),
  parsed_location_left_right VARCHAR(10),
  status VARCHAR(20) NOT NULL, -- SUCCESS | FAILED | SKIPPED
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Device Type Catalog (single source for supported physical device entities)
CREATE TABLE IF NOT EXISTS device_types (
  code VARCHAR(50) PRIMARY KEY, -- LIGHT, AC, FAN, CAMERA
  display_name VARCHAR(100) NOT NULL,
  unit VARCHAR(30), -- LUX, CELSIUS, RPM, BOOLEAN
  default_min FLOAT,
  default_max FLOAT,
  default_target FLOAT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CHECK (default_min IS NULL OR default_max IS NULL OR default_min <= default_max)
);

-- Global threshold profiles per device type
CREATE TABLE IF NOT EXISTS device_threshold_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_type_code VARCHAR(50) NOT NULL REFERENCES device_types(code) ON DELETE CASCADE,
  min_value FLOAT,
  max_value FLOAT,
  target_value FLOAT,
  enabled BOOLEAN DEFAULT TRUE,
  updated_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(device_type_code),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)
);

-- Room-level threshold overrides per device type
CREATE TABLE IF NOT EXISTS room_device_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  device_type_code VARCHAR(50) NOT NULL REFERENCES device_types(code) ON DELETE CASCADE,
  min_value FLOAT,
  max_value FLOAT,
  target_value FLOAT,
  enabled BOOLEAN DEFAULT TRUE,
  updated_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(room_id, device_type_code),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)
);

-- Polling refresh interval settings with hierarchical scope overrides
CREATE TABLE IF NOT EXISTS refresh_interval_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type VARCHAR(20) NOT NULL CHECK (scope_type IN ('GROUP', 'BUILDING', 'ROOM')),
  scope_id VARCHAR(100) NOT NULL,
  mode VARCHAR(20) NOT NULL CHECK (mode IN ('NORMAL', 'TESTING')),
  interval_ms INT NOT NULL CHECK (interval_ms >= 1000 AND interval_ms <= 120000),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(scope_type, scope_id, mode)
);

-- ============================================================================
-- 6. PERFORMANCE & RISK WEIGHT CONFIGURATIONS
-- ============================================================================

-- Performance Weights (Global defaults + per-subject overrides)
CREATE TABLE IF NOT EXISTS performance_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL, -- NULL = global default
  behavior_name VARCHAR(100) NOT NULL,
  actor_type VARCHAR(20) NOT NULL, -- STUDENT or TEACHER
  weight FLOAT NOT NULL, -- Positive or negative score multiplier
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(subject_id, behavior_name, actor_type)
);

-- Risk Detection Weights (Cheat detection equation parameters)
CREATE TABLE IF NOT EXISTS risk_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_behavior VARCHAR(100) NOT NULL UNIQUE,
  alpha_head_turn FLOAT DEFAULT 0.3,
  beta_talk FLOAT DEFAULT 0.5,
  gamma_device_use FLOAT DEFAULT 0.8,
  alert_threshold FLOAT DEFAULT 50.0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);


-- ============================================================================
-- 7. OCCUPANCY & SESSION TRACKING
-- ============================================================================
-- Room Occupancy Tracking (Real-time occupancy count per room)
CREATE TABLE IF NOT EXISTS room_occupancy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  occupancy_count INT DEFAULT 0, -- Number of people detected
  is_occupied BOOLEAN DEFAULT FALSE,
  last_detected TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(room_id)
);

-- Room Sensor Readings (latest per room + sensor key)
CREATE TABLE IF NOT EXISTS room_sensor_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sensor_key VARCHAR(50) NOT NULL,
  value FLOAT NOT NULL,
  unit VARCHAR(20),
  source_topic VARCHAR(255),
  captured_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(room_id, sensor_key)
);

-- ============================================================================
-- 9. AUDIT LOG (For tracking all changes)
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(100) NOT NULL, -- e.g., device_toggle, rule_triggered
  entity_id UUID,
  action VARCHAR(50) NOT NULL, -- CREATE, UPDATE, DELETE, TOGGLE
  performed_by UUID REFERENCES users(id),
  changes JSONB, -- Old vs new values
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 9B. RBAC POLICY TABLES (Authorization & Scope Management)
-- ============================================================================

-- Permissions (Fine-grained permission keys)
CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(255),
  description TEXT,
  category VARCHAR(50), -- camera, ai_alerts, env_control, dashboard_scope, mode_controls, incident_review, reporting, deployment
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Role-Permission Mapping
CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role VARCHAR(50) NOT NULL,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(role, permission_id),
  CHECK (role IN ('LECTURER', 'EXAM_PROCTOR', 'ACADEMIC_BOARD', 'SYSTEM_ADMIN', 'FACILITY_STAFF', 'CLEANING_STAFF', 'STUDENT'))
);

-- User-to-Room Assignments (Scope: Lecturers assigned to specific rooms/sessions)
CREATE TABLE IF NOT EXISTS user_room_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  can_view BOOLEAN DEFAULT TRUE,
  can_control BOOLEAN DEFAULT FALSE,
  assigned_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, room_id)
);

-- User-to-Block Assignments (Scope: Academic Board / Facility Staff assigned to blocks)
CREATE TABLE IF NOT EXISTS user_block_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  floor_id UUID NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  can_view BOOLEAN DEFAULT TRUE,
  can_control BOOLEAN DEFAULT FALSE,
  assigned_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, floor_id)
);

-- Role-to-Mode Access Matrix (Optional: EXAM_PROCTOR mode switching controls)
CREATE TABLE IF NOT EXISTS role_mode_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role VARCHAR(50) NOT NULL UNIQUE,
  can_switch_to_testing BOOLEAN DEFAULT FALSE,
  can_switch_to_learning BOOLEAN DEFAULT FALSE,
  can_view_reports BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CHECK (role IN ('LECTURER', 'EXAM_PROCTOR', 'ACADEMIC_BOARD', 'SYSTEM_ADMIN', 'FACILITY_STAFF', 'CLEANING_STAFF', 'STUDENT'))
);

-- ============================================================================
-- 9C. BOARD-LEVEL ATTENDANCE ANALYTICS TABLES
-- ============================================================================

-- Configurable threshold matrix for board KPI alerting by scope.
CREATE TABLE IF NOT EXISTS attendance_board_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type VARCHAR(20) NOT NULL CHECK (scope_type IN ('SCHOOL', 'BUILDING', 'ROOM', 'SUBJECT')),
  scope_id VARCHAR(120) NOT NULL DEFAULT 'GLOBAL',
  min_attendance_rate NUMERIC(5,2) NOT NULL DEFAULT 85.00 CHECK (min_attendance_rate >= 0 AND min_attendance_rate <= 100),
  max_late_rate NUMERIC(5,2) NOT NULL DEFAULT 10.00 CHECK (max_late_rate >= 0 AND max_late_rate <= 100),
  max_absent_rate NUMERIC(5,2) NOT NULL DEFAULT 15.00 CHECK (max_absent_rate >= 0 AND max_absent_rate <= 100),
  note VARCHAR(255),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(scope_type, scope_id)
);

-- Export/audit trail for attendance command center report generation.
CREATE TABLE IF NOT EXISTS attendance_dashboard_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  export_format VARCHAR(10) NOT NULL CHECK (export_format IN ('CSV', 'XLSX')),
  filter_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS', 'FAILED')),
  failure_reason TEXT
);

-- ============================================================================
-- 10. INDEXES (For performance optimization)
-- ============================================================================

CREATE INDEX idx_floors_building_id ON floors(building_id);
CREATE INDEX idx_rooms_floor_id ON rooms(floor_id);
CREATE INDEX idx_enrollments_student_id ON enrollments(student_id);
CREATE INDEX idx_enrollments_subject_id ON enrollments(subject_id);
CREATE INDEX idx_behavior_logs_session_id ON behavior_logs(session_id);
CREATE INDEX idx_behavior_logs_actor_id ON behavior_logs(actor_id);
CREATE INDEX idx_behavior_logs_detected_at ON behavior_logs(detected_at);
CREATE INDEX idx_class_sessions_room_id ON class_sessions(room_id);
CREATE INDEX idx_class_sessions_teacher_id ON class_sessions(teacher_id);
CREATE INDEX idx_class_sessions_start_time ON class_sessions(start_time);
CREATE INDEX idx_attendance_session_configs_session_id ON attendance_session_configs(session_id);
CREATE INDEX idx_attendance_face_templates_student_id ON attendance_face_templates(student_id);
CREATE INDEX idx_attendance_face_templates_is_active ON attendance_face_templates(is_active);
CREATE INDEX idx_attendance_events_session_id ON attendance_events(session_id);
CREATE INDEX idx_attendance_events_student_id ON attendance_events(student_id);
CREATE INDEX idx_attendance_events_occurred_at ON attendance_events(occurred_at);
CREATE INDEX idx_attendance_events_is_recognized ON attendance_events(is_recognized);
CREATE INDEX idx_attendance_events_created_by_user_id ON attendance_events(created_by_user_id);
CREATE INDEX idx_attendance_events_session_student_time ON attendance_events(session_id, student_id, occurred_at);
CREATE INDEX idx_risk_incidents_session_id ON risk_incidents(session_id);
CREATE INDEX idx_risk_incidents_student_id ON risk_incidents(student_id);
CREATE INDEX idx_device_states_room_id ON device_states(room_id);
CREATE INDEX idx_room_devices_room_id ON room_devices(room_id);
CREATE INDEX idx_room_devices_device_type ON room_devices(device_type);
CREATE INDEX idx_room_layout_import_jobs_room_id ON room_layout_import_jobs(room_id);
CREATE INDEX idx_room_layout_import_jobs_status ON room_layout_import_jobs(status);
CREATE INDEX idx_room_layout_import_rows_job_id ON room_layout_import_rows(import_job_id);
CREATE INDEX idx_device_threshold_profiles_type ON device_threshold_profiles(device_type_code);
CREATE INDEX idx_room_device_thresholds_room_id ON room_device_thresholds(room_id);
CREATE INDEX idx_room_device_thresholds_type ON room_device_thresholds(device_type_code);
CREATE INDEX idx_refresh_interval_settings_scope ON refresh_interval_settings(scope_type, scope_id, mode);
CREATE INDEX idx_iot_rules_room_id ON iot_rules(room_id);
CREATE INDEX idx_performance_weights_subject_id ON performance_weights(subject_id);
CREATE INDEX idx_room_occupancy_room_id ON room_occupancy(room_id);
CREATE INDEX idx_room_sensor_readings_room_id ON room_sensor_readings(room_id);
CREATE INDEX idx_room_sensor_readings_sensor_key ON room_sensor_readings(sensor_key);
CREATE INDEX idx_room_sensor_readings_captured_at ON room_sensor_readings(captured_at);
CREATE INDEX idx_audit_logs_entity_id ON audit_logs(entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_iot_rules_scope_type ON iot_rules(scope_type);
CREATE INDEX idx_iot_rules_building_id ON iot_rules(building_id);

-- RBAC Policy indexes
CREATE INDEX idx_permissions_category ON permissions(category);
CREATE INDEX idx_permissions_is_active ON permissions(is_active);
CREATE INDEX idx_role_permissions_role ON role_permissions(role);
CREATE INDEX idx_role_permissions_permission_id ON role_permissions(permission_id);
CREATE INDEX idx_user_room_assignments_user_id ON user_room_assignments(user_id);
CREATE INDEX idx_user_room_assignments_room_id ON user_room_assignments(room_id);
CREATE INDEX idx_user_block_assignments_user_id ON user_block_assignments(user_id);
CREATE INDEX idx_user_block_assignments_floor_id ON user_block_assignments(floor_id);
CREATE INDEX idx_role_mode_access_role ON role_mode_access(role);
CREATE INDEX idx_attendance_board_thresholds_scope ON attendance_board_thresholds(scope_type, scope_id);
CREATE INDEX idx_attendance_dashboard_exports_requested_by ON attendance_dashboard_exports(requested_by);
CREATE INDEX idx_attendance_dashboard_exports_generated_at ON attendance_dashboard_exports(generated_at);

-- ============================================================================
-- 11. SEED DATA (Initial setup)
-- ============================================================================

-- Supported physical device entities for dashboard + threshold controls
INSERT INTO device_types (code, display_name, unit, default_min, default_max, default_target, is_active) VALUES
('LIGHT', 'Light', 'LUX', 150, 800, 350, TRUE),
('AC', 'Air Conditioner', 'CELSIUS', 20, 28, 24, TRUE),
('FAN', 'Fan', 'RPM', 200, 1200, 700, TRUE),
('CAMERA', 'Camera', 'BOOLEAN', NULL, NULL, NULL, TRUE)
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  unit = EXCLUDED.unit,
  default_min = EXCLUDED.default_min,
  default_max = EXCLUDED.default_max,
  default_target = EXCLUDED.default_target,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- Global threshold defaults by device type
INSERT INTO device_threshold_profiles (id, device_type_code, min_value, max_value, target_value, enabled, updated_by, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'LIGHT', 150, 800, 350, TRUE, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'AC', 20, 28, 24, TRUE, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'FAN', 200, 1200, 700, TRUE, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'CAMERA', NULL, NULL, NULL, TRUE, NULL, NOW(), NOW())
ON CONFLICT (device_type_code) DO UPDATE SET
  min_value = EXCLUDED.min_value,
  max_value = EXCLUDED.max_value,
  target_value = EXCLUDED.target_value,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();

-- Group-level polling interval defaults (fallback chain starts here)
INSERT INTO refresh_interval_settings (id, scope_type, scope_id, mode, interval_ms, updated_by, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'GROUP', 'A', 'NORMAL', 30000, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'GROUP', 'A', 'TESTING', 2000, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'GROUP', 'B', 'NORMAL', 30000, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'GROUP', 'B', 'TESTING', 2000, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'GROUP', 'C', 'NORMAL', 30000, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'GROUP', 'C', 'TESTING', 2000, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'GROUP', 'LABS', 'NORMAL', 30000, NULL, NOW(), NOW()),
  (gen_random_uuid(), 'GROUP', 'LABS', 'TESTING', 2000, NULL, NOW(), NOW())
ON CONFLICT (scope_type, scope_id, mode) DO UPDATE SET
  interval_ms = EXCLUDED.interval_ms,
  updated_at = NOW();

-- Board-level attendance KPI default thresholds
INSERT INTO attendance_board_thresholds (
  id,
  scope_type,
  scope_id,
  min_attendance_rate,
  max_late_rate,
  max_absent_rate,
  note,
  updated_by,
  created_at,
  updated_at
)
VALUES
  (gen_random_uuid(), 'SCHOOL', 'GLOBAL', 85.00, 10.00, 15.00, 'Default school-wide attendance threshold', NULL, NOW(), NOW()),
  (gen_random_uuid(), 'BUILDING', 'A', 86.00, 9.00, 14.00, 'Building A baseline threshold', NULL, NOW(), NOW()),
  (gen_random_uuid(), 'BUILDING', 'B', 84.00, 11.00, 16.00, 'Building B baseline threshold', NULL, NOW(), NOW()),
  (gen_random_uuid(), 'BUILDING', 'C', 84.00, 11.00, 16.00, 'Building C baseline threshold', NULL, NOW(), NOW())
ON CONFLICT (scope_type, scope_id) DO UPDATE SET
  min_attendance_rate = EXCLUDED.min_attendance_rate,
  max_late_rate = EXCLUDED.max_late_rate,
  max_absent_rate = EXCLUDED.max_absent_rate,
  note = EXCLUDED.note,
  updated_at = NOW();

-- ============================================================================
-- PERMISSION CATALOG & ROLE-PERMISSION MATRIX (RBAC)
-- ============================================================================

-- Seed permissions organized by domain
INSERT INTO permissions (key, display_name, description, category, is_active) VALUES
('camera:view_live', 'View Live Camera', 'View real-time classroom camera feed', 'camera', TRUE),
('camera:view_recorded', 'View Recorded Camera', 'Access recorded session video archives', 'camera', TRUE),
('camera:download', 'Download Camera Feed', 'Export camera recordings', 'camera', TRUE),
('ai_alerts:view', 'View AI Alerts', 'View behavior detection alerts', 'ai_alerts', TRUE),
('ai_alerts:acknowledge', 'Acknowledge Alerts', 'Mark alerts as reviewed', 'ai_alerts', TRUE),
('ai_alerts:create_rules', 'Create Alert Rules', 'Define custom AI detection rules', 'ai_alerts', TRUE),
('env_control:light', 'Control Lights', 'Adjust classroom lighting', 'env_control', TRUE),
('env_control:ac', 'Control AC', 'Adjust classroom temperature', 'env_control', TRUE),
('env_control:fan', 'Control Fan', 'Adjust classroom ventilation', 'env_control', TRUE),
('env_control:thresholds', 'Manage Thresholds', 'Update device control thresholds', 'env_control', TRUE),
('dashboard:view_classroom', 'View Classroom Dashboard', 'View single classroom data', 'dashboard_scope', TRUE),
('dashboard:view_block', 'View Block Dashboard', 'View entire floor/block data', 'dashboard_scope', TRUE),
('dashboard:view_university', 'View University Dashboard', 'View all building data', 'dashboard_scope', TRUE),
('dashboard:view_minimal', 'View Minimal Dashboard', 'Display-only access', 'dashboard_scope', TRUE),
('mode:switch_learning', 'Switch to Learning Mode', 'Start normal classroom sessions', 'mode_controls', TRUE),
('mode:switch_testing', 'Switch to Testing Mode', 'Start exam/test sessions', 'mode_controls', TRUE),
('incident:view', 'View Incidents', 'Access detected behavior incidents', 'incident_review', TRUE),
('incident:audit', 'Audit Incidents', 'Review incident logs and evidence', 'incident_review', TRUE),
('incident:resolve', 'Resolve Incidents', 'Close or update incident status', 'incident_review', TRUE),
('incident:view_self', 'View Own Incidents', 'View own risk incidents only', 'incident_review', TRUE),
('report:performance', 'Performance Reports', 'Access student performance analytics', 'reporting', TRUE),
('report:attendance', 'Attendance Reports', 'View attendance and occupancy data', 'reporting', TRUE),
('report:incidents', 'Incident Reports', 'Generate behavior incident reports', 'reporting', TRUE),
('report:behavior_self', 'View Own Behavior', 'View own classroom behavior metrics', 'reporting', TRUE),
('report:attendance_self', 'View Own Attendance', 'View own attendance timeline and punctuality', 'reporting', TRUE),
('dashboard:view_student_self', 'View Student Dashboard', 'Access student personal weekly dashboard', 'dashboard_scope', TRUE),
('deploy:device_management', 'Manage Devices', 'Add/update/delete classroom devices', 'deployment', TRUE),
('deploy:user_management', 'Manage Users', 'Create/update user roles and assignments', 'deployment', TRUE),
('deploy:system_settings', 'System Configuration', 'Update system-wide settings', 'deployment', TRUE)
ON CONFLICT (key) DO NOTHING;

-- LECTURER role permissions (REQ-01, REQ-02, REQ-05)
INSERT INTO role_permissions (role, permission_id)
SELECT 'LECTURER', id FROM permissions WHERE key IN (
  'camera:view_live',
  'camera:view_recorded',
  'dashboard:view_classroom',
  'mode:switch_learning',
  'mode:switch_testing',
  'incident:view',
  'ai_alerts:view',
  'env_control:light',
  'env_control:ac',
  'env_control:fan'
) ON CONFLICT DO NOTHING;

-- EXAM_PROCTOR role permissions (REQ-03, REQ-04)
INSERT INTO role_permissions (role, permission_id)
SELECT 'EXAM_PROCTOR', id FROM permissions WHERE key IN (
  'camera:view_live',
  'camera:view_recorded',
  'mode:switch_testing',
  'dashboard:view_classroom',
  'ai_alerts:view',
  'ai_alerts:acknowledge',
  'incident:view',
  'env_control:light'
) ON CONFLICT DO NOTHING;

-- ACADEMIC_BOARD role permissions (REQ-06, REQ-07, REQ-08, REQ-11)
INSERT INTO role_permissions (role, permission_id)
SELECT 'ACADEMIC_BOARD', id FROM permissions WHERE key IN (
  'camera:view_live',
  'camera:view_recorded',
  'dashboard:view_block',
  'dashboard:view_university',
  'ai_alerts:view',
  'incident:view',
  'incident:audit',
  'report:performance',
  'report:attendance',
  'report:incidents'
) ON CONFLICT DO NOTHING;

-- SYSTEM_ADMIN role permissions (REQ-09, REQ-10)
INSERT INTO role_permissions (role, permission_id)
SELECT 'SYSTEM_ADMIN', id FROM permissions WHERE key IN (
  'camera:view_live',
  'camera:view_recorded',
  'camera:download',
  'dashboard:view_university',
  'ai_alerts:view',
  'ai_alerts:create_rules',
  'env_control:light',
  'env_control:ac',
  'env_control:fan',
  'env_control:thresholds',
  'mode:switch_testing',
  'mode:switch_learning',
  'incident:view',
  'incident:audit',
  'incident:resolve',
  'report:performance',
  'report:attendance',
  'report:incidents',
  'deploy:device_management',
  'deploy:user_management',
  'deploy:system_settings'
) ON CONFLICT DO NOTHING;

-- FACILITY_STAFF role permissions
INSERT INTO role_permissions (role, permission_id)
SELECT 'FACILITY_STAFF', id FROM permissions WHERE key IN (
  'dashboard:view_block',
  'env_control:light',
  'env_control:ac',
  'env_control:fan',
  'env_control:thresholds',
  'deploy:device_management',
  'report:attendance'
) ON CONFLICT DO NOTHING;

-- CLEANING_STAFF role permissions
INSERT INTO role_permissions (role, permission_id)
SELECT 'CLEANING_STAFF', id FROM permissions WHERE key IN (
  'dashboard:view_minimal',
  'env_control:light'
) ON CONFLICT DO NOTHING;

-- STUDENT role permissions (self-service dashboard only)
INSERT INTO role_permissions (role, permission_id)
SELECT 'STUDENT', id FROM permissions WHERE key IN (
  'dashboard:view_student_self',
  'report:attendance_self',
  'report:behavior_self',
  'incident:view_self'
) ON CONFLICT DO NOTHING;

-- Role-Mode Access Matrix
INSERT INTO role_mode_access (role, can_switch_to_testing, can_switch_to_learning, can_view_reports) VALUES
('LECTURER', TRUE, TRUE, TRUE),
('EXAM_PROCTOR', TRUE, FALSE, FALSE),
('ACADEMIC_BOARD', FALSE, FALSE, TRUE),
('SYSTEM_ADMIN', TRUE, TRUE, TRUE),
('FACILITY_STAFF', FALSE, TRUE, FALSE),
('CLEANING_STAFF', FALSE, FALSE, FALSE),
('STUDENT', FALSE, FALSE, TRUE)
ON CONFLICT (role) DO UPDATE SET
  can_switch_to_testing = EXCLUDED.can_switch_to_testing,
  can_switch_to_learning = EXCLUDED.can_switch_to_learning,
  can_view_reports = EXCLUDED.can_view_reports,
  updated_at = NOW();

-- Insert default behavior classes
INSERT INTO behavior_classes (class_name, actor_type, description, is_active) VALUES
-- Student behaviors (Learning Mode)
('hand-raising', 'STUDENT', 'Student raises hand', TRUE),
('reading', 'STUDENT', 'Student is reading', TRUE),
('writing', 'STUDENT', 'Student is writing', TRUE),
('bow-head', 'STUDENT', 'Student is bowing head', TRUE),
('talking', 'STUDENT', 'Student is talking', TRUE),
('standing', 'STUDENT', 'Student is standing', TRUE),
('answering', 'STUDENT', 'Student is answering question', TRUE),
('on-stage-interaction', 'STUDENT', 'Student on stage interacting', TRUE),
('discussing', 'STUDENT', 'Student is discussing', TRUE),
('yawning', 'STUDENT', 'Student is yawning', TRUE),
('clapping', 'STUDENT', 'Student is clapping', TRUE),
('leaning-on-desk', 'STUDENT', 'Student leaning on desk', TRUE),
('using-phone', 'STUDENT', 'Student using phone', TRUE),
('using-computer', 'STUDENT', 'Student using computer', TRUE),
-- Teacher behaviors (Learning Mode)
('guiding', 'TEACHER', 'Teacher guiding students', TRUE),
('blackboard-writing', 'TEACHER', 'Teacher writing on blackboard', TRUE),
('on-stage-interaction', 'TEACHER', 'Teacher on stage interacting', TRUE),
('blackboard', 'TEACHER', 'Teacher at blackboard', TRUE)
ON CONFLICT (class_name) DO NOTHING;

-- Insert risk behaviors (Testing Mode)
INSERT INTO risk_behaviors (behavior_name, description, is_active) VALUES
('head-turning', 'Suspicious head turning', TRUE),
('talking', 'Talking to others during test', TRUE),
('discussing', 'Discussing with others', TRUE),
('phone-usage', 'Using phone during test', TRUE),
('computer-usage', 'Using computer inappropriately', TRUE)
ON CONFLICT (behavior_name) DO NOTHING;

-- Insert default performance weights (Global)
INSERT INTO performance_weights (subject_id, behavior_name, actor_type, weight, is_active) VALUES
(NULL, 'hand-raising', 'STUDENT', 10.0, TRUE),
(NULL, 'reading', 'STUDENT', 8.0, TRUE),
(NULL, 'writing', 'STUDENT', 9.0, TRUE),
(NULL, 'answering', 'STUDENT', 15.0, TRUE),
(NULL, 'discussing', 'STUDENT', 12.0, TRUE),
(NULL, 'yawning', 'STUDENT', -5.0, TRUE),
(NULL, 'bow-head', 'STUDENT', -3.0, TRUE),
(NULL, 'using-phone', 'STUDENT', -20.0, TRUE),
(NULL, 'using-computer', 'STUDENT', -15.0, TRUE),
(NULL, 'guiding', 'TEACHER', 10.0, TRUE),
(NULL, 'blackboard-writing', 'TEACHER', 12.0, TRUE),
(NULL, 'on-stage-interaction', 'TEACHER', 8.0, TRUE)
ON CONFLICT DO NOTHING;

-- Insert default risk weights (Testing Mode)
INSERT INTO risk_weights (risk_behavior, alpha_head_turn, beta_talk, gamma_device_use, alert_threshold, is_active) VALUES
('default', 0.3, 0.5, 0.8, 50.0, TRUE)
ON CONFLICT (risk_behavior) DO NOTHING;

-- ============================================================================
-- SUMMARY
-- ============================================================================
-- 11 core tables: buildings, floors, rooms, subjects, teachers, students, enrollments
-- 5 session tables: timetable, class_sessions, behavior_classes, behavior_logs, performance_aggregates
-- 3 risk tables: risk_behaviors, risk_incidents, device_states
-- 2 IoT tables: iot_rules, device_states (shared with risk)
-- 2 config tables: performance_weights, risk_weights
-- 1 auth table: users
-- 1 occupancy table: room_occupancy
-- 1 audit table: audit_logs
-- Total: 30+ tables with full indexing and seed data
