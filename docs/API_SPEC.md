# API Specification - Smart AI-IoT Classroom System

**Version**: 0.1.0  
**Base URL**: `http://localhost:8000/api`  
**Authentication**: JWT Bearer Token (via `/auth/login`)

---

## API Overview

**Total Endpoints**: 40+  
**Route Groups**: 6 (Buildings, Devices, Sessions, Incidents, Rules, Auth)  
**Response Format**: JSON

### Health Check
- `GET /health` - Application health status
- `GET /` - API root info

---

## 1. BUILDINGS & NAVIGATION (7 endpoints)

### List Buildings
```
GET /api/buildings
Response: [BuildingResponse]
```
Lists all buildings in the system.

### Get Building
```
GET /api/buildings/{building_id}
Response: BuildingResponse
```

### List Floors
```
GET /api/buildings/{building_id}/floors
Response: [FloorResponse]
```
Get all floors in a building.

### Get Floor
```
GET /api/floors/{floor_id}
Response: FloorResponse
```

### List Rooms
```
GET /api/buildings/{building_id}/floors/{floor_id}/rooms
Response: [RoomResponse]
```

### Get Room
```
GET /api/rooms/{room_id}
Response: RoomResponse
```

### Get Room Status (Real-time)
```
GET /api/rooms/{room_id}/status
Response: {
  "room_id": UUID,
  "room_code": string,
  "room_name": string,
  "devices": [{device_id, device_type, status, last_updated}],
  "total_devices": int
}
```

### Get Room Full Hierarchy
```
GET /api/rooms/{room_id}/hierarchy
Response: {
  "building": {...},
  "floor": {...},
  "room": {...}
}
```

---

## 2. DEVICE MANAGEMENT (10 endpoints)

### List Room Devices (JSONB)
```
GET /api/rooms/{room_id}/devices
Response: {
  "room_id": UUID,
  "room_code": string,
  "device_count": int,
  "devices": [DeviceSchema]
}
```

### Add Device to Room
```
POST /api/rooms/{room_id}/devices
Request: {
  "device_id": string,
  "device_type": string,  // LIGHT, FAN, AC, PROJECTOR
  "location": string,
  "power_consumption_watts": int (optional)
}
Response: {
  "message": string,
  "device": DeviceSchema,
  "total_devices": int
}
```

### Update Device Metadata
```
PUT /api/rooms/{room_id}/devices/{device_id}
Request: {
  "location": string (optional),
  "power_consumption_watts": int (optional)
}
Response: {
  "message": string,
  "device": DeviceSchema
}
```

### Delete Device
```
DELETE /api/rooms/{room_id}/devices/{device_id}
Response: 204 No Content
```

### Toggle Device (Manual Override)
```
POST /api/devices/{device_id}/toggle
Query: room_id=UUID, user_id=UUID (optional)
Request: {
  "action": "ON" | "OFF",
  "duration_minutes": int (optional)
}
Response: {
  "message": string,
  "device_id": string,
  "status": string,
  "manual_override": boolean,
  "override_until": datetime,
  "timestamp": datetime
}
```

### Clear Manual Override
```
POST /api/devices/{device_id}/auto
Query: room_id=UUID
Response: {
  "message": string,
  "device_id": string,
  "manual_override": false
}
```

### Get All Device States
```
GET /api/rooms/{room_id}/devices/status/all
Response: {
  "room_id": UUID,
  "device_states": [
    {device_id, device_type, status, manual_override, override_until, last_updated}
  ]
}
```

---

## 3. SESSION MANAGEMENT (8 endpoints)

### Create Session
```
POST /api/sessions
Request: {
  "room_id": UUID,
  "teacher_id": UUID,
  "subject_id": UUID,
  "students_present": [UUID] (optional)
}
Response: SessionResponse
```

### Get Session
```
GET /api/sessions/{session_id}
Response: SessionResponse
```

### Change Session Mode
```
PUT /api/sessions/{session_id}/mode
Request: {
  "mode": "NORMAL" | "TESTING"
}
Response: {
  "message": string,
  "session_id": UUID,
  "mode": string
}
```

### Ingest Behavior Detection
```
POST /api/sessions/{session_id}/behavior
Request: {
  "actor_id": UUID,
  "actor_type": "STUDENT" | "TEACHER",
  "behavior_class": string,
  "count": int,
  "duration_seconds": int,
  "frame_snapshot": bytes (optional),
  "yolo_confidence": float
}
Response: {
  "message": string,
  "behavior_log_id": UUID,
  "behavior_class": string,
  "confidence": float
}
```

