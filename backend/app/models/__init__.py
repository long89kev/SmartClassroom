from sqlalchemy import Column, String, Integer, Float, DateTime, Boolean, UUID, ForeignKey, Enum, JSON, LargeBinary
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
    devices = Column(JSON, default={"device_list": []})  # JSONB for flexible device schema
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    floor = relationship("Floor", back_populates="rooms")
    sessions = relationship("ClassSession", back_populates="room")
    device_states = relationship("DeviceState", back_populates="room")
    occupancy = relationship("RoomOccupancy", back_populates="room", uselist=False, cascade="all, delete-orphan")

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
    phone = Column(String)
    department = Column(String)
    created_at = Column(DateTime, server_default=func.now())
    
    sessions = relationship("ClassSession", back_populates="teacher")

class Student(Base):
    __tablename__ = "students"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    student_id = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String, unique=True)
    class_name = Column("class", String(50))
    created_at = Column(DateTime, server_default=func.now())
    
    enrollments = relationship("Enrollment", back_populates="student", cascade="all, delete-orphan")
    incidents = relationship("RiskIncident", back_populates="student")

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
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False, index=True)
    condition_type = Column(String, nullable=False)  # OCCUPANCY, TIMETABLE, ZERO_OCCUPANCY
    condition_params = Column(JSON, nullable=False)
    actions = Column(JSON, nullable=False)
    is_active = Column(Boolean, default=True)
    priority = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    last_triggered = Column(DateTime)

class DeviceState(Base):
    __tablename__ = "device_states"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False, index=True)
    device_id = Column(String, nullable=False)
    device_type = Column(String, nullable=False)  # LIGHT, FAN, AC, PROJECTOR
    status = Column(String, default="OFF")  # ON, OFF, ERROR
    last_toggled_by = Column(UUID(as_uuid=True), ForeignKey("teachers.id"))
    manual_override = Column(Boolean, default=False)
    override_until = Column(DateTime)
    last_updated = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    room = relationship("Room", back_populates="device_states")

class RoomOccupancy(Base):
    __tablename__ = "room_occupancy"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), unique=True, nullable=False)
    occupancy_count = Column(Integer, default=0)
    is_occupied = Column(Boolean, default=False)
    last_detected = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    room = relationship("Room", back_populates="occupancy")

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

class AuditLog(Base):
    __tablename__ = "audit_logs"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_type = Column(String, nullable=False)
    entity_id = Column(UUID(as_uuid=True))
    action = Column(String, nullable=False)
    performed_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    changes = Column(JSON)
    created_at = Column(DateTime, server_default=func.now(), index=True)
