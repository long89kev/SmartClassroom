"""
attendance_service.py — Face Recognition Attendance Service
Smart AI-IoT Classroom System

Captures faces from a USB webcam, runs DeepFace recognition against
a local face database, posts attendance events to the backend API,
and pushes LCD status via MQTT.

Also runs a Flask server to stream annotated MJPEG and JSON status
for the React frontend to consume.

Usage:
    python attendance_service.py                 # auto-discover active session
    python attendance_service.py --dry-run       # test webcam + recognition only
    python attendance_service.py --session-id X  # use specific session ID
"""

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone

import cv2
import numpy as np
import requests

try:
    import paho.mqtt.client as mqtt
except ImportError:
    mqtt = None

try:
    from deepface import DeepFace
except ImportError:
    DeepFace = None

from flask import Flask, Response, jsonify
from flask_cors import CORS

import config

# ─── Logging ─────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("AttendanceService")

# ─── Global State ────────────────────────────────────────
running = True
latest_frame = None           # Raw BGR frame from webcam
annotated_frame = None        # Frame with bounding boxes + labels
frame_lock = threading.Lock()

attendance_state = {
    "session_id": None,
    "room_code": config.ROOM_CODE,
    "is_running": False,
    "recognized_students": [],   # [{student_code, student_name, confidence, timestamp}]
    "last_recognition_at": None,
    "total_recognized": 0,
    "camera_active": False,
}
state_lock = threading.Lock()

# Backend auth token (obtained on startup)
auth_token = None
session_id = None
student_map = {}   # student_code -> {id, name, student_code}

mqtt_client = None


# ═══════════════════════════════════════════════════════════
#  Backend API Helpers
# ═══════════════════════════════════════════════════════════

def backend_login() -> str | None:
    """Login to backend and return JWT token."""
    try:
        url = f"{config.BACKEND_URL}/auth/login"
        resp = requests.post(url, json={
            "username": config.BACKEND_USERNAME,
            "password": config.BACKEND_PASSWORD,
        }, timeout=10)
        if resp.status_code == 200:
            token = resp.json()["access_token"]
            logger.info("✓ Backend authentication successful")
            return token
        else:
            logger.error(f"Backend login failed ({resp.status_code}): {resp.text[:100]}")
            return None
    except requests.RequestException as e:
        logger.error(f"Backend login error: {e}")
        return None


def backend_headers() -> dict:
    """Return authorization headers for backend API calls."""
    if auth_token:
        return {"Authorization": f"Bearer {auth_token}"}
    return {}


def discover_active_session() -> str | None:
    """Find the active session for the configured room."""
    try:
        # First resolve room_id from room_code
        url = f"{config.BACKEND_URL}/api/rooms/by-code/{config.ROOM_CODE}"
        resp = requests.get(url, timeout=5)
        if resp.status_code != 200:
            logger.warning(f"Room lookup failed: {resp.status_code}")
            return None

        room_id = resp.json()["room_id"]

        # Find active session
        url = f"{config.BACKEND_URL}/api/rooms/{room_id}/sessions/active"
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            sessions = resp.json().get("sessions", [])
            if sessions:
                sid = sessions[0].get("session_id")
                logger.info(f"✓ Found active session: {sid}")
                return sid

        logger.info("No active session found")
        return None
    except requests.RequestException as e:
        logger.error(f"Session discovery error: {e}")
        return None


