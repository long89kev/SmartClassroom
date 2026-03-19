from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from uuid import UUID
from typing import List

from app.database import get_db
from app.models import Building, Floor, Room, DeviceState, ClassSession
from app.schemas.common import (
    BuildingResponse, BuildingCreate, 
    FloorResponse, FloorCreate,
    RoomResponse, RoomCreate,
    RoomDetailResponse, DeviceStateResponse
)

router = APIRouter(prefix="/api", tags=["Buildings & Navigation"])

# =============================================================================
# BUILDINGS ENDPOINTS
# =============================================================================

@router.get("/buildings", response_model=List[BuildingResponse])
async def list_buildings(db: Session = Depends(get_db)):
    """List all buildings"""
    buildings = db.query(Building).all()
    return buildings

@router.get("/buildings/overview")
async def list_buildings_overview(db: Session = Depends(get_db)):
    """List buildings with dashboard counts (active sessions and rooms online)."""
    buildings = db.query(Building).all()
    overview = []

    for building in buildings:
        rooms = (
            db.query(Room)
            .join(Floor, Room.floor_id == Floor.id)
            .filter(Floor.building_id == building.id)
            .all()
        )
        room_ids = [room.id for room in rooms]

        active_sessions_count = 0
        rooms_online_count = 0

        if room_ids:
            active_sessions_count = (
                db.query(ClassSession)
                .filter(
                    ClassSession.room_id.in_(room_ids),
                    ClassSession.status == "ACTIVE"
                )
                .count()
            )

            rooms_online_count = len({
                state.room_id
                for state in db.query(DeviceState)
                .filter(
                    DeviceState.room_id.in_(room_ids),
                    DeviceState.status == "ON"
                )
                .all()
            })

        overview.append({
            "id": building.id,
            "name": building.name,
            "code": building.code,
            "location": building.location,
            "active_sessions_count": active_sessions_count,
            "total_rooms": len(rooms),
            "rooms_online_count": rooms_online_count
        })

    return overview

@router.get("/buildings/{building_id}", response_model=BuildingResponse)
async def get_building(building_id: UUID, db: Session = Depends(get_db)):
    """Get specific building details"""
    building = db.query(Building).filter(Building.id == building_id).first()
    if not building:
        raise HTTPException(status_code=404, detail="Building not found")
    return building

@router.post("/buildings", response_model=BuildingResponse)
async def create_building(building: BuildingCreate, db: Session = Depends(get_db)):
    """Create a new building"""
    new_building = Building(
        name=building.name,
        location=building.location,
        code=building.code
    )
    db.add(new_building)
    db.commit()
    db.refresh(new_building)
    return new_building

# =============================================================================
# FLOORS ENDPOINTS
# =============================================================================

@router.get("/buildings/{building_id}/floors", response_model=List[FloorResponse])
async def list_floors(building_id: UUID, db: Session = Depends(get_db)):
    """List all floors in a building"""
    building = db.query(Building).filter(Building.id == building_id).first()
    if not building:
        raise HTTPException(status_code=404, detail="Building not found")
    
    floors = db.query(Floor).filter(Floor.building_id == building_id).order_by(Floor.floor_number).all()
    return floors

@router.get("/floors/{floor_id}", response_model=FloorResponse)
async def get_floor(floor_id: UUID, db: Session = Depends(get_db)):
    """Get specific floor details"""
    floor = db.query(Floor).filter(Floor.id == floor_id).first()
    if not floor:
        raise HTTPException(status_code=404, detail="Floor not found")
    return floor

@router.post("/buildings/{building_id}/floors", response_model=FloorResponse)
async def create_floor(building_id: UUID, floor: FloorCreate, db: Session = Depends(get_db)):
    """Create a new floor in a building"""
    building = db.query(Building).filter(Building.id == building_id).first()
    if not building:
        raise HTTPException(status_code=404, detail="Building not found")
    
    new_floor = Floor(
        building_id=building_id,
        floor_number=floor.floor_number,
        name=floor.name
    )
    db.add(new_floor)
    db.commit()
    db.refresh(new_floor)
    return new_floor

# =============================================================================
# ROOMS ENDPOINTS
# =============================================================================

@router.get("/buildings/{building_id}/floors/{floor_id}/rooms", response_model=List[RoomResponse])
async def list_rooms(building_id: UUID, floor_id: UUID, db: Session = Depends(get_db)):
    """List all rooms on a floor"""
    floor = db.query(Floor).filter(
        Floor.id == floor_id,
        Floor.building_id == building_id
    ).first()
    
    if not floor:
        raise HTTPException(status_code=404, detail="Floor not found")
    
    rooms = db.query(Room).filter(Room.floor_id == floor_id).all()
    return rooms

@router.get("/rooms/{room_id}", response_model=RoomResponse)
async def get_room(room_id: UUID, db: Session = Depends(get_db)):
    """Get specific room details"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return room

@router.post("/buildings/{building_id}/floors/{floor_id}/rooms", response_model=RoomResponse)
async def create_room(building_id: UUID, floor_id: UUID, room: RoomCreate, db: Session = Depends(get_db)):
    """Create a new room on a floor"""
    floor = db.query(Floor).filter(
        Floor.id == floor_id,
        Floor.building_id == building_id
    ).first()
    
    if not floor:
        raise HTTPException(status_code=404, detail="Floor not found")
    
    new_room = Room(
        floor_id=floor_id,
        room_code=room.room_code,
        name=room.name,
        capacity=room.capacity,
        devices={}
    )
    db.add(new_room)
    db.commit()
    db.refresh(new_room)
    return new_room

@router.get("/rooms/{room_id}/status")
async def get_room_status(room_id: UUID, db: Session = Depends(get_db)):
    """Get real-time status of devices in a room"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    devices = db.query(DeviceState).filter(DeviceState.room_id == room_id).all()
    
    return {
        "room_id": room_id,
        "room_code": room.room_code,
        "room_name": room.name,
        "devices": [
            {
                "device_id": d.device_id,
                "device_type": d.device_type,
                "status": d.status,
                "last_updated": d.last_updated
            }
            for d in devices
        ],
        "total_devices": len(devices)
    }

@router.get("/rooms/{room_id}/hierarchy")
async def get_room_full_hierarchy(room_id: UUID, db: Session = Depends(get_db)):
    """Get full building hierarchy for a room (Building -> Floor -> Room)"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    floor = db.query(Floor).filter(Floor.id == room.floor_id).first()
    building = db.query(Building).filter(Building.id == floor.building_id).first()
    
    return {
        "building": {
            "id": building.id,
            "name": building.name,
            "code": building.code
        },
        "floor": {
            "id": floor.id,
            "number": floor.floor_number,
            "name": floor.name
        },
        "room": {
            "id": room.id,
            "code": room.room_code,
            "name": room.name,
            "capacity": room.capacity
        }
    }
