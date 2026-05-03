"""
Grading and risk detection engine for AI classroom monitoring.
- PerformanceScorer: Calculates student/teacher performance in LEARNING mode
- RiskDetector: Detects cheating/suspicious behavior in TESTING mode
"""

from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime

from app.models import (
    BehaviorLog,
    PerformanceAggregate,
    PerformanceWeight,
    RiskIncident,
    RiskWeight,
    BehaviorClass,
)
from uuid import UUID
import base64

UNKNOWN_STUDENT_ID = UUID("00000000-0000-0000-0000-000000000000")

def _safe_uuid(val: Any) -> UUID:
    if isinstance(val, UUID):
        return val
    try:
        return UUID(str(val))
    except (ValueError, TypeError):
        return UNKNOWN_STUDENT_ID


class PerformanceScorer:
    """
    Calculates performance score for learning mode.
    Performance = Σ(weight_i × behavior_count_i) / total_weight
    
    Positive behaviors (attentive, taking_notes) → positive score
    Negative behaviors (sleeping, talking) → negative score
    """

    def __init__(self, db: Session):
        self.db = db

    def calculate_performance(
        self,
        session_id: str,
        actor_id: str,
        actor_type: str,  # "STUDENT" or "TEACHER"
        subject_id: Optional[str] = None,
    ) -> float:
        """
        Calculate performance score for actor in specific session.
        
        Args:
            session_id: ClassSession ID
            actor_id: Student or Teacher UUID
            actor_type: "STUDENT" or "TEACHER"
            subject_id: Subject UUID (for weight lookup)
            
        Returns:
            Performance score (0-100)
        """
        target_actor_id = _safe_uuid(actor_id)
        behavior_logs = self.db.query(BehaviorLog).filter(
            BehaviorLog.session_id == session_id,
            BehaviorLog.actor_id == target_actor_id,
            BehaviorLog.actor_type == actor_type,
            BehaviorLog.created_at >= datetime.utcnow().replace(hour=0, minute=0, second=0),
        )

        if not behavior_logs.count():
            return 50.0  # Default neutral score

        # Get weights for this subject
        weights = self.db.query(PerformanceWeight).filter(
            PerformanceWeight.subject_id == subject_id if subject_id else True
        )

        weight_map = {w.behavior_name: w.weight for w in weights}

        total_score = 0
        total_weight = 0

        for log in behavior_logs:
            weight = weight_map.get(log.behavior_class, 1.0)
            total_score += weight
            total_weight += weight

        # Normalize to 0-100 scale
        performance = (total_score / total_weight * 100) if total_weight > 0 else 50.0
        return min(100.0, max(0.0, performance))

    def update_performance_aggregate(
        self,
        session_id: str,
        actor_id: str,
        actor_type: str,
        performance_score: float,
    ):
        """Store performance score in aggregate table."""
        target_actor_id = _safe_uuid(actor_id)
        aggregate = self.db.query(PerformanceAggregate).filter(
            PerformanceAggregate.session_id == session_id,
            PerformanceAggregate.actor_id == target_actor_id,
            PerformanceAggregate.actor_type == actor_type,
        ).first()

        if aggregate:
            aggregate.total_score = performance_score
            aggregate.calculated_at = datetime.utcnow()
        else:
            aggregate = PerformanceAggregate(
                session_id=session_id,
                actor_id=target_actor_id,
                actor_type=actor_type,
                total_score=performance_score,
            )
            self.db.add(aggregate)

        self.db.commit()


