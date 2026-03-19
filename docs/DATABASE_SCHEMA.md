# PostgreSQL Database Schema

## Overview

The complete PostgreSQL schema for the Smart AI-IoT Classroom System includes 30+ tables organized into 9 logical groups.

## Table Groups

### 1. University Core (7 tables)

#### Buildings
```sql
CREATE TABLE buildings (
  id UUID PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  location VARCHAR(255),
  code VARCHAR(50)
)
```

#### Floors
```sql
CREATE TABLE floors (
  id UUID PRIMARY KEY,
  building_id UUID NOT NULL REFERENCES buildings(id),
  floor_number INT NOT NULL,
  name VARCHAR(255),
  UNIQUE(building_id, floor_number)
)
```

#### Rooms
```sql
CREATE TABLE rooms (
  id UUID PRIMARY KEY,
  floor_id UUID NOT NULL REFERENCES floors(id),
  room_code VARCHAR(50) UNIQUE NOT NULL, -- e.g., B1-103
  name VARCHAR(255),
  capacity INT DEFAULT 30,
  devices JSONB -- Flexible device layout
)
```

#### Subjects
```sql
CREATE TABLE subjects (
  id UUID PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  code VARCHAR(50) UNIQUE,
  description TEXT
)
```

#### Teachers
```sql
CREATE TABLE teachers (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(20),
  department VARCHAR(255)
)
```

#### Students
```sql
CREATE TABLE students (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  student_id VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  class VARCHAR(50)
)
```

#### Enrollments
```sql
CREATE TABLE enrollments (
  id UUID PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES students(id),
  subject_id UUID NOT NULL REFERENCES subjects(id),
  UNIQUE(student_id, subject_id)
)
```

### 2. Sessions & Timetable (5 tables)

#### Timetable
```sql
CREATE TABLE timetable (
  id UUID PRIMARY KEY,
  subject_id UUID NOT NULL REFERENCES subjects(id),
  teacher_id UUID NOT NULL REFERENCES teachers(id),
  room_id UUID NOT NULL REFERENCES rooms(id),
  day_of_week INT, -- 0=Monday, 6=Sunday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  expected_students INT DEFAULT 0
)
```

#### ClassSession
```sql
CREATE TABLE class_sessions (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  teacher_id UUID REFERENCES teachers(id),
  subject_id UUID REFERENCES subjects(id),
  timetable_id UUID REFERENCES timetable(id),
  mode VARCHAR(20) DEFAULT 'NORMAL', -- NORMAL or TESTING
  start_time TIMESTAMP DEFAULT NOW(),
  end_time TIMESTAMP,
  students_present JSONB, -- [student_id_1, student_id_2, ...]
  final_performance_score FLOAT,
  final_risk_score FLOAT,
  status VARCHAR(20) DEFAULT 'ACTIVE' -- ACTIVE, COMPLETED, CANCELLED
)
```

#### BehaviorClass
```sql
CREATE TABLE behavior_classes (
  id UUID PRIMARY KEY,
  class_name VARCHAR(100) UNIQUE NOT NULL,
  actor_type VARCHAR(20) NOT NULL, -- STUDENT or TEACHER
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE
)
```

**Seeded Behavior Classes:**
- **Student**: hand-raising, reading, writing, bow-head, talking, standing, answering, on-stage-interaction, discussing, yawning, clapping, leaning-on-desk, using-phone, using-computer
- **Teacher**: guiding, blackboard-writing, on-stage-interaction, blackboard

#### BehaviorLog
```sql
CREATE TABLE behavior_logs (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES class_sessions(id),
  actor_id UUID NOT NULL, -- Student/Teacher ID
  actor_type VARCHAR(20) NOT NULL,
  behavior_class VARCHAR(100) NOT NULL,
  count INT DEFAULT 1, -- Frequency
  duration_seconds INT DEFAULT 0,
  detected_at TIMESTAMP DEFAULT NOW(),
  frame_snapshot BYTEA, -- Binary frame data
  yolo_confidence FLOAT DEFAULT 0.0
)
```

