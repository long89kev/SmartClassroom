from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from uuid import UUID
from datetime import datetime, timedelta
from jose import JWTError, ExpiredSignatureError, jwt
from typing import Optional, List, Set

from app.database import get_db
from app.models import User, Permission, RolePermission, UserRoomAssignment, UserBlockAssignment, RoleModeAccess
from app.schemas.common import UserLogin, UserResponse, TokenResponse, UserRegister
from app.config import get_settings
import bcrypt

router = APIRouter(prefix="/auth", tags=["Authentication"])
security = HTTPBearer()

settings = get_settings()

# =============================================================================
# AUTH UTILITIES
# =============================================================================

def hash_password(password: str) -> str:
    """Hash password with bcrypt"""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def verify_password(password: str, hash: str) -> bool:
    """Verify password against hash"""
    return bcrypt.checkpw(password.encode(), hash.encode())

def create_access_token(user_id: UUID, role: str, expire_delta: Optional[timedelta] = None) -> str:
    """Create JWT access token"""
    to_encode = {
        "user_id": str(user_id),
        "role": role,
        "exp": datetime.utcnow() + (expire_delta or timedelta(minutes=settings.access_token_expire_minutes))
    }
    
    encoded_jwt = jwt.encode(
        to_encode,
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm
    )
    
    return encoded_jwt