def load_student_map() -> dict:
    """Build mapping of student_code -> {id, name, student_code} from face_db directory names."""
    smap = {}
    face_db = config.FACE_DB_DIR
    if not os.path.isdir(face_db):
        logger.warning(f"Face database directory not found: {face_db}")
        return smap

    for entry in os.listdir(face_db):
        entry_path = os.path.join(face_db, entry)
        # Each student is a subdirectory named by student_code, or a file named student_code.jpg
        if os.path.isdir(entry_path):
            student_code = entry
        elif os.path.isfile(entry_path) and entry.lower().endswith(('.jpg', '.jpeg', '.png')):
            student_code = os.path.splitext(entry)[0]
        else:
            continue

        smap[student_code] = {
            "student_code": student_code,
            "name": student_code,  # Will be enriched from backend if available
            "id": None,
        }

    # Try to enrich from backend
    try:
        url = f"{config.BACKEND_URL}/api/attendance/face-templates/students"
        resp = requests.get(url, headers=backend_headers(), timeout=10)
        if resp.status_code == 200:
            for s in resp.json():
                code = s.get("student_code")
                if code and code in smap:
                    smap[code]["name"] = s.get("name", code)
                    smap[code]["id"] = s.get("student_id")
    except Exception:
        pass

    logger.info(f"✓ Student map loaded: {len(smap)} students")
    return smap


def post_attendance_event(student_code: str, confidence: float):
    """Post a recognized face event to the backend."""
    global auth_token

    if not session_id or not auth_token:
        return

    student_info = student_map.get(student_code)
    if not student_info or not student_info.get("id"):
        logger.debug(f"No backend student_id for {student_code}, skipping event post")
        return

    try:
        url = f"{config.BACKEND_URL}/api/attendance/sessions/{session_id}/events/ingest"
        payload = {
            "student_id": student_info["id"],
            "face_confidence": min(confidence, 1.0),
            "source": "USB_WEBCAM",
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }
        resp = requests.post(url, json=payload, headers=backend_headers(), timeout=10)
        if resp.status_code == 200:
            result = resp.json()
            logger.info(f"✓ Event posted: {student_code} → recognized={result.get('recognized')}")
        elif resp.status_code == 401:
            # Token expired, re-login
            logger.warning("Token expired, re-authenticating...")
            auth_token = backend_login()
            if auth_token:
                resp = requests.post(url, json=payload, headers=backend_headers(), timeout=10)
        else:
            logger.warning(f"Event post failed ({resp.status_code}): {resp.text[:100]}")
    except requests.RequestException as e:
        logger.error(f"Event post error: {e}")


# ═══════════════════════════════════════════════════════════
#  MQTT Helpers (LCD Display)
# ═══════════════════════════════════════════════════════════

def setup_mqtt():
    """Initialize MQTT client for LCD display updates."""
    global mqtt_client

    if mqtt is None:
        logger.warning("paho-mqtt not installed — LCD updates disabled")
        return

    try:
        mqtt_client = mqtt.Client(
            client_id=config.MQTT_CLIENT_ID,
            protocol=mqtt.MQTTv311,
        )

        if config.MQTT_USERNAME:
            mqtt_client.username_pw_set(config.MQTT_USERNAME, config.MQTT_PASSWORD)

        mqtt_client.connect(config.MQTT_BROKER_HOST, config.MQTT_BROKER_PORT, 60)
        mqtt_client.loop_start()
        logger.info("✓ MQTT connected for LCD updates")
    except Exception as e:
        logger.warning(f"MQTT connection failed: {e} — LCD updates disabled")
        mqtt_client = None


def update_lcd(line1: str, line2: str):
    """Publish text to ESP32 LCD via MQTT."""
    if mqtt_client is None:
        return

    try:
        # Truncate to 16 characters (LCD width)
        mqtt_client.publish(config.TOPIC_LCD_LINE1, line1[:16])
        mqtt_client.publish(config.TOPIC_LCD_LINE2, line2[:16])
    except Exception as e:
        logger.debug(f"LCD update error: {e}")


def publish_attendance_status():
    """Publish attendance JSON status via MQTT for any listener."""
    if mqtt_client is None:
        return

    try:
        with state_lock:
            payload = json.dumps({
                "session_id": attendance_state["session_id"],
                "total_recognized": attendance_state["total_recognized"],
                "last_recognition_at": attendance_state["last_recognition_at"],
                "recognized_students": attendance_state["recognized_students"][-10:],  # Last 10
            })
        mqtt_client.publish(config.TOPIC_ATTENDANCE_STATUS, payload)
    except Exception as e:
        logger.debug(f"MQTT status publish error: {e}")


