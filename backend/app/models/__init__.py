from sqlalchemy import Column, String, Integer, Float, DateTime, Boolean, UUID, ForeignKey, Enum, JSON, LargeBinary, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import uuid
from datetime import datetime
from app.database import Base

# =============================================================================
# 1. UNIVERSITY CORE MODELS
# =============================================================================

class Building(Base):
    __tablename__ = "buildings"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, unique=True, nullable=False, index=True)
    location = Column(String)
    code = Column(String(50))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    floors = relationship("Floor", back_populates="building", cascade="all, delete-orphan")

class Floor(Base):
    __tablename__ = "floors"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    building_id = Column(UUID(as_uuid=True), ForeignKey("buildings.id"), nullable=False)
    floor_number = Column(Integer, nullable=False)
    name = Column(String)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    building = relationship("Building", back_populates="floors")
    rooms = relationship("Room", back_populates="floor", cascade="all, delete-orphan")

class Room(Base):
    __tablename__ = "rooms"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    floor_id = Column(UUID(as_uuid=True), ForeignKey("floors.id"), nullable=False)
    room_code = Column(String(50), unique=True, nullable=False, index=True)
    name = Column(String)
    capacity = Column(Integer, default=30)
    devices = Column(JSON, default=lambda: {"device_list": []})  # JSONB for flexible device schema
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    floor = relationship("Floor", back_populates="rooms")
    sessions = relationship("ClassSession", back_populates="room")
    device_states = relationship("DeviceState", back_populates="room")
    room_devices = relationship("RoomDevice", back_populates="room", cascade="all, delete-orphan")
    device_thresholds = relationship("RoomDeviceThreshold", back_populates="room", cascade="all, delete-orphan")
    occupancy = relationship("RoomOccupancy", back_populates="room", uselist=False, cascade="all, delete-orphan")
    sensor_readings = relationship("RoomSensorReading", back_populates="room", cascade="all, delete-orphan")

class Subject(Base):
    __tablename__ = "subjects"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, unique=True, nullable=False)
    code = Column(String(50), unique=True)
    description = Column(String)
    created_at = Column(DateTime, server_default=func.now())
    
    enrollments = relationship("Enrollment", back_populates="subject", cascade="all, delete-orphan")
    sessions = relationship("ClassSession", back_populates="subject")

class Teacher(Base):
    __tablename__ = "teachers"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    email = Column(String, unique=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), unique=True, index=True)
    phone = Column(String)
    department = Column(String)
    created_at = Column(DateTime, server_default=func.now())
    
    user = relationship("User", back_populates="teacher_profile")
    sessions = relationship("ClassSession", back_populates="teacher")

class Student(Base):
    __tablename__ = "students"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    student_id = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String, unique=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), unique=True, index=True)
    class_name = Column("class", String(50))
    created_at = Column(DateTime, server_default=func.now())
    
    user = relationship("User", back_populates="student_profile")
    enrollments = relationship("Enrollment", back_populates="student", cascade="all, delete-orphan")
    incidents = relationship("RiskIncident", back_populates="student")
    attendance_face_templates = relationship("AttendanceFaceTemplate", back_populates="student", cascade="all, delete-orphan")
    attendance_events = relationship("AttendanceEvent", back_populates="student", cascade="all, delete-orphan")

class Enrollment(Base):
    __tablename__ = "enrollments"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(UUID(as_uuid=True), ForeignKey("students.id"), nullable=False)
    subject_id = Column(UUID(as_uuid=True), ForeignKey("subjects.id"), nullable=False)
    enrollment_date = Column(DateTime, server_default=func.now())
    
    student = relationship("Student", back_populates="enrollments")
    subject = relationship("Subject", back_populates="enrollments")

# =============================================================================
# 2. TIMETABLE & SESSION MODELS
# =============================================================================

class Timetable(Base):
    __tablename__ = "timetable"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    subject_id = Column(UUID(as_uuid=True), ForeignKey("subjects.id"), nullable=False)
    teacher_id = Column(UUID(as_uuid=True), ForeignKey("teachers.id"), nullable=False)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False)
    day_of_week = Column(Integer, nullable=False)  # 0=Monday, 6=Sunday
    start_time = Column(String, nullable=False)  # HH:MM format
    end_time = Column(String, nullable=False)
    expected_students = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())