### Get Session Analytics (Live Dashboard)
```
GET /api/sessions/{session_id}/analytics
Response: SessionAnalyticsResponse {
  "session_id": UUID,
  "mode": string,
  "status": string,
  "start_time": datetime,
  "elapsed_minutes": int,
  "student_performance": {actor_id: {behavior: count}},
  "teacher_performance": {behavior: count},
  "risk_alerts_count": int
}
```

### End Session
```
POST /api/sessions/{session_id}/end
Response: {
  "message": string,
  "session_id": UUID,
  "end_time": datetime,
  "status": "COMPLETED",
  "duration_minutes": int
}
```

### Get Active Sessions in Room
```
GET /api/rooms/{room_id}/sessions/active
Response: {
  "room_id": UUID,
  "active_sessions": int,
  "sessions": [{session_id, teacher_id, mode, start_time}]
}
```

---

## 4. RISK & INCIDENTS (7 endpoints)

### List All Incidents
```
GET /api/incidents?room_id={UUID}&session_id={UUID}&reviewed={boolean}
Response: [IncidentResponse]
```

### List Room Incidents
```
GET /api/rooms/{room_id}/incidents
Response: [IncidentResponse]
```

### Get Incident Details
```
GET /api/incidents/{incident_id}
Response: IncidentResponse {
  "id": UUID,
  "session_id": UUID,
  "student_id": UUID,
  "risk_score": float,
  "risk_level": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  "triggered_behaviors": {},
  "flagged_at": datetime,
  "reviewed": boolean,
  "reviewer_notes": string (optional)
}
```

### Create Incident (Auto-called by grading service)
```
POST /api/incidents
Request: {
  "session_id": UUID,
  "student_id": UUID,
  "risk_score": float,
  "triggered_behaviors": {}
}
Response: {
  "message": string,
  "incident_id": UUID,
  "risk_score": float,
  "risk_level": string
}
```

### Review Incident
```
POST /api/incidents/{incident_id}/review
Request: {
  "reviewer_notes": string
}
Query: reviewer_id=UUID (optional)
Response: {
  "message": string,
  "incident_id": UUID,
  "reviewed": true,
  "reviewer_notes": string
}
```

### Get Unreviewed Incidents
```
GET /api/rooms/{room_id}/incidents/unreviewed
Response: {
  "room_id": UUID,
  "unreviewed_count": int,
  "incidents": [...]
}
```

### Get Incident Snapshot
```
GET /api/incidents/{incident_id}/snapshot
Response: Binary image (JPEG)
```

---

## 5. IOT AUTO-RULES (9 endpoints)

### List All Rules
```
GET /api/rules?room_id={UUID}&active_only={boolean}
Response: [IoTRuleResponse]
```

### List Room Rules
```
GET /api/rooms/{room_id}/rules
Response: [IoTRuleResponse]
```

### Create Rule
```
POST /api/rules
Request: {
  "rule_name": string,
  "room_id": UUID,
  "condition_type": "OCCUPANCY" | "TIMETABLE" | "ZERO_OCCUPANCY" | "TIME_BASED",
  "condition_params": {},
  "actions": [{device_type, action}],
  "priority": int
}
Response: IoTRuleResponse
```

### Get Rule
```
GET /api/rules/{rule_id}
Response: IoTRuleResponse
```

### Update Rule
```
PUT /api/rules/{rule_id}
Request: {
  "rule_name": string (optional),
  "condition_params": {} (optional),
  "actions": [] (optional),
  "is_active": boolean (optional),
  "priority": int (optional)
}
Response: IoTRuleResponse
```

### Delete Rule
```
DELETE /api/rules/{rule_id}
Response: 204 No Content
```

### Toggle Rule Active/Inactive
```
POST /api/rules/{rule_id}/toggle
Response: {
  "message": string,
  "rule_id": UUID,
  "is_active": boolean
}
```

### Create Occupancy Rule (Template)
```
POST /api/rooms/{room_id}/rules/occupancy-template
Query: min_occupancy=1, duration_minutes=2
Response: IoTRuleResponse
```

### Create Zero-Occupancy Rule (Template)
```
POST /api/rooms/{room_id}/rules/zero-occupancy-template
Query: idle_minutes=30
Response: IoTRuleResponse
```

---

## 6. AUTHENTICATION (7 endpoints)

### Login
```
POST /auth/login
Request: {
  "username": string,
  "password": string
}
Response: TokenResponse {
  "access_token": string,
  "token_type": "bearer",
  "user": UserResponse
}
```

