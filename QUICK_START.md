# Quick Start - Web Application Testing

## 🚀 Application URLs

| Service | URL | Purpose |
|---------|-----|---------|
| **Frontend** | http://localhost | React Web UI |
| **Backend API** | http://localhost:8000 | FastAPI Backend |
| **Swagger Docs** | http://localhost:8000/docs | Interactive API Testing |
| **ReDoc** | http://localhost:8000/redoc | Alternative API Docs |

---

## ✅ System Status

✓ **Frontend (Nginx)**: Running on port 80  
✓ **Backend (FastAPI)**: Running on port 8000  
✓ **PostgreSQL**: Running on port 5432  
✓ **Redis**: Running on port 6379  
✓ **YOLO Model**: Loaded and ready  

---

## 🧪 Quick Testing Commands

### 1. Initialize Admin Account
```powershell
Invoke-RestMethod -Uri "http://localhost:8000/auth/init-admin" `
  -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body '{"username":"admin","password":"admin123","email":"admin@classroom.ai"}'
```

### 2. Login
```powershell
$login = Invoke-RestMethod -Uri "http://localhost:8000/auth/login" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"username":"admin","password":"admin123"}'

$token = $login.access_token
```

### 3. Create Building
```powershell
$headers = @{"Authorization" = "Bearer $token"}

Invoke-RestMethod -Uri "http://localhost:8000/api/buildings" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body '{"name":"Main Building","address":"123 Main St","floors_count":3}'
```

### 4. Get All Buildings
```powershell
Invoke-RestMethod -Uri "http://localhost:8000/api/buildings" `
  -Method GET `
  -Headers $headers
```

### 5. Create Session
```powershell
$session = Invoke-RestMethod -Uri "http://localhost:8000/api/sessions" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body '{
    "room_id":"<room-uuid>",
    "teacher_id":"<teacher-uuid>",
    "subject_id":"<subject-uuid>",
    "students_present":[]
  }'
```

### 6. Toggle Device
```powershell
Invoke-RestMethod -Uri "http://localhost:8000/api/devices/<device-id>/toggle" `
  -Method POST `
  -ContentType "application/json" `
  -Headers $headers `
  -Body '{}'
```

---

## 📋 CRUD Operations Checklist

- [ ] **CREATE** - Build CRUD Objects (Buildings, Floors, Rooms, Devices)
- [ ] **READ** - Fetch Objects (GET endpoints)
- [ ] **UPDATE** - Modify Objects (PUT/POST endpoints)
- [ ] **DELETE** - Remove Objects (DELETE endpoints - if implemented)

---

## 🎯 Key Test Scenarios

1. **User Authentication**
   - Initialize admin account
   - Login and receive JWT token
   - Use token for API requests

2. **Facility Management**
   - Create building → Create floors → Create rooms
   - Create IoT devices in rooms
   - Toggle device status

3. **Session Management**
   - Create classroom session
   - Ingest student behavior data
   - View session analytics
   - End session

4. **Incident Tracking**
   - Create risk incidents (CHEATING, DISTRACTION, etc.)
   - View incidents per room
   - Track incident severity

5. **Rule Management**
   - Create automation rules
   - Set behavior thresholds
   - Configure auto-incident triggering

---

## 📊 Database

- **Tables**: 21 total
- **Seed Data**: Included (behavior classes, risk weights, etc.)
- **Users**: admin (created on first init-admin call)

---

## 🔍 Viewing API Documentation

1. Open browser: http://localhost:8000/docs
2. Auth endpoints documented
3. Try it out with the built-in interface
4. View request/response schemas

---

## 🔧 Docker Commands

```powershell
# View logs
docker compose logs backend -f
docker compose logs frontend

# Check status
docker compose ps

# Stop services
docker compose down

# Restart services
docker compose restart

# View container details
docker compose inspect backend
```

---

## 📝 Frontend Development Notes

- **Location**: `d:\Projects\DoAnDN\frontend`
- **Framework**: React 18 + TypeScript
- **Styling**: Tailwind CSS
- **Build**: Vite
- **API Proxy**: Configured to http://localhost:8000/api

To develop locally (not in container):
```powershell
cd frontend
npm run dev  # Runs on http://localhost:3000
```

---

## ✨ Next Steps (Phase 3-4)

- Implement grading/risk detection AI logic
- Build dashboard UI components
- Add real-time WebSocket updates
- Implement complete CRUD forms
- Add MQTT integration for IoT devices