class ClassSession(Base):
    __tablename__ = "class_sessions"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False)
    teacher_id = Column(UUID(as_uuid=True), ForeignKey("teachers.id"))
    subject_id = Column(UUID(as_uuid=True), ForeignKey("subjects.id"))
    timetable_id = Column(UUID(as_uuid=True), ForeignKey("timetable.id"))
    mode = Column(String, default="NORMAL")  # NORMAL or TESTING
    start_time = Column(DateTime, server_default=func.now())
    end_time = Column(DateTime)
    students_present = Column(JSON, default=[])
    final_performance_score = Column(Float)
    final_risk_score = Column(Float)
    status = Column(String, default="ACTIVE")  # ACTIVE, COMPLETED, CANCELLED
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    room = relationship("Room", back_populates="sessions")
    teacher = relationship("Teacher", back_populates="sessions")
    subject = relationship("Subject", back_populates="sessions")
    behavior_logs = relationship("BehaviorLog", back_populates="session", cascade="all, delete-orphan")
    incidents = relationship("RiskIncident", back_populates="session", cascade="all, delete-orphan")
    aggregates = relationship("PerformanceAggregate", back_populates="session", cascade="all, delete-orphan")
    attendance_config = relationship("AttendanceSessionConfig", back_populates="session", uselist=False, cascade="all, delete-orphan")
    attendance_events = relationship("AttendanceEvent", back_populates="session", cascade="all, delete-orphan")


class AttendanceSessionConfig(Base):
    __tablename__ = "attendance_session_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("class_sessions.id"), unique=True, nullable=False, index=True)
    grace_minutes = Column(Integer, default=10)
    min_confidence = Column(Float, default=0.75)
    auto_checkin_enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    session = relationship("ClassSession", back_populates="attendance_config")


class AttendanceFaceTemplate(Base):
    __tablename__ = "attendance_face_templates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    student_id = Column(UUID(as_uuid=True), ForeignKey("students.id"), nullable=False, index=True)
    embedding = Column(JSON, nullable=False)  # Face embedding vector for matching
    quality_score = Column(Float, default=0.0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    student = relationship("Student", back_populates="attendance_face_templates")


class AttendanceEvent(Base):
    __tablename__ = "attendance_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("class_sessions.id"), nullable=False, index=True)
    student_id = Column(UUID(as_uuid=True), ForeignKey("students.id"), nullable=False, index=True)
    source = Column(String, default="DOOR_CAMERA")
    face_confidence = Column(Float, default=0.0)
    is_recognized = Column(Boolean, default=False)
    occurred_at = Column(DateTime, server_default=func.now(), index=True)
    event_metadata = Column("metadata", JSON, default={})
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), index=True)
    created_at = Column(DateTime, server_default=func.now())

    session = relationship("ClassSession", back_populates="attendance_events")
    student = relationship("Student", back_populates="attendance_events")

# =============================================================================
# 3. BEHAVIOR & AI MODELS
# =============================================================================

class BehaviorClass(Base):
    __tablename__ = "behavior_classes"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    class_name = Column(String, unique=True, nullable=False, index=True)
    actor_type = Column(String, nullable=False)  # STUDENT or TEACHER
    description = Column(String)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())

class BehaviorLog(Base):
    __tablename__ = "behavior_logs"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("class_sessions.id"), nullable=False, index=True)
    actor_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    actor_type = Column(String, nullable=False)  # STUDENT or TEACHER
    behavior_class = Column(String, nullable=False)
    count = Column(Integer, default=1)
    duration_seconds = Column(Integer, default=0)
    detected_at = Column(DateTime, server_default=func.now(), index=True)
    frame_snapshot = Column(LargeBinary)  # Binary frame data
    yolo_confidence = Column(Float, default=0.0)
    created_at = Column(DateTime, server_default=func.now())
    
    session = relationship("ClassSession", back_populates="behavior_logs")

class PerformanceAggregate(Base):
    __tablename__ = "performance_aggregates"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("class_sessions.id"), nullable=False)
    actor_id = Column(UUID(as_uuid=True), nullable=False)
    actor_type = Column(String, nullable=False)
    total_score = Column(Float, default=0.0)
    behavior_breakdown = Column(JSON, default={})
    calculated_at = Column(DateTime, server_default=func.now())
    
    session = relationship("ClassSession", back_populates="aggregates")

# =============================================================================
# 4. RISK & INCIDENT MODELS
# =============================================================================

class RiskBehavior(Base):
    __tablename__ = "risk_behaviors"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    behavior_name = Column(String, unique=True, nullable=False)
    description = Column(String)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())

class RiskIncident(Base):
    __tablename__ = "risk_incidents"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), ForeignKey("class_sessions.id"), nullable=False, index=True)
    student_id = Column(UUID(as_uuid=True), ForeignKey("students.id"), nullable=False, index=True)
    risk_score = Column(Float, nullable=False)
    risk_level = Column(String, nullable=False)  # CRITICAL, HIGH, MEDIUM, LOW
    triggered_behaviors = Column(JSON, nullable=False)
    frame_snapshot = Column(LargeBinary)
    flagged_at = Column(DateTime, server_default=func.now())
    reviewed = Column(Boolean, default=False)
    reviewer_id = Column(UUID(as_uuid=True), ForeignKey("teachers.id"))
    reviewer_notes = Column(String)
    reviewed_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())
    
    session = relationship("ClassSession", back_populates="incidents")
    student = relationship("Student", back_populates="incidents")

