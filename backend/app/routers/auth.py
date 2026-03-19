from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from uuid import UUID
from datetime import datetime, timedelta
from jose import JWTError, ExpiredSignatureError, jwt
from typing import Optional

from app.database import get_db
from app.models import User
from app.schemas.common import UserLogin, UserResponse, TokenResponse
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

@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user: User = Depends(get_current_user)):
    """Get current authenticated user info"""
    return UserResponse.from_orm(current_user)

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
    """Create new user (admin only)"""
    if current_user.role != "ADMIN":
        raise HTTPException(status_code=403, detail="Only admins can create users")
    
    # Check if username exists
    existing = db.query(User).filter(User.username == username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    # Validate role
    if role not in ["ADMIN", "LECTURER", "FACILITY_MANAGER"]:
        raise HTTPException(status_code=400, detail="Invalid role")
    
    new_user = User(
        username=username,
        email=email,
        password_hash=hash_password(password),
        role=role,
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
    if current_user.role != "ADMIN" and current_user.id != user_id:
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
        role="ADMIN",
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