class RiskDetector:
    """
    Detects cheating/suspicious behavior in testing mode.
    
    Risk Scoring (Testing Mode):
    - Device Usage: HIGH weight (0.4) - most suspicious
    - Talking: MEDIUM weight (0.3) - communication outside session
    - Head Turns: LOW weight (0.2) - checking surroundings
    - Eye Gaze Away: LOW weight (0.1) - looking away from screen
    
    Risk = 0.4 * (device_instances / max_device)
         + 0.3 * (talking_instances / max_talk)
         + 0.2 * (head_turn_instances / max_head)
         + 0.1 * (gaze_away_instances / max_gaze)
    """

    RISK_WEIGHTS = {
        # Testing mode target labels
        "USING_PHONE": 0.4,
        "USING_COMPUTER": 0.35,
        "TALK": 0.3,
        "DISCUSS": 0.3,
        "TURN_THE_HEAD": 0.2,

        # Backward compatibility for older label names
        "DEVICE_USAGE": 0.4,
        "USING_DEVICE": 0.4,
        "CHEATING": 0.4,
        "UNAUTHORIZED_OBJECT": 0.35,
        "TALKING": 0.3,
        "HEAD_TURN": 0.2,
        "EYE_GAZE_AWAY": 0.1,
    }

    BEHAVIOR_ALIASES = {
        "TURN_HEAD": "TURN_THE_HEAD",
        "HEAD_TURN": "TURN_THE_HEAD",
        "TALKING": "TALK",
        "DEVICE_USAGE": "USING_PHONE",
        "USING_DEVICE": "USING_PHONE",
    }

    RISK_THRESHOLD = 0.65  # Trigger incident if risk > 65%

    def __init__(self, db: Session):
        self.db = db

    def normalize_behavior(self, behavior_class: str) -> str:
        """Normalize behavior names to canonical scoring labels."""
        return self.BEHAVIOR_ALIASES.get(behavior_class, behavior_class)

    def calculate_risk(
        self,
        session_id: str,
        student_id: str,
        behaviors: Dict[str, int],  # {behavior_class: count}
    ) -> float:
        """
        Calculate risk score for student in testing mode.
        
        Args:
            session_id: Testing session ID
            student_id: Student UUID
            behaviors: Dictionary of behavior instances {class: count}
            
        Returns:
            Risk score (0.0 - 1.0)
        """
        total_risk = 0.0
        total_weight = 0.0

        for behavior_class, count in behaviors.items():
            normalized_behavior = self.normalize_behavior(behavior_class)
            weight = self.RISK_WEIGHTS.get(normalized_behavior, 0.0)
            if weight > 0:
                # Normalize by count (more instances = higher risk)
                normalized = min(1.0, count / 5.0)  # 5+ instances = max risk
                total_risk += weight * normalized
                total_weight += weight

        # Calculate weighted average risk
        risk_score = (total_risk / total_weight) if total_weight > 0 else 0.0
        return min(1.0, max(0.0, risk_score))

    def get_risk_level(self, risk_score: float) -> str:
        """Convert risk score to risk level."""
        if risk_score >= 0.8:
            return "CRITICAL"
        elif risk_score >= 0.65:
            return "HIGH"
        elif risk_score >= 0.4:
            return "MEDIUM"
        else:
            return "LOW"

    def should_flag_incident(self, risk_score: float) -> bool:
        """Determine if incident should be auto-flagged."""
        return risk_score > self.RISK_THRESHOLD

    def create_risk_incident(
        self,
        session_id: str,
        student_id: str,
        room_id: str,
        risk_score: float,
        behavior_details: Dict,
        image_with_detections: Optional[str] = None,  # base64
    ) -> RiskIncident:
        """Auto-create risk incident when threshold exceeded."""
        risk_level = self.get_risk_level(risk_score)

        # Decode base64 snapshot to bytes if provided
        snapshot_bytes = None
        if image_with_detections:
            try:
                b64_data = image_with_detections
                if "," in b64_data:
                    b64_data = b64_data.split(",")[1]
                snapshot_bytes = base64.b64decode(b64_data)
            except Exception:
                pass

        target_student_id = _safe_uuid(student_id)
        incident = RiskIncident(
            session_id=session_id,
            student_id=target_student_id,
            risk_score=risk_score,
            risk_level=risk_level,
            triggered_behaviors=behavior_details,
            frame_snapshot=snapshot_bytes,
            flagged_at=datetime.utcnow(),
        )

        self.db.add(incident)
        self.db.commit()

        return incident

    def batch_analyze_behaviors(
        self,
        session_id: str,
        detected_behaviors: List[Dict],  # [{student_id, class, confidence}, ...]
    ) -> Dict[str, Dict]:
        """
        Analyze multiple behavior detections and return risk per student.
        
        Returns:
            {
                student_id: {
                    "risk_score": 0.72,
                    "risk_level": "HIGH",
                    "behaviors": {behavior_class: count},
                    "should_flag": true
                }
            }
        """
        student_behaviors = {}

        for behavior in detected_behaviors:
            student_id = behavior["student_id"]
            behavior_class = self.normalize_behavior(behavior["behavior_class"])
            confidence = behavior.get("confidence", 0.8)

            if confidence > 0.5:  # Only count confident detections
                if student_id not in student_behaviors:
                    student_behaviors[student_id] = {}

                student_behaviors[student_id][behavior_class] = (
                    student_behaviors[student_id].get(behavior_class, 0) + 1
                )

        # Calculate risk for each student
        results = {}
        for student_id, behaviors in student_behaviors.items():
            risk_score = self.calculate_risk(session_id, student_id, behaviors)
            results[student_id] = {
                "risk_score": round(risk_score, 3),
                "risk_level": self.get_risk_level(risk_score),
                "behaviors": behaviors,
                "should_flag": self.should_flag_incident(risk_score),
            }

        return results
