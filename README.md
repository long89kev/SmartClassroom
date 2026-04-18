# Smart AI-IoT Classroom System

A comprehensive full-stack web application for intelligent classroom environment management, integrating AI-powered behavior monitoring (learning & testing modes), IoT device automation, and real-time analytics.

## Project Overview

This system provides:

1. **Hierarchical Dashboard** - Building → Floor → Room navigation with real-time device status
2. **AI Behavior Monitoring** - Learning Mode (performance grading) and Testing Mode (cheat detection)
3. **Device Management** - Manual controls + auto-rules for IoT devices
4. **Analytics & Grading** - Real-time performance scores and cheat risk flagging
5. **Flexible Architecture** - Dual-database design with auto-device discovery

## Tech Stack

- **Frontend**: React 18 + Tailwind CSS + WebSocket
- **Backend**: FastAPI (Python) + SQLAlchemy ORM
- **Database**: PostgreSQL (single unified schema with JSONB)
- **AI Models**: YOLO v8 (from SCB-Dataset)
- **IoT**: MQTT (mocked for MVP)
- **Jobs**: APScheduler (background auto-rules)
- **Auth**: JWT + Role-based access control

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Python 3.11+ (for local development)
- Node.js 18+ (for frontend)

### Setup (Docker)

```bash
# 1. Clone the repository
cd d:\Projects\DoAnDN

# 2. Create .env file
cp .env.example .env

# 3. Start services
docker-compose up -d

# Database will be initialized at http://localhost:5432
# Backend API at http://localhost:8000
# Frontend dev server at http://localhost:3000 (after npm start)
```

### Setup (Local Development)

```bash
# Backend
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload

# Frontend (in separate terminal)
cd frontend
npm install
npm run dev
```

## Documentation and Script Locations

- Main operational docs are in `docs/`:
	- `docs/QUICK_START.md`
	- `docs/TESTING_GUIDE.md`
	- `docs/PHASE_1_COMPLETE.md`
	- `docs/PHASE_2_COMPLETE.md`
	- `docs/WEIGHTS_VALIDATION_QUICK_START.md`
- Testing and smoke PowerShell scripts are in `scripts/testing/`:
	- `scripts/testing/smoke_phase12.ps1`
	- `scripts/testing/smoke_phase3.ps1`
	- `scripts/testing/smoke_role_access.ps1`
	- `scripts/testing/demo_reset_lecturer_session.ps1`
	- `scripts/testing/test_weights_validation.ps1`
- Runtime/test logs from root were moved to `logs/`.

## Project Structure

```
DoAnDN/
├── backend/
│   ├── app/
│   │   ├── models/           # SQLAlchemy ORM models
│   │   ├── schemas/          # Pydantic request/response schemas
│   │   ├── routers/          # API endpoints
│   │   ├── services/         # Business logic (grading, risk, MQTT)
│   │   ├── middleware/       # Auth, logging
│   │   ├── main.py           # FastAPI app
│   │   ├── config.py         # Settings
│   │   └── database.py       # DB setup
│   ├── models/yolo_weights/  # YOLO model files
│   ├── jobs/                 # Background jobs (auto-rules)
│   ├── migrations/           # Database schema
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── components/       # React components
│   │   ├── pages/            # Page components
│   │   ├── services/         # API & WebSocket clients
│   │   ├── store/            # State management (Zustand)
│   │   └── styles/           # Tailwind config
│   ├── package.json
│   └── Dockerfile
├── docs/
│   ├── DATABASE_SCHEMA.md
│   ├── API_SPEC.md
│   ├── CONFIGURATION.md
│   ├── YOLO_INTEGRATION.md
│   └── AUTO_RULES_GUIDE.md
├── docker-compose.yml
├── .env.example
└── README.md
```

## Phase Implementation

- **Phase 1**: ✅ Project Setup & Database Schema (Complete)
- **Phase 2**: Backend API Routing (In Progress)
- **Phase 3**: AI Model Integration & Grading Logic
- **Phase 4**: Frontend Dashboard
- **Phase 5**: IoT Auto-Rules & MQTT Mock
- **Phase 6**: Testing & Integration

## Core Features

### 1. Dashboard & Device Control
- Real-time hierarchical navigation (Building → Floor → Room)
- Device grid with manual override toggles
- Live device status indicators

### 2. Learning Mode (AI Behavior Grading)
- Real-time detection of 14 student behaviors & 4 teacher behaviors
- Performance scoring equation: `Performance = Σ(w_i * f_i)`
- Per-student and per-teacher analytics
- Configurable weights per subject

### 3. Testing Mode (Cheat Detection)
- Risk detection for 5 suspicious behaviors
- Risk scoring equation: `Risk = α*C_head + β*C_talk + γ*T_device`
- Automatic flagging when risk > threshold
- Snapshot capture of suspicious moments

