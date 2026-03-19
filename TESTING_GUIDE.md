# Phase 1-2 Web Application & API Testing Guide

## Application Status ✅

All services are now running and ready for testing:

### Running Services
- **Frontend**: http://localhost (Nginx - Port 80)
- **Backend API**: http://localhost:8000 (FastAPI - Port 8000)
- **Database**: PostgreSQL on port 5432
- **Cache**: Redis on port 6379

### Current Frontend UI
The frontend is a React + TypeScript + Tailwind CSS application. Navigate to:
- **Home Page**: http://localhost (displays placeholder)
- **API Documentation**: http://localhost:8000/docs (Swagger UI)
- **API Redoc**: http://localhost:8000/redoc

---

## Backend API Endpoints for Testing

### Phase 1-2 Endpoints (CRUD Operations)

#### 1. **Buildings Management**
- `GET /api/buildings` - List all buildings
- `POST /api/buildings` - Create new building (requires ADMIN role)
- `GET /api/buildings/{id}` - Get building details
- `GET /api/buildings/{id}/floors` - List floors in building

#### 2. **Floors Management**
- `GET /api/buildings/{id}/floors` - List floors
- `POST /api/buildings/{id}/floors` - Create floor (requires ADMIN role)
- `GET /api/buildings/{id}/floors/{floor_id}` - Get floor details
- `GET /api/buildings/{id}/floors/{floor_id}/rooms` - List rooms in floor

#### 3. **Rooms Management**
- `GET /api/buildings/{id}/floors/{floor_id}/rooms` - List rooms
- `POST /api/buildings/{id}/floors/{floor_id}/rooms` - Create room (requires ADMIN role)
- `GET /api/rooms/{id}` - Get room details
- `GET /api/rooms/{id}/devices` - List devices in room

#### 4. **Devices Management**
- `POST /api/rooms/{id}/devices` - Create IoT device (requires ADMIN role)
- `GET /api/rooms/{id}/devices` - List devices in room
- `POST /api/devices/{id}/toggle` - Toggle device ON/OFF
- `POST /api/devices/{id}/update-status` - Update device status

#### 5. **Sessions Management**
- `POST /api/sessions` - Create new session (requires ADMIN or LECTURER)
- `GET /api/sessions/{id}` - Get session details
- `PUT /api/sessions/{id}/mode` - Change session mode (NORMAL/TESTING/LOCKED)
- `POST /api/sessions/{id}/behavior` - Ingest behavior data
- `GET /api/sessions/{id}/analytics` - Get session analytics
- `POST /api/sessions/{id}/end` - End session

#### 6. **Incidents Management**
- `POST /api/incidents` - Create risk incident (requires ADMIN or LECTURER)
- `GET /api/rooms/{id}/incidents` - List incidents in room

#### 7. **Rules Management**
- `POST /api/rules` - Create automa rule (requires ADMIN)
- `GET /api/rules` - List rules
- `GET /api/rules?room_id={id}` - List rules for specific room

#### 8. **Authentication**
- `POST /auth/init-admin` - Initialize admin account (one-time)
- `POST /auth/login` - Login and get JWT token
- `GET /auth/me` - Get current user info (requires valid token)

---

## How to Test CRUD Operations

### Step 1: Initialize Admin Account
```powershell
$response = Invoke-RestMethod -Uri "http://localhost:8000/auth/init-admin" `
  -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body '{"username":"admin","password":"admin123","email":"admin@classroom.ai"}'

$response
```

### Step 2: Login and Get JWT Token
```powershell
$loginBody = @{
    username = "admin"
    password = "admin123"
} | ConvertTo-Json

$loginResponse = Invoke-RestMethod -Uri "http://localhost:8000/auth/login" `
  -Method POST `
  -ContentType "application/json" `
  -Body $loginBody

$token = $loginResponse.access_token
$headers = @{"Authorization" = "Bearer $token"}

$token
```

### Step 3: Create a Building (CREATE)
```powershell
$buildingData = @{
    name = "Main Building"
    address = "123 Main Street"
    floors_count = 3
} | ConvertTo-Json

$building = Invoke-RestMethod -Uri "http://localhost:8000/api/buildings" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body $buildingData

$building
```

### Step 4: Get All Buildings (READ)
```powershell
$buildings = Invoke-RestMethod -Uri "http://localhost:8000/api/buildings" `
  -Method GET `
  -Headers $headers

$buildings
```

### Step 5: Create a Floor (CREATE)
```powershell
$floorData = @{
    floor_number = 1
    name = "Ground Floor"
} | ConvertTo-Json

$floor = Invoke-RestMethod -Uri "http://localhost:8000/api/buildings/$($building.id)/floors" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body $floorData

$floor
```