### Get Current User
```
GET /auth/me
Headers: Authorization: Bearer {token}
Response: UserResponse {
  "id": UUID,
  "username": string,
  "email": string,
  "role": "ADMIN" | "LECTURER" | "FACILITY_MANAGER",
  "is_active": boolean
}
```

### Logout
```
POST /auth/logout
Headers: Authorization: Bearer {token}
Response: {
  "message": string,
  "user_id": UUID
}
```

### Refresh Token
```
POST /auth/refresh
Headers: Authorization: Bearer {token}
Response: TokenResponse
```

### Create User (Admin only)
```
POST /auth/users
Headers: Authorization: Bearer {admin_token}
Request: {
  "username": string,
  "password": string,
  "email": string (optional),
  "role": "ADMIN" | "LECTURER" | "FACILITY_MANAGER"
}
Response: {
  "message": string,
  "user_id": UUID,
  "username": string,
  "role": string
}
```

### Get User (Admin or self)
```
GET /auth/users/{user_id}
Headers: Authorization: Bearer {token}
Response: UserResponse
```

### Initialize Admin User
```
POST /auth/init-admin
Query: username="admin" (optional), password="admin123" (optional)
Response: {
  "message": string,
  "username": string,
  "temporary_password": string,
  "next_steps": string
}
```
⚠️ **Use only once for initial setup!**

---

## Data Models

### BuildingResponse
```json
{
  "id": "UUID",
  "name": "Building A",
  "location": "Campus North",
  "code": "B1",
  "created_at": "2024-01-01T10:00:00Z"
}
```

### FloorResponse
```json
{
  "id": "UUID",
  "building_id": "UUID",
  "floor_number": 1,
  "name": "First Floor",
  "created_at": "2024-01-01T10:00:00Z"
}
```

### RoomResponse
```json
{
  "id": "UUID",
  "floor_id": "UUID",
  "room_code": "B1-103",
  "name": "Room 103",
  "capacity": 30,
  "devices": {
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
  },
  "created_at": "2024-01-01T10:00:00Z"
}
```

### SessionResponse
```json
{
  "id": "UUID",
  "room_id": "UUID",
  "teacher_id": "UUID",
  "subject_id": "UUID",
  "mode": "NORMAL",
  "status": "ACTIVE",
  "start_time": "2024-01-01T10:00:00Z",
  "end_time": null,
  "final_performance_score": null,
  "final_risk_score": null
}
```

### IncidentResponse
```json
{
  "id": "UUID",
  "session_id": "UUID",
  "student_id": "UUID",
  "risk_score": 65.5,
  "risk_level": "HIGH",
  "triggered_behaviors": {
    "head_turns": 5,
    "talk_events": 3,
    "phone_duration": 45
  },
  "flagged_at": "2024-01-01T10:05:23Z",
  "reviewed": false,
  "reviewer_notes": null
}
```

### IoTRuleResponse
```json
{
  "id": "UUID",
  "rule_name": "Lights ON when occupied",
  "room_id": "UUID",
  "condition_type": "OCCUPANCY",
  "condition_params": {
    "min_occupancy": 1,
    "duration_minutes": 2
  },
  "actions": [
    {"device_type": "LIGHT", "action": "ON"},
    {"device_type": "PROJECTOR", "action": "ON"}
  ],
  "is_active": true,
  "priority": 1,
  "created_at": "2024-01-01T10:00:00Z",
  "last_triggered": "2024-01-01T10:30:00Z"
}
```

---

## Error Responses

### 400 Bad Request
```json
{
  "detail": "Invalid request parameters"
}
```

### 401 Unauthorized
```json
{
  "detail": "Invalid credentials or expired token"
}
```

### 403 Forbidden
```json
{
  "detail": "Insufficient permissions"
}
```

### 404 Not Found
```json
{
  "detail": "Resource not found"
}
```

### 500 Internal Server Error
```json
{
  "detail": "Internal server error"
}
```

---

## Authentication

All endpoints (except `/auth/login` and `/auth/init-admin`) require JWT Bearer token in header:

```
Authorization: Bearer <access_token>
```

Obtain token via `/auth/login`, valid for 30 minutes by default (configurable).

---

## Rate Limiting

None implemented for MVP. To be added in production.

---

## CORS

All origins allowed for MVP development. Restrict in production via `.env`:

```
CORS_ORIGINS="https://example.com,https://app.example.com"
```

---

## Documentation

Interactive API docs available at:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`
