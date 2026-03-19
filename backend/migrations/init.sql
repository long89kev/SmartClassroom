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

-- University Timetable (Fixed schedule)
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
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  condition_type VARCHAR(50) NOT NULL, -- OCCUPANCY, TIMETABLE, ZERO_OCCUPANCY, TIME_BASED
  condition_params JSONB NOT NULL, -- {"min_occupancy": 1, "duration_minutes": 2}
  actions JSONB NOT NULL, -- [{"device_type": "AC", "action": "ON"}, ...]
  is_active BOOLEAN DEFAULT TRUE,
  priority INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_triggered TIMESTAMP
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
-- 7. USER AUTHENTICATION & AUTHORIZATION
-- ============================================================================

-- Users (Admin, Lecturer, Facility Manager)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'LECTURER', -- ADMIN, LECTURER, FACILITY_MANAGER
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 8. OCCUPANCY & SESSION TRACKING
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
CREATE INDEX idx_risk_incidents_session_id ON risk_incidents(session_id);
CREATE INDEX idx_risk_incidents_student_id ON risk_incidents(student_id);
CREATE INDEX idx_device_states_room_id ON device_states(room_id);
CREATE INDEX idx_iot_rules_room_id ON iot_rules(room_id);
CREATE INDEX idx_performance_weights_subject_id ON performance_weights(subject_id);
CREATE INDEX idx_room_occupancy_room_id ON room_occupancy(room_id);
CREATE INDEX idx_audit_logs_entity_id ON audit_logs(entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

-- ============================================================================
-- 11. SEED DATA (Initial setup)
-- ============================================================================

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