#### PerformanceAggregate
```sql
CREATE TABLE performance_aggregates (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES class_sessions(id),
  actor_id UUID NOT NULL,
  actor_type VARCHAR(20) NOT NULL,
  total_score FLOAT DEFAULT 0.0,
  behavior_breakdown JSONB, -- {behavior: score, ...}
  UNIQUE(session_id, actor_id)
)
```

### 3. Risk Detection & Incidents (3 tables)

#### RiskBehavior
```sql
CREATE TABLE risk_behaviors (
  id UUID PRIMARY KEY,
  behavior_name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE
)
```

**Seeded Risk Behaviors:**
- head-turning, talking, discussing, phone-usage, computer-usage

#### RiskIncident
```sql
CREATE TABLE risk_incidents (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES class_sessions(id),
  student_id UUID NOT NULL REFERENCES students(id),
  risk_score FLOAT NOT NULL,
  risk_level VARCHAR(20) NOT NULL, -- CRITICAL, HIGH, MEDIUM, LOW
  triggered_behaviors JSONB NOT NULL, -- {behavior: count, ...}
  frame_snapshot BYTEA, -- Suspicious moment capture
  flagged_at TIMESTAMP DEFAULT NOW(),
  reviewed BOOLEAN DEFAULT FALSE,
  reviewer_id UUID REFERENCES teachers(id),
  reviewer_notes VARCHAR(500),
  reviewed_at TIMESTAMP
)
```

### 4. IoT & Device Management (2 tables)

#### IoTRule
```sql
CREATE TABLE iot_rules (
  id UUID PRIMARY KEY,
  rule_name VARCHAR(255) NOT NULL,
  room_id UUID NOT NULL REFERENCES rooms(id),
  condition_type VARCHAR(50) NOT NULL, -- OCCUPANCY, TIMETABLE, ZERO_OCCUPANCY
  condition_params JSONB NOT NULL, -- {min_occupancy: 1, duration_minutes: 2}
  actions JSONB NOT NULL, -- [{device_type: LIGHT, action: ON}, ...]
  is_active BOOLEAN DEFAULT TRUE,
  priority INT DEFAULT 0,
  last_triggered TIMESTAMP
)
```

**Example Rules:**
1. **Occupancy**: Turn ON lights when occupancy > 0 for 2+ minutes
2. **Timetable**: Turn ON lights 5 minutes before scheduled class
3. **Zero Occupancy**: Turn OFF all devices after 30 minutes idle

#### DeviceState
```sql
CREATE TABLE device_states (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  device_id VARCHAR(255) NOT NULL,
  device_type VARCHAR(50) NOT NULL, -- LIGHT, FAN, AC, PROJECTOR
  status VARCHAR(20) DEFAULT 'OFF', -- ON, OFF, ERROR
  last_toggled_by UUID REFERENCES teachers(id),
  manual_override BOOLEAN DEFAULT FALSE,
  override_until TIMESTAMP,
  last_updated TIMESTAMP DEFAULT NOW(),
  UNIQUE(room_id, device_id)
)
```

### 5. Occupancy Tracking (1 table)

#### RoomOccupancy
```sql
CREATE TABLE room_occupancy (
  id UUID PRIMARY KEY,
  room_id UUID UNIQUE NOT NULL REFERENCES rooms(id),
  occupancy_count INT DEFAULT 0,
  is_occupied BOOLEAN DEFAULT FALSE,
  last_detected TIMESTAMP DEFAULT NOW()
)
```

### 6. Configuration (2 tables)

#### PerformanceWeight
```sql
CREATE TABLE performance_weights (
  id UUID PRIMARY KEY,
  subject_id UUID REFERENCES subjects(id), -- NULL for global defaults
  behavior_name VARCHAR(100) NOT NULL,
  actor_type VARCHAR(20) NOT NULL,
  weight FLOAT NOT NULL, -- Positive or negative
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE(subject_id, behavior_name, actor_type)
)
```

**Default Global Weights (subject_id = NULL):**
- hand-raising (STUDENT): +10
- reading (STUDENT): +8
- writing (STUDENT): +9
- answering (STUDENT): +15
- discussing (STUDENT): +12
- yawning (STUDENT): -5
- bow-head (STUDENT): -3
- using-phone (STUDENT): -20
- using-computer (STUDENT): -15
- guiding (TEACHER): +10
- blackboard-writing (TEACHER): +12
- on-stage-interaction (TEACHER): +8

