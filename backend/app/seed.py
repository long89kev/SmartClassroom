"""Database seeding script for buildings, floors, rooms, and mock runtime data."""
import logging
import random
import uuid
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from app.models import (
    BehaviorLog,
    Building,
    ClassSession,
    DeviceState,
    Floor,
    RiskIncident,
    Room,
    Student,
    Subject,
    Teacher,
)

logger = logging.getLogger(__name__)

# Building configurations
A_BUILDINGS = ["A1", "A2", "A3", "A4", "A5"]
B_BUILDINGS = [f"B{i}" for i in range(1, 12)]  # B1-B11
C_BUILDINGS = ["C4", "C5", "C6"]

LAB_BUILDINGS = [
    "Science and Technology Incubators",
    "Research Center for Technology and Industrial Equipment (RECTIE)",
    "National Key Lab for Digital Control and System Engineering (DCSELAB)",
    "National Key Lab for Polymer and Composite Materials",
    "Research and Application Center for Construction Technology (REACTEC)",
    "Industrial Maintenance Training Center",
    "Business Research and Training Center",
    "Polymer Research Center",
    "Center for Developing Information Technology and Geographic Information System (Ditagis)",
    "Refinery and Petrochemical Technology Research Center (RPTC)",
]

# Building structure: (floors, rooms_per_floor)
BUILDING_CONFIGS = {
    "A": (3, 15),   # A buildings: 3 floors, 15 rooms/floor
    "B": (6, 5),    # B buildings: 6 floors, 5 rooms/floor
    "C": (2, 5),    # C buildings: 2 floors, 5 rooms/floor
    "LAB": (2, 5),  # Lab buildings: 2 floors, 5 rooms/floor
}

DEVICE_TYPES = ["LIGHT", "AC", "FAN", "PROJECTOR", "CAMERA"]
DEVICE_LOCATIONS = [
    ("FRONT", "LEFT"),
    ("BACK", "RIGHT"),
    ("FRONT", "RIGHT"),
    ("BACK", "LEFT"),
    ("FRONT", "LEFT"),
]
STUDENT_BEHAVIORS = ["writing", "listening", "raising_hand", "reading"]
RISK_BEHAVIORS = ["head_turn", "talking", "phone_use"]


def _build_room_devices(room_code: str) -> list[dict]:
    """Generate deterministic mock inventory for a room using location enum values."""
    devices = []
    for index, (device_type, (location_fb, location_lr)) in enumerate(zip(DEVICE_TYPES, DEVICE_LOCATIONS), start=1):
        device_id = f"{room_code}-{device_type[:2]}-{index:02d}".replace(" ", "")
        devices.append(
            {
                "device_id": device_id,
                "device_type": device_type,
                "location_front_back": location_fb,
                "location_left_right": location_lr,
                "location": f"{location_fb}_{location_lr}",
                "status": "ON" if index % 2 == 1 else "OFF",
                "mqtt_topic": f"building/*/floor/*/room/{room_code}/device/{device_id}/state",
                "power_consumption_watts": 20 * index,
            }
        )
    return devices