### 4. IoT Auto-Rules
- Occupancy-based automation (turn ON when students present)
- Timetable-based automation (turn ON before scheduled class)
- Zero-occupancy shutdown (turn OFF after idle period)
- Hybrid device discovery (MQTT auto-register + manual override)

### 5. Analytics & Reporting
- Real-time performance dashboards
- Risk incident logs with reviewer notes
- Session summaries and historical data

## Database Schema Highlights

### Core University Tables (7)
- Buildings, Floors, Rooms (hierarchical)
- Subjects, Teachers, Students, Enrollments

### Session & Analytics Tables (5)
- Timetable, ClassSession, BehaviorClass, BehaviorLog, PerformanceAggregate

### Risk & IoT Tables (5)
- RiskBehavior, RiskIncident, IoTRule, DeviceState, RoomOccupancy

### Configuration Tables (2)
- PerformanceWeight, RiskWeight

### Auth & Audit Tables (2)
- User, AuditLog

## API Endpoints Overview

### Buildings & Navigation
- `GET /api/buildings`
- `GET /api/buildings/{id}/floors`
- `GET /api/buildings/{id}/floors/{id}/rooms`
- `GET /api/rooms/{id}/status`

### Device Management
- `GET /api/rooms/{id}/devices`
- `POST /api/rooms/{id}/devices` (add device)
- `PUT /api/rooms/{id}/devices/{id}` (edit device)
- `DELETE /api/rooms/{id}/devices/{id}` (remove device)
- `POST /api/devices/{id}/toggle` (manual override)

### Sessions & AI
- `POST /api/sessions` (start session)
- `PUT /api/sessions/{id}/mode` (switch NORMAL/TESTING)
- `POST /api/sessions/{id}/behavior` (ingest behavior)
- `GET /api/sessions/{id}/analytics` (live dashboard)
- `POST /api/sessions/{id}/end` (end session)

### Risk & Incidents
- `GET /api/rooms/{id}/incidents`
- `GET /api/incidents/{id}`
- `POST /api/incidents/{id}/review`

### IoT Rules
- `GET /api/rules`
- `POST /api/rules`
- `PUT /api/rules/{id}`
- `DELETE /api/rules/{id}`

### Auth
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`

## Environment Variables

See `.env.example` for full list. Key variables:

```
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/doai_classroom
REDIS_URL=redis://localhost:6379/0

# Auth
JWT_SECRET=your-secret-key
JWT_ALGORITHM=HS256

# YOLO
YOLO_MODEL_VERSION=v8
YOLO_CONFIDENCE_THRESHOLD=0.5

# MQTT (Mock)
MQTT_USE_MOCK=True

# Attendance stream bridge
# Local backend default: http://localhost:5051
# Docker backend default (compose): http://host.docker.internal:5051
ATTENDANCE_SERVICE_URL=http://localhost:5051

# Optional frontend override (defaults to /api/attendance/stream)
VITE_ATTENDANCE_STREAM_BASE_URL=/api/attendance/stream
```

## Live Attendance Camera Feed

The frontend now resolves camera stream URLs from environment config instead of hardcoded localhost values.

1. Start backend and frontend as usual.
2. Run attendance stream service from `embedded/attendance`:
```bash
python attendance_service.py
```
3. Verify stream endpoints:
- `http://localhost:5051/health`
- `http://localhost:5051/status`
- `http://localhost:5051/video_feed`
4. Frontend camera panels consume backend proxy endpoints under:
- `/api/attendance/stream/status`
- `/api/attendance/stream/video_feed`

For Docker Compose, backend uses `ATTENDANCE_SERVICE_URL` to reach the attendance service (default target: `http://host.docker.internal:5051`).

## Development Notes

### YOLO Integration
- Models loaded from `backend/models/yolo_weights/` (extract YOLO.zip here)
- v8 is default; all versions (5-13) supported
- Inference wrapper in `backend/app/services/yolo_wrapper.py`

### Database Initialization
- Schema auto-created on container startup
- Seed data: behavior classes, default weights, risk behaviors
- JSONB columns used for flexible device inventory

### Real-time Updates
- WebSocket connection for live dashboards
- Behavior stream ingestion via `/api/sessions/{id}/behavior`
- Device state changes broadcast to connected clients

## Testing

```bash
# Backend unit tests
cd backend
pytest

# Frontend tests
cd frontend
npm test
```

## Deployment

For production:
1. Update `.env` with production values
2. Set `DEBUG=False`
3. Use environment-specific database and Redis
4. Deploy with Docker Compose or Kubernetes

## Contributing

Follow these conventions:
- Backend: PEP 8 style
- Frontend: Functional components with hooks
- Commit messages: `feat|fix|docs|test: description`

## Support

For issues or questions, refer to:
- `/docs/DATABASE_SCHEMA.md` - Schema details
- `/docs/API_SPEC.md` - Full endpoint documentation
- `/docs/YOLO_INTEGRATION.md` - Model setup

## License

Built for Smart Classroom Research - 2026