Can be overridden per subject.

#### RiskWeight
```sql
CREATE TABLE risk_weights (
  id UUID PRIMARY KEY,
  risk_behavior VARCHAR(100) UNIQUE NOT NULL,
  alpha_head_turn FLOAT DEFAULT 0.3,
  beta_talk FLOAT DEFAULT 0.5,
  gamma_device_use FLOAT DEFAULT 0.8,
  alert_threshold FLOAT DEFAULT 50.0,
  is_active BOOLEAN DEFAULT TRUE
)
```

**Risk Scoring Formula:**
```
Risk = α * (head_turn_count) + β * (talk_count) + γ * (device_duration_seconds)

If Risk ≥ τ (threshold):
  - Risk_Level = CRITICAL if Risk ≥ 75
  - Risk_Level = HIGH if Risk ≥ 50
  - Risk_Level = MEDIUM if Risk ≥ 25
  - Risk_Level = LOW if Risk ≥ 0
```

### 7. Authentication (1 table)

#### User
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'LECTURER', -- ADMIN, LECTURER, FACILITY_MANAGER
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
)
```

### 8. Audit & Logging (1 table)

#### AuditLog
```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  entity_type VARCHAR(100) NOT NULL, -- e.g., device_toggle, rule_triggered
  entity_id UUID,
  action VARCHAR(50) NOT NULL, -- CREATE, UPDATE, DELETE, TOGGLE
  performed_by UUID REFERENCES users(id),
  changes JSONB, -- {old_value, new_value}
  created_at TIMESTAMP DEFAULT NOW()
)
```

## Key Design Decisions

### 1. JSONB for Flexible Device Schemas
The `rooms.devices` column stores device inventory as JSONB:
```json
{
  "device_list": [
    {
      "device_id": "light_001",
      "device_type": "LIGHT",
      "location": "ceiling_front",
      "status": "ON",
      "mqtt_topic": "...",
      "power_consumption_watts": 50
    }
  ]
}
```

This allows facilities teams to add/remove devices without schema migration.

### 2. Separate Performance Tracking for Students & Teachers
`PerformanceAggregate` and `BehaviorLog` track both with `actor_type` field, enabling:
- Per-student performance scores
- Per-teacher performance feedback
- Mixed behavior analysis per session

### 3. Snapshot Capture (BYTEA)
`RiskIncident.frame_snapshot` stores binary frame data directly in DB for MVP simplicity. For production, could offload to object storage (S3, GCS).

### 4. Manual Overrides with Time Limits
`DeviceState.manual_override` + `override_until` allows lecturers to temporarily override auto-rules.

### 5. Audit Trail
`AuditLog` tracks all critical actions (device toggles, rule triggers) for compliance and debugging.

## Indexes

Created on:
- `buildings(name)`, `students(student_id)`, `enrollments(student_id, subject_id)`
- `behavior_logs(session_id, actor_id, detected_at)`
- `class_sessions(room_id, teacher_id, start_time)`
- `risk_incidents(session_id, student_id)`
- `device_states(room_id)`
- `iot_rules(room_id)`
- `audit_logs(entity_id, created_at)`

## Relationships Diagram

```
Buildings
  ├─ Floors
       ├─ Rooms
            ├─ ClassSession
            │    ├─ BehaviorLog
            │    ├─ PerformanceAggregate
            │    └─ RiskIncident
            ├─ DeviceState
            └─ RoomOccupancy
       ├─ Timetable
            ├─ Subject
            ├─ Teacher
            └─ Room

Subject
  ├─ Enrollments
  │    └─ Student
  └─ PerformanceWeight

User
  └─ (associated with manual device toggles, incident reviews, audit logs)
```

## Migration & Initialization

Run `backend/migrations/init.sql`:
```bash
# Via docker-compose
docker-compose exec postgres psql -U doai_user -d doai_classroom -f /docker-entrypoint-initdb.d/init.sql

# Or manually
psql postgresql://doai_user:doai_password@localhost:5432/doai_classroom -f backend/migrations/init.sql
```

This will:
1. Create all tables
2. Create indexes
3. Seed default behavior classes, risk behaviors, performance weights, risk weights
