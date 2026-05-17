import asyncio
from uuid import uuid4
from datetime import datetime, timedelta
import bcrypt

from app.database import SessionLocal
from app.models import (
    User, Student, Teacher, Subject, Building, Floor, Room, 
    ClassSession, Enrollment, AttendanceSessionConfig
)

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def seed_test_data():
    db = SessionLocal()
    try:
        print("Creating Test Building, Floor, Room...")
        building = db.query(Building).filter_by(code="TEST-BLDG").first()
        if not building:
            building = Building(name="Test Building", code="TEST-BLDG", location="Test Campus")
            db.add(building)
            db.flush()

        floor = db.query(Floor).filter_by(building_id=building.id, name="Test Floor 1").first()
        if not floor:
            floor = Floor(building_id=building.id, floor_number=1, name="Test Floor 1")
            db.add(floor)
            db.flush()

        room = db.query(Room).filter_by(room_code="TEST-R01").first()
        if not room:
            room = Room(floor_id=floor.id, room_code="TEST-R01", name="Test Classroom 1", capacity=30, devices={})
            db.add(room)
            db.flush()

        print("Creating Test Teacher...")
        teacher_user = db.query(User).filter_by(username="test_teacher").first()
        if not teacher_user:
            teacher_user = User(
                username="test_teacher", 
                password_hash=hash_password("password123"), 
                role="INSTRUCTOR", 
                is_active=True
            )
            db.add(teacher_user)
            db.flush()

        teacher = db.query(Teacher).filter_by(user_id=teacher_user.id).first()
        if not teacher:
            teacher = Teacher(
                user_id=teacher_user.id, 
                name="Test Teacher", 
                department="Computer Science"
            )
            db.add(teacher)
            db.flush()

        from app.models import UserRoomAssignment
        assignment = db.query(UserRoomAssignment).filter_by(user_id=teacher_user.id, room_id=room.id).first()
        if not assignment:
            assignment = UserRoomAssignment(user_id=teacher_user.id, room_id=room.id, can_view=True, can_control=True)
            db.add(assignment)
            db.flush()

        print("Creating Test Student...")
        student_user = db.query(User).filter_by(username="test_student").first()
        if not student_user:
            student_user = User(
                username="test_student", 
                password_hash=hash_password("password123"), 
                role="STUDENT", 
                is_active=True
            )
            db.add(student_user)
            db.flush()

        student = db.query(Student).filter_by(user_id=student_user.id).first()
        if not student:
            student = Student(
                user_id=student_user.id, 
                student_id="S999999", 
                name="Test Student", 
                class_name="TEST-CLASS"
            )
            db.add(student)
            db.flush()

        print("Creating Test Subject & Enrollment...")
        subject = db.query(Subject).filter_by(code="TEST101").first()
        if not subject:
            subject = Subject(code="TEST101", name="Introduction to Testing")
            db.add(subject)
            db.flush()

        enrollment = db.query(Enrollment).filter_by(student_id=student.id, subject_id=subject.id).first()
        if not enrollment:
            enrollment = Enrollment(student_id=student.id, subject_id=subject.id)
            db.add(enrollment)
            db.flush()

        print("Creating Active Class Session...")
        # Check if an active session exists for this room
        session = db.query(ClassSession).filter_by(room_id=room.id, status="ACTIVE").first()
        if not session:
            start_time = datetime.utcnow() - timedelta(minutes=15)
            end_time = datetime.utcnow() + timedelta(hours=1)
            
            session = ClassSession(
                room_id=room.id,
                teacher_id=teacher.id,
                subject_id=subject.id,
                mode="NORMAL",
                start_time=start_time,
                end_time=end_time,
                status="ACTIVE"
            )
            db.add(session)
            db.flush()

        print("Creating Attendance Config...")
        config = db.query(AttendanceSessionConfig).filter_by(session_id=session.id).first()
        if not config:
            config = AttendanceSessionConfig(
                session_id=session.id,
                grace_minutes=15,
                min_confidence=0.75,
                auto_checkin_enabled=True
            )
            db.add(config)
        
        db.commit()
        print("\nSuccessfully created test environment!")
        print(f"=====================================")
        print(f"Room Code: TEST-R01")
        print(f"Room ID:   {room.id}")
        print(f"Subject:   TEST101 (Introduction to Testing)")
        print(f"Session ID:{session.id}")
        print(f"Teacher:   test_teacher / password123")
        print(f"Student:   test_student / password123 (ID: S999999)")
        print(f"=====================================")
        
    except Exception as e:
        db.rollback()
        print(f"Error seeding data: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_test_data()