def _seed_mock_runtime_data(db: Session) -> None:
    """Seed mock teacher/subject/students/sessions/behaviors/incidents and device states."""
    rooms = db.query(Room).order_by(Room.room_code.asc()).all()
    if not rooms:
        return

    # Seed device inventory and states for a useful subset of rooms.
    rooms_for_devices = rooms[:80]
    for room in rooms_for_devices:
        device_list = _build_room_devices(room.room_code)
        room.devices = {"device_list": device_list}

        for device in device_list:
            existing_state = (
                db.query(DeviceState)
                .filter(DeviceState.room_id == room.id, DeviceState.device_id == device["device_id"])
                .first()
            )
            if existing_state:
                continue

            db.add(
                DeviceState(
                    room_id=room.id,
                    device_id=device["device_id"],
                    device_type=device["device_type"],
                    status=device["status"],
                    manual_override=False,
                    last_updated=datetime.utcnow(),
                )
            )

    # Create teacher and subject if missing.
    teacher = db.query(Teacher).filter(Teacher.email == "mock.teacher@campus.local").first()
    if not teacher:
        teacher = Teacher(
            name="Mock Teacher",
            email="mock.teacher@campus.local",
            department="Engineering",
            phone="000-111-222",
        )
        db.add(teacher)
        db.flush()

    subject = db.query(Subject).filter(Subject.code == "MOCK101").first()
    if not subject:
        subject = Subject(name="Mock Smart Classroom", code="MOCK101", description="Seeded demo subject")
        db.add(subject)
        db.flush()

    # Create students for analytics and incidents.
    students: list[Student] = []
    for index in range(1, 13):
        sid = f"MOCK-STU-{index:03d}"
        existing = db.query(Student).filter(Student.student_id == sid).first()
        if existing:
            students.append(existing)
            continue
        student = Student(
            name=f"Mock Student {index}",
            student_id=sid,
            email=f"mock.student{index}@campus.local",
            class_name="SE-2026",
        )
        db.add(student)
        students.append(student)
    db.flush()

    # Create active sessions in first rooms so dashboard is populated.
    target_rooms = rooms[:16]
    for index, room in enumerate(target_rooms):
        existing_active = (
            db.query(ClassSession)
            .filter(ClassSession.room_id == room.id, ClassSession.status == "ACTIVE")
            .first()
        )
        if existing_active:
            continue

        mode = "TESTING" if index % 2 == 0 else "NORMAL"
        start_time = datetime.utcnow() - timedelta(minutes=5 + index)
        session = ClassSession(
            room_id=room.id,
            teacher_id=teacher.id,
            subject_id=subject.id,
            mode=mode,
            status="ACTIVE",
            start_time=start_time,
            students_present=[str(student.id) for student in students[:8]],
        )
        db.add(session)
        db.flush()

        # Add behavior logs for learning analytics and frame preview source.
        for student in students[:6]:
            behavior = random.choice(STUDENT_BEHAVIORS)
            db.add(
                BehaviorLog(
                    session_id=session.id,
                    actor_id=student.id,
                    actor_type="STUDENT",
                    behavior_class=behavior,
                    count=random.randint(1, 5),
                    duration_seconds=random.randint(5, 40),
                    detected_at=datetime.utcnow() - timedelta(minutes=random.randint(1, 6)),
                    yolo_confidence=round(random.uniform(0.7, 0.95), 2),
                )
            )

        # Add testing incidents for TESTING mode sessions.
        if mode == "TESTING":
            for student in students[:3]:
                score = round(random.uniform(0.55, 0.95), 2)
                if score >= 0.8:
                    risk_level = "CRITICAL"
                elif score >= 0.65:
                    risk_level = "HIGH"
                elif score >= 0.4:
                    risk_level = "MEDIUM"
                else:
                    risk_level = "LOW"

                db.add(
                    RiskIncident(
                        session_id=session.id,
                        student_id=student.id,
                        risk_score=score,
                        risk_level=risk_level,
                        triggered_behaviors={random.choice(RISK_BEHAVIORS): random.randint(1, 3)},
                        flagged_at=datetime.utcnow() - timedelta(minutes=random.randint(1, 8)),
                        reviewed=False,
                    )
                )

    db.flush()


