# Attendance Module — USB Webcam Face Recognition

Student attendance checking via USB webcam + DeepFace recognition,
with live status on the ESP32 LCD display and the Web UI.

## Architecture

```
USB Webcam (OpenCV)
    │
    ▼
attendance_service.py    ← runs on the PC
    ├──  DeepFace.find() against face_db/
    ├──  POST /api/attendance/sessions/{id}/events/ingest
    ├──  MQTT → classroom/display/line1 + line2 → ESP32 LCD
    └──  Flask MJPEG stream → http://localhost:5051/video_feed
                                        ↑
                                  React Frontend
                              (AttendanceLivePanel)
```

## Quick Start

### 1. Install Dependencies

```bash
cd embedded/attendance
pip install -r requirements.txt
```

> **Note**: DeepFace requires TensorFlow. Install `tf-keras` or `tensorflow` if not already present.

### 2. Enroll Student Faces

**Option A — From a folder of images:**

Prepare a folder where each file is named `STUDENT_CODE.jpg`:
```
photos/
  2012345.jpg
  2012346.jpg
  2012347.jpg
```

```bash
python enroll_faces.py --from-folder ./photos
```

**Option B — Interactive webcam capture:**

```bash
python enroll_faces.py --capture
```

This opens the webcam. Enter a student code, press SPACE to capture, then move to the next student.

**View enrolled faces:**

```bash
python enroll_faces.py --list
```

### 3. Run the Attendance Service

```bash
# Auto-discover active session, connect to MQTT for LCD updates
python attendance_service.py

# Test mode (no backend posting)
python attendance_service.py --dry-run

# Specify camera index (if laptop has built-in cam at 0, USB at 1)
python attendance_service.py --camera 1

# Use a specific session ID
python attendance_service.py --session-id <UUID>

# Disable MQTT (no LCD updates)
python attendance_service.py --no-mqtt
```

### 4. View in the Web UI

1. Open the Building Dashboard in the frontend
2. Select an active session
3. The **Live Attendance** panel appears below the Attendance Config section
4. It shows:
   - Real-time MJPEG camera feed from the PC service
   - Student roster with PRESENT / LATE / ABSENT status
   - Summary cards (enrolled, present, late, absent, rate)
   - Recent recognition feed

### 5. LCD Display

The ESP32 LCD updates automatically when a student is recognized:
- Line 1: `Attendance`
- Line 2: `Nguyen V A: OK` (truncated to 16 chars)

No firmware changes needed — uses the existing `classroom/display/line1` and `line2` MQTT topics.

## Configuration

All settings are in `config.py` and can be overridden via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CAMERA_INDEX` | `0` | Webcam index (0=default, 1=USB if laptop has built-in) |
| `CAPTURE_INTERVAL` | `3` | Seconds between recognition attempts |
| `MQTT_BROKER_HOST` | `192.168.1.104` | MQTT broker IP (matches ESP32 config) |
| `BACKEND_URL` | `http://localhost:8000` | FastAPI backend URL |
| `BACKEND_USERNAME` | `admin` | Backend login username |
| `BACKEND_PASSWORD` | `admin123` | Backend login password |
| `ROOM_CODE` | `A1-F1-R04` | Room code for session discovery |
| `MODEL_NAME` | `VGG-Face` | DeepFace model (VGG-Face, Facenet, ArcFace) |
| `DETECTOR_BACKEND` | `opencv` | Face detector (opencv, retinaface, mtcnn) |
| `RECOGNITION_THRESHOLD` | `0.40` | Max cosine distance for a match (lower = stricter) |
| `STREAM_PORT` | `5051` | Flask MJPEG stream port |

## API Endpoints Added

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/attendance/sessions/{id}/events/ingest` | Real attendance event from USB webcam |
| `GET` | `/api/attendance/face-templates/students` | List all students (for PC service mapping) |

## File Structure

```
embedded/attendance/
├── attendance_service.py     # Main service (webcam + recognition + MQTT + Flask)
├── enroll_faces.py           # Face enrollment helper
├── config.py                 # Configuration
├── requirements.txt          # Python dependencies
├── face_db/                  # Student face images (created on enrollment)
│   ├── 2012345/
│   │   └── 2012345_001.jpg
│   └── 2012346/
│       └── 2012346_001.jpg
└── README.md                 # This file
```