# ═══════════════════════════════════════════════════════════
#  Face Recognition Engine
# ═══════════════════════════════════════════════════════════

def recognize_faces(frame: np.ndarray) -> list:
    """
    Run DeepFace recognition on a frame against the face database.
    Returns list of {student_code, confidence, region}.
    """
    if DeepFace is None:
        logger.error("DeepFace not installed — cannot recognize faces")
        return []

    face_db = config.FACE_DB_DIR
    if not os.path.isdir(face_db):
        return []

    results = []

    try:
        # Save frame temporarily for DeepFace
        temp_path = os.path.join(os.path.dirname(__file__), "_temp_frame.jpg")
        cv2.imwrite(temp_path, frame)

        # 1. Extract ALL faces first (so we can draw "Unknown" bounding boxes)
        try:
            face_objs = DeepFace.extract_faces(
                img_path=temp_path,
                detector_backend=config.DETECTOR_BACKEND,
                enforce_detection=False,
                align=False
            )
        except Exception:
            face_objs = []

        for face_obj in face_objs:
            # DeepFace returns confidence=0 if enforce_detection=False and no face is found
            if face_obj.get("confidence", 1) == 0:
                continue
                
            fa = face_obj.get("facial_area", {})
            region = {"x": fa.get("x", 0), "y": fa.get("y", 0), "w": fa.get("w", 0), "h": fa.get("h", 0)}
            
            # Default to Unknown
            results.append({
                "student_code": "Unknown",
                "confidence": 0.0,
                "region": region,
                "is_known": False
            })

        # 2. Find identities to upgrade "Unknown" to real students
        dfs = DeepFace.find(
            img_path=temp_path,
            db_path=face_db,
            model_name=config.MODEL_NAME,
            detector_backend=config.DETECTOR_BACKEND,
            distance_metric=config.DISTANCE_METRIC,
            enforce_detection=False,
            silent=True,
            threshold=config.RECOGNITION_THRESHOLD
        )

        # Clean up temp file
        try:
            os.remove(temp_path)
        except OSError:
            pass

        for df in dfs:
            if df.empty:
                continue

            # Get the best match
            best = df.iloc[0]
            identity_path = best.get("identity", "")
            
            # DeepFace >= 0.0.99 standardizes the column as "distance"
            distance = best.get("distance", 1.0)

            # Convert distance to confidence (lower distance = higher confidence)
            confidence = max(0.0, 1.0 - distance)

            if confidence < (1.0 - config.RECOGNITION_THRESHOLD):
                continue

            # Extract student code from path
            rel_path = os.path.relpath(identity_path, face_db)
            student_code = rel_path.split(os.sep)[0]
            if "." in student_code:
                student_code = os.path.splitext(student_code)[0]

            # Match this finding to our extracted face bounding boxes via overlap
            fx = best.get("source_x", 0)
            fy = best.get("source_y", 0)
            
            # Find closest bounding box in 'results'
            best_match_idx = -1
            best_dist = float('inf')
            
            for i, res in enumerate(results):
                rx, ry = res["region"]["x"], res["region"]["y"]
                dist = (rx - fx)**2 + (ry - fy)**2
                if dist < best_dist:
                    best_dist = dist
                    best_match_idx = i
                    
            if best_match_idx >= 0 and best_dist < 5000: # Has to be somewhat close
                results[best_match_idx]["student_code"] = student_code
                results[best_match_idx]["confidence"] = round(confidence, 3)
                results[best_match_idx]["is_known"] = True

    except Exception as e:
        logger.debug(f"Recognition error: {e}")

    return results