def seed_buildings(db: Session) -> None:
    """Seed the database with all buildings, floors, and rooms."""
    logger.info("Starting database seeding...")
    
    # Check if buildings already exist
    existing_count = db.query(Building).count()
    if existing_count > 0:
        logger.info(f"Database already seeded with {existing_count} buildings. Reusing structure and seeding mock runtime data.")
        _seed_mock_runtime_data(db)
        db.commit()
        return
    
    buildings_created = 0
    floors_created = 0
    rooms_created = 0
    
    try:
        # ==============================================================================
        # SEED A BUILDINGS (A1-A5): 3 floors, 15 rooms per floor
        # ==============================================================================
        for building_name in A_BUILDINGS:
            building = Building(name=building_name, code=building_name, location=f"Campus Zone A")
            db.add(building)
            db.flush()
            buildings_created += 1
            
            floors, rooms_per_floor = BUILDING_CONFIGS["A"]
            for floor_num in range(1, floors + 1):
                floor = Floor(building_id=building.id, floor_number=floor_num, name=f"Floor {floor_num}")
                db.add(floor)
                db.flush()
                floors_created += 1
                
                for room_num in range(1, rooms_per_floor + 1):
                    room_code = f"{building_name}-F{floor_num}-R{room_num:02d}"
                    room = Room(
                        floor_id=floor.id,
                        room_code=room_code,
                        name=f"{building_name} Floor {floor_num} Room {room_num}",
                        capacity=30,
                    )
                    db.add(room)
                    rooms_created += 1
        
        # ==============================================================================
        # SEED B BUILDINGS (B1-B11): 6 floors, 5 rooms per floor
        # ==============================================================================
        for building_name in B_BUILDINGS:
            building = Building(name=building_name, code=building_name, location=f"Campus Zone B")
            db.add(building)
            db.flush()
            buildings_created += 1
            
            floors, rooms_per_floor = BUILDING_CONFIGS["B"]
            for floor_num in range(1, floors + 1):
                floor = Floor(building_id=building.id, floor_number=floor_num, name=f"Floor {floor_num}")
                db.add(floor)
                db.flush()
                floors_created += 1
                
                for room_num in range(1, rooms_per_floor + 1):
                    room_code = f"{building_name}-F{floor_num}-R{room_num:02d}"
                    room = Room(
                        floor_id=floor.id,
                        room_code=room_code,
                        name=f"{building_name} Floor {floor_num} Room {room_num}",
                        capacity=30,
                    )
                    db.add(room)
                    rooms_created += 1
        
        # ==============================================================================
        # SEED C BUILDINGS (C4-C6): 2 floors, 5 rooms per floor
        # ==============================================================================
        for building_name in C_BUILDINGS:
            building = Building(name=building_name, code=building_name, location=f"Campus Zone C")
            db.add(building)
            db.flush()
            buildings_created += 1
            
            floors, rooms_per_floor = BUILDING_CONFIGS["C"]
            for floor_num in range(1, floors + 1):
                floor = Floor(building_id=building.id, floor_number=floor_num, name=f"Floor {floor_num}")
                db.add(floor)
                db.flush()
                floors_created += 1
                
                for room_num in range(1, rooms_per_floor + 1):
                    room_code = f"{building_name}-F{floor_num}-R{room_num:02d}"
                    room = Room(
                        floor_id=floor.id,
                        room_code=room_code,
                        name=f"{building_name} Floor {floor_num} Room {room_num}",
                        capacity=30,
                    )
                    db.add(room)
                    rooms_created += 1
        
        # ==============================================================================
        # SEED LAB BUILDINGS (10 specialized labs): 2 floors, 5 rooms per floor
        # ==============================================================================
        for lab_num, lab_name in enumerate(LAB_BUILDINGS, 1):
            building = Building(name=lab_name, code=f"LAB{lab_num}", location=f"Research Campus")
            db.add(building)
            db.flush()
            buildings_created += 1
            
            floors, rooms_per_floor = BUILDING_CONFIGS["LAB"]
            for floor_num in range(1, floors + 1):
                floor = Floor(building_id=building.id, floor_number=floor_num, name=f"Floor {floor_num}")
                db.add(floor)
                db.flush()
                floors_created += 1
                
                for room_num in range(1, rooms_per_floor + 1):
                    room_code = f"LAB{lab_num}-F{floor_num}-R{room_num:02d}"
                    room = Room(
                        floor_id=floor.id,
                        room_code=room_code,
                        name=f"{lab_name} Floor {floor_num} Room {room_num}",
                        capacity=25,
                    )
                    db.add(room)
                    rooms_created += 1
        
        # Commit all changes
        _seed_mock_runtime_data(db)
        db.commit()
        
        logger.info("=" * 80)
        logger.info("DATABASE SEEDING COMPLETE")
        logger.info("=" * 80)
        logger.info(f"✓ Buildings created: {buildings_created}")
        logger.info(f"  - A Buildings (A1-A5): 5 buildings × 3 floors × 15 rooms = 225 rooms")
        logger.info(f"  - B Buildings (B1-B11): 11 buildings × 6 floors × 5 rooms = 330 rooms")
        logger.info(f"  - C Buildings (C4-C6): 3 buildings × 2 floors × 5 rooms = 30 rooms")
        logger.info(f"  - Lab Buildings (10): 10 buildings × 2 floors × 5 rooms = 100 rooms")
        logger.info(f"✓ Floors created: {floors_created}")
        logger.info(f"✓ Rooms created: {rooms_created}")
        logger.info("✓ Mock runtime data seeded: devices, sessions, behavior logs, and incidents")
        logger.info(f"  TOTAL: {buildings_created} buildings, {floors_created} floors, {rooms_created} rooms")
        logger.info("=" * 80)
        
    except Exception as e:
        db.rollback()
        logger.error(f"Error during seeding: {e}")
        raise