### Step 6: Create a Room (CREATE)
```powershell
$roomData = @{
    room_number = "101"
    name = "Classroom 101"
    capacity = 30
} | ConvertTo-Json

$room = Invoke-RestMethod -Uri "http://localhost:8000/api/buildings/$($building.id)/floors/$($floor.id)/rooms" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body $roomData

$room
```

### Step 7: Update a Room (UPDATE)
```powershell
$updateRoomData = @{
    name = "Updated Classroom 101"
    capacity = 35
} | ConvertTo-Json

$updatedRoom = Invoke-RestMethod -Uri "http://localhost:8000/api/rooms/$($room.id)" `
  -Method PUT `
  -ContentType "application/json" `
  -Headers $headers `
  -Body $updateRoomData

$updatedRoom
```

### Step 8: Create an IoT Device (CREATE)
```powershell
$deviceData = @{
    name = "Camera 101A"
    device_type = "CAMERA"
    location = "Entrance"
} | ConvertTo-Json

$device = Invoke-RestMethod -Uri "http://localhost:8000/api/rooms/$($room.id)/devices" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body $deviceData

$device
```

### Step 9: Control Device (UPDATE)
```powershell
$toggleResponse = Invoke-RestMethod -Uri "http://localhost:8000/api/devices/$($device.id)/toggle" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body "{}"

$toggleResponse
```

### Step 10: Create a Session (CREATE)
```powershell
# Get a teacher and subject first
$teachers = Invoke-RestMethod -Uri "http://localhost:8000/api/users?role=LECTURER" `
  -Method GET `
  -Headers $headers

$subjects = Invoke-RestMethod -Uri "http://localhost:8000/api/subjects" `
  -Method GET `
  -Headers $headers

$sessionData = @{
    room_id = $room.id
    teacher_id = $teachers[0].id
    subject_id = $subjects[0].id
    students_present = @()
} | ConvertTo-Json

$session = Invoke-RestMethod -Uri "http://localhost:8000/api/sessions" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body $sessionData

$session
```

### Step 11: Ingest Behavior Data (UPDATE Session)
```powershell
$behaviorData = @{
    student_id = "student-uuid"
    behavior_class = "CHEATING"
    confidence = 0.85
} | ConvertTo-Json

$ingested = Invoke-RestMethod -Uri "http://localhost:8000/api/sessions/$($session.id)/behavior" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body $behaviorData

$ingested
```

### Step 12: Get Session Analytics (READ)
```powershell
$analytics = Invoke-RestMethod -Uri "http://localhost:8000/api/sessions/$($session.id)/analytics" `
  -Method GET `
  -Headers $headers

$analytics
```

### Step 13: End Session (UPDATE)
```powershell
$endResponse = Invoke-RestMethod -Uri "http://localhost:8000/api/sessions/$($session.id)/end" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body "{}"

$endResponse
```

### Step 14: Delete a Device (DELETE) if implemented
```powershell
# Note: DELETE endpoints may need to be implemented in Phase 3
$deleteResponse = Invoke-RestMethod -Uri "http://localhost:8000/api/devices/$($device.id)" `
  -Method DELETE `
  -Headers $headers

$deleteResponse
```

---

## Testing Frontend Applications

### Current Status
The React application loads at http://localhost with a basic Home page scaffold.

### Next Steps for Phase 4
- Implement dashboard with real-time data
- Add CRUD UI forms
- Add device control interface
- Add session monitoring dashboard
- Add incident/alert viewing

---

## Database Schema (21 Tables)

All tables are created and populated with seed data:
- **Core**: buildings, floors, rooms, devices
- **Users**: users, students, teachers
- **Academic**: subjects, class_sessions, enrollments, timetable
- **Behavior**: behavior_classes, behavior_logs, performance_aggregates
- **Risk**: risk_behaviors, risk_incidents, risk_weights
- **Rules**: iot_rules, device_states
- **Monitoring**: room_occupancy, audit_logs

---

## Troubleshooting

### Backend Not Responding
```powershell
docker compose logs backend --tail 50
```

### Using API Swagger UI
Visit: http://localhost:8000/docs
- All endpoints documented with request/response schemas
- Try it out functionality available in browser

### Reset Everything
```powershell
docker compose down -v
docker system prune -f
docker compose up -d --build
```

---

## Summary
✅ Backend fully operational with 15+ endpoints  
✅ Database with 21 tables and seed data  
✅ JWT authentication working  
✅ IoT device control ready  
✅ Session management ready  
✅ Frontend loading successfully  

**Ready for Phase 1-2 user acceptance testing!**