def annotate_frame(frame: np.ndarray, recognitions: list) -> np.ndarray:
    """Draw bounding boxes and labels on the frame."""
    annotated = frame.copy()

    for rec in recognitions:
        region = rec.get("region", {})
        x = region.get("x", 0)
        y = region.get("y", 0)
        w = region.get("w", 0)
        h = region.get("h", 0)

        student_code = rec["student_code"]
        confidence = rec["confidence"]
        name = student_map.get(student_code, {}).get("name", student_code)

        # Draw bounding box
        color = (0, 255, 0)  # Green
        cv2.rectangle(annotated, (x, y), (x + w, y + h), color, 2)

        # Draw label background
        label = f"{name} ({confidence:.0%})"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)
        cv2.rectangle(annotated, (x, y - th - 10), (x + tw + 4, y), color, -1)
        cv2.putText(annotated, label, (x + 2, y - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1, cv2.LINE_AA)

    # Draw status bar at top
    status_text = f"Attendance | Recognized: {attendance_state['total_recognized']}"
    cv2.rectangle(annotated, (0, 0), (annotated.shape[1], 30), (40, 40, 40), -1)
    cv2.putText(annotated, status_text, (10, 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1, cv2.LINE_AA)

    return annotated


# ═══════════════════════════════════════════════════════════
#  Main Recognition Loop
# ═══════════════════════════════════════════════════════════

def recognition_loop(dry_run: bool = False):
    """Main loop: capture frames, recognize faces, post events."""
    global latest_frame, annotated_frame, running

    cap = cv2.VideoCapture(config.CAMERA_INDEX)
    if not cap.isOpened():
        logger.error(f"Failed to open webcam (index {config.CAMERA_INDEX})")
        running = False
        return

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)
    logger.info(f"✓ Webcam opened (index {config.CAMERA_INDEX})")

    with state_lock:
        attendance_state["camera_active"] = True
        attendance_state["is_running"] = True

    update_lcd("Attendance", "Camera Ready")

    recognized_set = set()  # Track who's already been recognized this session
    last_recognition_time = 0
    last_recognitions_result = []

    while running:
        ret, frame = cap.read()
        if not ret:
            logger.warning("Failed to read frame from webcam")
            time.sleep(0.1)
            continue

        # Update latest frame for MJPEG stream
        with frame_lock:
            latest_frame = frame.copy()

        now = time.time()
        if now - last_recognition_time < config.CAPTURE_INTERVAL_SEC:
            # Apply last known annotations continuously for fluid streaming
            ann = annotate_frame(frame.copy(), last_recognitions_result)
            with frame_lock:
                annotated_frame = ann
            time.sleep(0.03)  # ~30fps for smooth streaming
            continue

        last_recognition_time = now

        # Run face recognition
        recognitions = recognize_faces(frame)
        last_recognitions_result = recognitions

        # Process results
        for rec in recognitions:
            student_code = rec["student_code"]
            confidence = rec["confidence"]

            if student_code != "Unknown" and student_code not in recognized_set:
                recognized_set.add(student_code)
                name = student_map.get(student_code, {}).get("name", student_code)

                logger.info(f"✓ RECOGNIZED: {name} (code={student_code}, conf={confidence:.2%})")

                # Update LCD
                display_name = name[:13] if len(name) > 13 else name
                update_lcd("Attendance", f"{display_name}: OK")

                # Update state
                with state_lock:
                    attendance_state["recognized_students"].append({
                        "student_code": student_code,
                        "student_name": name,
                        "confidence": confidence,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                    attendance_state["total_recognized"] = len(recognized_set)
                    attendance_state["last_recognition_at"] = datetime.now(timezone.utc).isoformat()

                # Post to backend (unless dry-run)
                if not dry_run:
                    post_attendance_event(student_code, confidence)

                # Publish MQTT status
                publish_attendance_status()

        # Annotate frame
        ann = annotate_frame(frame, recognitions)
        with frame_lock:
            annotated_frame = ann

    cap.release()
    with state_lock:
        attendance_state["camera_active"] = False
        attendance_state["is_running"] = False


# ═══════════════════════════════════════════════════════════
#  Flask MJPEG Streaming Server
# ═══════════════════════════════════════════════════════════

flask_app = Flask(__name__)
CORS(flask_app)


def generate_mjpeg():
    """Generator that yields MJPEG frames."""
    while running:
        with frame_lock:
            frame = annotated_frame

        if frame is None:
            time.sleep(0.05)
            continue

        _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n" + jpeg.tobytes() + b"\r\n"
        )
        time.sleep(0.033)  # ~30fps


@flask_app.route("/video_feed")
def video_feed():
    """MJPEG stream endpoint for the frontend."""
    return Response(
        generate_mjpeg(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@flask_app.route("/status")
def status():
    """JSON status endpoint."""
    with state_lock:
        return jsonify(attendance_state)


@flask_app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "attendance"})


# ═══════════════════════════════════════════════════════════
#  Entry Point
# ═══════════════════════════════════════════════════════════

def signal_handler(sig, frame):
    global running
    logger.info("Shutting down...")
    running = False


def main():
    global auth_token, session_id, student_map, running

    parser = argparse.ArgumentParser(description="Attendance Face Recognition Service")
    parser.add_argument("--session-id", type=str, help="Session ID (auto-discovered if not set)")
    parser.add_argument("--dry-run", action="store_true", help="Test mode: no backend posting")
    parser.add_argument("--no-mqtt", action="store_true", help="Disable MQTT (no LCD updates)")
    parser.add_argument("--camera", type=int, default=config.CAMERA_INDEX, help="Camera index")
    args = parser.parse_args()

    config.CAMERA_INDEX = args.camera

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info("=" * 60)
    logger.info("  Smart Classroom — Attendance Service")
    logger.info("=" * 60)
    logger.info(f"  Camera Index  : {config.CAMERA_INDEX}")
    logger.info(f"  Face DB       : {config.FACE_DB_DIR}")
    logger.info(f"  MQTT Broker   : {config.MQTT_BROKER_HOST}:{config.MQTT_BROKER_PORT}")
    logger.info(f"  Backend       : {config.BACKEND_URL}")
    logger.info(f"  Room          : {config.ROOM_CODE}")
    logger.info(f"  Stream Server : http://{config.STREAM_HOST}:{config.STREAM_PORT}")
    logger.info(f"  Dry Run       : {args.dry_run}")
    logger.info("=" * 60)

    # Authenticate with backend
    if not args.dry_run:
        auth_token = backend_login()
        if not auth_token:
            logger.warning("Backend auth failed — will run without event posting")

    # Discover or set session
    if args.session_id:
        session_id = args.session_id
        logger.info(f"Using provided session: {session_id}")
    elif not args.dry_run:
        session_id = discover_active_session()
        if not session_id:
            logger.warning("No active session — events will not be posted until one is found")

    with state_lock:
        attendance_state["session_id"] = session_id

    # Load student database
    student_map = load_student_map()

    # Ensure face_db directory exists
    os.makedirs(config.FACE_DB_DIR, exist_ok=True)

    # Setup MQTT
    if not args.no_mqtt:
        setup_mqtt()

    # Start recognition loop in background thread
    recognition_thread = threading.Thread(
        target=recognition_loop,
        args=(args.dry_run,),
        daemon=True,
    )
    recognition_thread.start()
    logger.info("✓ Recognition thread started")

    # Start session discovery poller (re-checks every 30s)
    if not args.dry_run and not session_id:
        def session_poller():
            global session_id
            while running:
                time.sleep(30)
                if not session_id:
                    session_id = discover_active_session()
                    if session_id:
                        with state_lock:
                            attendance_state["session_id"] = session_id
                        logger.info(f"✓ Session discovered: {session_id}")

        poller_thread = threading.Thread(target=session_poller, daemon=True)
        poller_thread.start()

    # Start Flask MJPEG server (blocking)
    logger.info(f"✓ MJPEG stream: http://localhost:{config.STREAM_PORT}/video_feed")
    logger.info(f"✓ Status JSON:  http://localhost:{config.STREAM_PORT}/status")

    try:
        flask_app.run(
            host=config.STREAM_HOST,
            port=config.STREAM_PORT,
            debug=False,
            threaded=True,
            use_reloader=False,
        )
    except KeyboardInterrupt:
        pass
    finally:
        running = False
        if mqtt_client:
            mqtt_client.loop_stop()
            mqtt_client.disconnect()
        logger.info("Attendance service stopped.")


if __name__ == "__main__":
    main()
