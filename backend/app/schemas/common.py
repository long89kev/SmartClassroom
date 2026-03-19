from typing import List, Optional, Literal
from pydantic import BaseModel, Field
from datetime import datetime
from uuid import UUID

# =============================================================================
# BUILDING & HIERARCHY SCHEMAS
# =============================================================================

class BuildingBase(BaseModel):
    name: str
    location: Optional[str] = None
    code: Optional[str] = None

class BuildingCreate(BuildingBase):
    pass

class BuildingResponse(BuildingBase):
    id: UUID
    created_at: datetime
    
    class Config:
        from_attributes = True

class FloorBase(BaseModel):
    floor_number: int
    name: Optional[str] = None

class FloorCreate(FloorBase):
    pass

class FloorResponse(FloorBase):
    id: UUID
    building_id: UUID
    created_at: datetime
    
    class Config:
        from_attributes = True

class RoomDeviceSchema(BaseModel):
    device_id: str
    device_type: str
    location: str
    status: str = "OFF"
    power_consumption_watts: Optional[int] = None

class RoomBase(BaseModel):
    room_code: str
    name: Optional[str] = None
    capacity: int = 30

class RoomCreate(RoomBase):
    pass

class RoomResponse(RoomBase):
    id: UUID
    floor_id: UUID
    devices: dict
    created_at: datetime
    
    class Config:
        from_attributes = True

class RoomDetailResponse(RoomResponse):
    device_list: List[RoomDeviceSchema] = Field(default_factory=list)

# =============================================================================
# SESSION SCHEMAS
# =============================================================================

class SessionCreate(BaseModel):
    room_id: UUID
    teacher_id: UUID
    subject_id: UUID
    students_present: List[UUID] = Field(default_factory=list)

class SessionModeChange(BaseModel):
    mode: str  # NORMAL or TESTING

class BehaviorIngest(BaseModel):
    actor_id: UUID
    actor_type: str  # STUDENT or TEACHER
    behavior_class: str
    count: int = 1
    duration_seconds: int = 0
    frame_snapshot: Optional[bytes] = None
    yolo_confidence: float = 0.0

class LearningModeIngest(BaseModel):
    """Learning mode accepts image for behavior detection + grading"""
    image_base64: str  # Base64 encoded image or data URI
    student_id: Optional[UUID] = None
    confidence_threshold: float = 0.5

class TestingModeIngest(BaseModel):
    """Testing mode accepts image for cheat detection + risk scoring"""
    image_base64: str  # Base64 encoded image with student faces
    students_present: List[UUID] = Field(default_factory=list)
    confidence_threshold: float = 0.5

class BehaviorDetectionResponse(BaseModel):
    """Response from behavior detection (learning or testing)"""
    session_id: UUID
    mode: str  # LEARNING or TESTING
    detections: List[dict]  # [{behavior_class, confidence, student_id}, ...]
    annotated_image_base64: str  # Image with bounding boxes
    detection_count: int

class LearningModeResponse(BehaviorDetectionResponse):
    """Learning mode specific response with performance score"""
    students_analyzed: List[dict]  # [{student_id, performances: {...}}, ...]

class TestingModeResponse(BehaviorDetectionResponse):
    """Testing mode specific response with risk scores and incidents"""
    risk_analysis: dict  # {student_id: {risk_score, risk_level, should_flag}, ...}
    incidents_created: List[UUID] = Field(default_factory=list)

class SessionAnalyticsResponse(BaseModel):
    session_id: UUID
    mode: str
    status: str
    start_time: datetime
    elapsed_minutes: int
    student_performance: dict
    teacher_performance: dict
    risk_alerts_count: Optional[int] = 0

class SessionResponse(BaseModel):
    id: UUID
    room_id: UUID
    teacher_id: UUID
    subject_id: UUID
    mode: str
    status: str
    start_time: datetime
    end_time: Optional[datetime]
    final_performance_score: Optional[float]
    final_risk_score: Optional[float]
    
    class Config:
        from_attributes = True

# =============================================================================
# INCIDENT & RISK SCHEMAS
# =============================================================================

class IncidentCreate(BaseModel):
    session_id: UUID
    student_id: UUID
    risk_score: float
    triggered_behaviors: dict

class IncidentReview(BaseModel):
    reviewer_notes: str

class IncidentResponse(BaseModel):
    id: UUID
    session_id: UUID
    student_id: UUID
    risk_score: float
    risk_level: str
    triggered_behaviors: dict
    flagged_at: datetime
    reviewed: bool
    reviewer_notes: Optional[str]
    
    class Config:
        from_attributes = True

# =============================================================================
# IOT RULE SCHEMAS
# =============================================================================

class IoTRuleBase(BaseModel):
    rule_name: str
    room_id: UUID
    condition_type: str
    condition_params: dict
    actions: list
    priority: int = 0

class IoTRuleCreate(IoTRuleBase):
    pass

class IoTRuleUpdate(BaseModel):
    rule_name: Optional[str] = None
    condition_params: Optional[dict] = None
    actions: Optional[list] = None
    is_active: Optional[bool] = None
    priority: Optional[int] = None

class IoTRuleResponse(IoTRuleBase):
    id: UUID
    is_active: bool
    created_at: datetime
    last_triggered: Optional[datetime]
    
    class Config:
        from_attributes = True

# =============================================================================
# DEVICE SCHEMAS
# =============================================================================

class DeviceCreateUpdate(BaseModel):
    device_id: Optional[str] = None
    device_type: str
    location_front_back: Literal["FRONT", "BACK"]
    location_left_right: Literal["LEFT", "RIGHT"]
    location: Optional[str] = None
    power_consumption_watts: Optional[int] = None

class DeviceToggle(BaseModel):
    action: str  # ON or OFF
    duration_minutes: Optional[int] = None  # For temporary overrides

class DeviceStateResponse(BaseModel):
    device_id: str
    device_type: str
    status: str
    manual_override: bool
    last_updated: datetime
    
    class Config:
        from_attributes = True

# =============================================================================
# AUTH SCHEMAS
# =============================================================================

class UserLogin(BaseModel):
    username: str
    password: str

class UserResponse(BaseModel):
    id: UUID
    username: str
    email: Optional[str]
    role: str
    is_active: bool
    
    class Config:
        from_attributes = True

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse

# =============================================================================
# ERROR SCHEMAS
# =============================================================================

class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None
    status_code: int