# =============================================================================
# 5. IOT & DEVICE MODELS
# =============================================================================

class IoTRule(Base):
    __tablename__ = "iot_rules"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_name = Column(String, nullable=False)
    scope_type = Column(String, nullable=False)
    building_id = Column(UUID(as_uuid=True), ForeignKey("buildings.id"), index=True)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), index=True)
    condition_type = Column(String, nullable=False)  # OCCUPANCY, TIMETABLE, ZERO_OCCUPANCY
    condition_params = Column(JSON, nullable=False)
    actions = Column(JSON, nullable=False)
    is_active = Column(Boolean, default=True)
    priority = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    last_triggered = Column(DateTime)

class DeviceState(Base):
    __tablename__ = "device_states"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False, index=True)
    device_id = Column(String, nullable=False)
    device_type = Column(String, nullable=False)  # LIGHT, FAN, AC, CAMERA
    status = Column(String, default="OFF")  # ON, OFF, ERROR
    last_toggled_by = Column(UUID(as_uuid=True), ForeignKey("teachers.id"))
    manual_override = Column(Boolean, default=False)
    override_until = Column(DateTime)
    last_updated = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    room = relationship("Room", back_populates="device_states")

class RoomDevice(Base):
    __tablename__ = "room_devices"
    __table_args__ = (UniqueConstraint("room_id", "device_id", name="uq_room_devices_room_device"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False, index=True)
    device_id = Column(String, nullable=False)
    device_type = Column(String, nullable=False)
    location_front_back = Column(String, nullable=False)
    location_left_right = Column(String, nullable=False)
    x_percent = Column(Float)
    y_percent = Column(Float)
    power_consumption_watts = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    source = Column(String, default="MANUAL")
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    room = relationship("Room", back_populates="room_devices")

class DeviceType(Base):
    __tablename__ = "device_types"

    code = Column(String, primary_key=True)
    display_name = Column(String, nullable=False)
    unit = Column(String)
    default_min = Column(Float)
    default_max = Column(Float)
    default_target = Column(Float)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

class DeviceThresholdProfile(Base):
    __tablename__ = "device_threshold_profiles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_type_code = Column(String, ForeignKey("device_types.code"), nullable=False, unique=True, index=True)
    min_value = Column(Float)
    max_value = Column(Float)
    target_value = Column(Float)
    enabled = Column(Boolean, default=True)
    updated_by = Column(UUID(as_uuid=True))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

class RoomDeviceThreshold(Base):
    __tablename__ = "room_device_thresholds"
    __table_args__ = (UniqueConstraint("room_id", "device_type_code", name="uq_room_threshold_room_type"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False, index=True)
    device_type_code = Column(String, ForeignKey("device_types.code"), nullable=False, index=True)
    min_value = Column(Float)
    max_value = Column(Float)
    target_value = Column(Float)
    enabled = Column(Boolean, default=True)
    updated_by = Column(UUID(as_uuid=True))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    room = relationship("Room", back_populates="device_thresholds")

class RefreshIntervalSetting(Base):
    __tablename__ = "refresh_interval_settings"
    __table_args__ = (UniqueConstraint("scope_type", "scope_id", "mode", name="uq_refresh_interval_scope_mode"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scope_type = Column(String(20), nullable=False)  # GROUP, BUILDING, ROOM
    scope_id = Column(String(100), nullable=False)  # Group key or UUID string
    mode = Column(String(20), nullable=False)  # NORMAL, TESTING
    interval_ms = Column(Integer, nullable=False)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), index=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

class RoomOccupancy(Base):
    __tablename__ = "room_occupancy"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), unique=True, nullable=False)
    occupancy_count = Column(Integer, default=0)
    is_occupied = Column(Boolean, default=False)
    last_detected = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    room = relationship("Room", back_populates="occupancy")


class RoomSensorReading(Base):
    __tablename__ = "room_sensor_readings"
    __table_args__ = (UniqueConstraint("room_id", "sensor_key", name="uq_room_sensor_key"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False, index=True)
    sensor_key = Column(String(50), nullable=False, index=True)
    value = Column(Float, nullable=False)
    unit = Column(String(20))
    source_topic = Column(String(255))
    captured_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    room = relationship("Room", back_populates="sensor_readings")

# =============================================================================
# 6. CONFIGURATION MODELS
# =============================================================================

class PerformanceWeight(Base):
    __tablename__ = "performance_weights"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    subject_id = Column(UUID(as_uuid=True), ForeignKey("subjects.id"))
    behavior_name = Column(String, nullable=False)
    actor_type = Column(String, nullable=False)  # STUDENT or TEACHER
    weight = Column(Float, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())

class RiskWeight(Base):
    __tablename__ = "risk_weights"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    risk_behavior = Column(String, nullable=False, unique=True)
    alpha_head_turn = Column(Float, default=0.3)
    beta_talk = Column(Float, default=0.5)
    gamma_device_use = Column(Float, default=0.8)
    alert_threshold = Column(Float, default=50.0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())

# =============================================================================
# 7. AUTH & AUDIT MODELS
# =============================================================================

class User(Base):
    __tablename__ = "users"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username = Column(String, unique=True, nullable=False, index=True)
    email = Column(String, unique=True)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="LECTURER")  # ADMIN, LECTURER, FACILITY_MANAGER
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    student_profile = relationship("Student", back_populates="user", uselist=False)
    teacher_profile = relationship("Teacher", back_populates="user", uselist=False)

class AuditLog(Base):
    __tablename__ = "audit_logs"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_type = Column(String, nullable=False)
    entity_id = Column(UUID(as_uuid=True))
    action = Column(String, nullable=False)
    performed_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    changes = Column(JSON)
    created_at = Column(DateTime, server_default=func.now(), index=True)

# =============================================================================
# 7B. RBAC POLICY MODELS
# =============================================================================

class Permission(Base):
    __tablename__ = "permissions"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key = Column(String, unique=True, nullable=False, index=True)
    display_name = Column(String)
    description = Column(String)
    category = Column(String)  # camera, ai_alerts, env_control, dashboard_scope, mode_controls, incident_review, reporting, deployment
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    role_permissions = relationship("RolePermission", back_populates="permission", cascade="all, delete-orphan")

class RolePermission(Base):
    __tablename__ = "role_permissions"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    role = Column(String, nullable=False, index=True)
    permission_id = Column(UUID(as_uuid=True), ForeignKey("permissions.id"), nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    
    permission = relationship("Permission", back_populates="role_permissions")
    __table_args__ = (UniqueConstraint('role', 'permission_id', name='uq_role_permission'),)

class UserRoomAssignment(Base):
    __tablename__ = "user_room_assignments"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False, index=True)
    can_view = Column(Boolean, default=True)
    can_control = Column(Boolean, default=False)
    assigned_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    user = relationship("User", foreign_keys=[user_id])
    room = relationship("Room")
    assigned_by_user = relationship("User", foreign_keys=[assigned_by])
    __table_args__ = (UniqueConstraint('user_id', 'room_id', name='uq_user_room'),)

class UserBlockAssignment(Base):
    __tablename__ = "user_block_assignments"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    floor_id = Column(UUID(as_uuid=True), ForeignKey("floors.id"), nullable=False, index=True)
    can_view = Column(Boolean, default=True)
    can_control = Column(Boolean, default=False)
    assigned_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    user = relationship("User", foreign_keys=[user_id])
    floor = relationship("Floor")
    assigned_by_user = relationship("User", foreign_keys=[assigned_by])
    __table_args__ = (UniqueConstraint('user_id', 'floor_id', name='uq_user_floor'),)

class RoleModeAccess(Base):
    __tablename__ = "role_mode_access"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    role = Column(String, unique=True, nullable=False, index=True)
    can_switch_to_testing = Column(Boolean, default=False)
    can_switch_to_learning = Column(Boolean, default=False)
    can_view_reports = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class AttendanceBoardThreshold(Base):
    __tablename__ = "attendance_board_thresholds"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scope_type = Column(String, nullable=False, index=True)
    scope_id = Column(String, nullable=False, default="GLOBAL")
    min_attendance_rate = Column(Float, nullable=False, default=85.0)
    max_late_rate = Column(Float, nullable=False, default=10.0)
    max_absent_rate = Column(Float, nullable=False, default=15.0)
    note = Column(String)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    updated_by_user = relationship("User", foreign_keys=[updated_by])

    __table_args__ = (UniqueConstraint("scope_type", "scope_id", name="uq_attendance_board_threshold_scope"),)


class AttendanceDashboardExport(Base):
    __tablename__ = "attendance_dashboard_exports"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    requested_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), index=True)
    export_format = Column(String, nullable=False)
    filter_payload = Column(JSON, nullable=False, default={})
    row_count = Column(Integer, nullable=False, default=0)
    generated_at = Column(DateTime, nullable=False, server_default=func.now())
    status = Column(String, nullable=False, default="SUCCESS")
    failure_reason = Column(String)

    requested_by_user = relationship("User", foreign_keys=[requested_by])