def verify_token(token: str) -> dict:
    """Verify JWT token and return payload"""
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm]
        )
        return payload
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security), db: Session = Depends(get_db)) -> User:
    """Dependency to get current authenticated user"""
    try:
        payload = verify_token(credentials.credentials)
        user_id = UUID(payload.get("user_id"))
    except:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    user = db.query(User).filter(User.id == user_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    
    return user

# =============================================================================
# AUTHORIZATION GUARDS & HELPERS
# =============================================================================

def get_user_permissions(user: User, db: Session) -> Set[str]:
    """Fetch all effective permissions for a user based on their role"""
    permissions = db.query(Permission.key).join(
        RolePermission,
        RolePermission.permission_id == Permission.id
    ).filter(
        RolePermission.role == user.role
    ).all()
    return {p.key for p in permissions}

def get_user_room_scope(user: User, db: Session) -> List[UUID]:
    """Get list of room IDs accessible to user (empty if no restrictions)"""
    if user.role in {"SYSTEM_ADMIN", "ACADEMIC_BOARD", "CLEANING_STAFF"}:
        return []  # No restriction for these roles
    
    assignments = db.query(UserRoomAssignment.room_id).filter(
        UserRoomAssignment.user_id == user.id
    ).all()
    return [a.room_id for a in assignments] if assignments else []

def get_user_block_scope(user: User, db: Session) -> List[UUID]:
    """Get list of floor/block IDs accessible to user"""
    if user.role in {"SYSTEM_ADMIN", "CLEANING_STAFF"}:
        return []  # No restriction
    
    assignments = db.query(UserBlockAssignment.floor_id).filter(
        UserBlockAssignment.user_id == user.id
    ).all()
    return [a.floor_id for a in assignments] if assignments else []

def require_role(*allowed_roles: str):
    """Dependency to enforce specific role(s)"""
    async def role_check(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail=f"Only {','.join(allowed_roles)} roles can access this"
            )
        return current_user
    return role_check

def require_permission(*required_perms: str):
    """Dependency to enforce specific permission(s)"""
    async def perm_check(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
        user_perms = get_user_permissions(current_user, db)
        if not any(perm in user_perms for perm in required_perms):
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions. Required: {','.join(required_perms)}"
            )
        return current_user
    return perm_check

def require_room_scope(room_id: UUID):
    """Dependency to enforce room scope access (for LECTURER role)"""
    async def room_check(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
        if current_user.role in {"SYSTEM_ADMIN", "ACADEMIC_BOARD"}:
            return current_user  # No restriction
        
        # Check if user is assigned to this room
        assignment = db.query(UserRoomAssignment).filter(
            UserRoomAssignment.user_id == current_user.id,
            UserRoomAssignment.room_id == room_id
        ).first()
        
        if not assignment:
            raise HTTPException(
                status_code=403,
                detail="User not assigned to this room"
            )
        return current_user
    return room_check

def require_block_scope(floor_id: UUID):
    """Dependency to enforce block/floor scope access"""
    async def block_check(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
        if current_user.role in {"SYSTEM_ADMIN"}:
            return current_user  # No restriction
        
        # Check if user is assigned to this floor
        assignment = db.query(UserBlockAssignment).filter(
            UserBlockAssignment.user_id == current_user.id,
            UserBlockAssignment.floor_id == floor_id
        ).first()
        
        if not assignment:
            raise HTTPException(
                status_code=403,
                detail="User not assigned to this block"
            )
        return current_user
    return block_check

def check_mode_access(user: User, mode: str, db: Session) -> bool:
    """Check if user can access a specific mode (LEARNING or TESTING)"""
    if user.role == "SYSTEM_ADMIN":
        return True
    
    mode_access = db.query(RoleModeAccess).filter(
        RoleModeAccess.role == user.role
    ).first()
    
    if not mode_access:
        return False
    
    if mode == "TESTING":
        return mode_access.can_switch_to_testing
    elif mode == "LEARNING":
        return mode_access.can_switch_to_learning
    
    return False

# =============================================================================
# AUTH ENDPOINTS
# =============================================================================

@router.post("/login", response_model=TokenResponse)
async def login(credentials: UserLogin, db: Session = Depends(get_db)):
    """Login with username/password to get JWT token"""
    user = db.query(User).filter(User.username == credentials.username).first()
    
    if not user or not verify_password(credentials.password, user.password_hash):
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password"
        )
    
    if not user.is_active:
        raise HTTPException(status_code=403, detail="User account is inactive")
    
    # Create token
    access_token = create_access_token(user.id, user.role)
    
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        user=UserResponse.from_orm(user)
    )

@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def register(user_data: UserRegister, db: Session = Depends(get_db)):
    """Register a new user (public endpoint)"""
    # Check if username exists
    existing = db.query(User).filter(User.username == user_data.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    # Normalize role
    normalized_role = user_data.role.upper() if user_data.role else "STUDENT"
    valid_roles = {"LECTURER", "EXAM_PROCTOR", "ACADEMIC_BOARD", "SYSTEM_ADMIN", "FACILITY_STAFF", "CLEANING_STAFF", "STUDENT"}
    if normalized_role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role. Valid roles: {','.join(valid_roles)}")

    new_user = User(
        username=user_data.username,
        email=user_data.email,
        password_hash=hash_password(user_data.password),
        role=normalized_role,
        is_active=True
    )
    
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    return UserResponse.from_orm(new_user)

@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user: User = Depends(get_current_user)):
    """Get current authenticated user info"""
    return UserResponse.from_orm(current_user)


@router.get("/permissions")
async def get_current_permissions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get effective permission keys for the current user"""
    permissions = sorted(get_user_permissions(current_user, db))
    return {
        "role": current_user.role,
        "permissions": permissions,
    }

@router.post("/logout")
async def logout(current_user: User = Depends(get_current_user)):
    """Logout (client-side token removal)"""
    return {
        "message": "Logged out successfully",
        "user_id": current_user.id
    }

@router.post("/refresh")
async def refresh_token(current_user: User = Depends(get_current_user)):
    """Refresh JWT token"""
    access_token = create_access_token(current_user.id, current_user.role)
    
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        user=UserResponse.from_orm(current_user)
    )

# =============================================================================
# USER MANAGEMENT (ADMIN ONLY)
# =============================================================================

@router.post("/users", status_code=201)
async def create_user(
    username: str,
    password: str,
    email: Optional[str] = None,
    role: str = "LECTURER",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create new user (system admin only)"""
    if current_user.role != "SYSTEM_ADMIN":
        raise HTTPException(status_code=403, detail="Only system admins can create users")
    
    # Check if username exists
    existing = db.query(User).filter(User.username == username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    # Normalize role: ADMIN -> SYSTEM_ADMIN for backward compatibility
    normalized_role = role.replace("ADMIN", "SYSTEM_ADMIN") if role == "ADMIN" else role.upper()
    
    # Validate role (canonical roles)
    valid_roles = {"LECTURER", "EXAM_PROCTOR", "ACADEMIC_BOARD", "SYSTEM_ADMIN", "FACILITY_STAFF", "CLEANING_STAFF", "STUDENT"}
    if normalized_role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role. Valid roles: {','.join(valid_roles)}")
    
    new_user = User(
        username=username,
        email=email,
        password_hash=hash_password(password),
        role=normalized_role,
        is_active=True
    )
    
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    return {
        "message": "User created successfully",
        "user_id": new_user.id,
        "username": new_user.username,
        "role": new_user.role
    }

@router.get("/users/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get user info"""
    if current_user.role != "SYSTEM_ADMIN" and current_user.id != user_id:
        raise HTTPException(status_code=403, detail="Unauthorized")
    
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    return UserResponse.from_orm(user)

# =============================================================================
# SEED ADMIN USER (For initial setup)
# =============================================================================

@router.post("/init-admin")
async def init_admin(
    username: str = "admin",
    password: str = "admin123",
    db: Session = Depends(get_db)
):
    """
    Initialize first admin user (only if no users exist).
    Use this endpoint once on deployment to create initial admin.
    """
    user_count = db.query(User).count()
    if user_count > 0:
        raise HTTPException(
            status_code=400,
            detail="Users already exist. Use /auth/users to create new users."
        )
    
    admin = User(
        username=username,
        email=f"{username}@classroom.local",
        password_hash=hash_password(password),
        role="SYSTEM_ADMIN",
        is_active=True
    )
    
    db.add(admin)
    db.commit()
    db.refresh(admin)
    
    return {
        "message": "Admin user created",
        "username": admin.username,
        "role": admin.role,
        "temporary_password": password,
        "next_steps": "Use /auth/login to obtain JWT token"
    }
