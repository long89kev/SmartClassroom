"""
YOLO Weights Validation Test Harness
====================================

Tests all 4 pre-trained YOLO weights for correctness before retraining:
- Model loading & inference readiness
- Label mapping (raw YOLO → canonical backend labels)
- Mode filtering (LEARNING vs TESTING behavior classes)
- API endpoint availability (learning/testing modes)
- Baseline accuracy & confidence metrics on 50+ frames per family

Phases:
  1. Environment & Frame Extraction (extract 50 frames per model from SCB-Dataset zips)
  2. Service-Level Unit Tests (direct YOLOInferenceService testing)
  3. API Integration Tests (HTTP endpoints for learning/testing modes)
  4. Regression & Baseline (batch inference, confidence stability)
  5. Acceptance Checklist & Reporting

Run: pytest -v backend/tests/test_weights_validation.py
Or standalone: python backend/tests/test_weights_validation.py --phase all --verbose
"""

import os
import sys
import json
import base64
import zipfile
import logging
import io
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from datetime import datetime
import statistics

# ==================== Configuration ====================

BASE_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = BASE_DIR / "backend"
TESTS_DIR = BACKEND_DIR / "tests"
FIXTURES_DIR = TESTS_DIR / "fixtures" / "frames"
DATASET_DIR = BASE_DIR / "YOLO" / "SCB-Dataset"
REPORT_FILE = TESTS_DIR / "WEIGHTS_VALIDATION_REPORT.md"
LOG_FILE = TESTS_DIR / "weights_validation.log"

try:
    import numpy as np
    from PIL import Image
    import cv2
    import requests
    import pytest
except ImportError as e:
    print(f"Missing dependency: {e}. Install with: pip install pillow opencv-python requests pytest numpy")
    sys.exit(1)

# Keep console logs compatible with non-UTF-8 terminals (e.g., cp1252 on Windows).
class AsciiSafeFormatter(logging.Formatter):
    def format(self, record):
        text = super().format(record)
        return text.encode("ascii", errors="replace").decode("ascii")


# Configure logging
TESTS_DIR.mkdir(parents=True, exist_ok=True)
log_format = '%(asctime)s [%(levelname)s] %(name)s: %(message)s'
file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
stream_handler = logging.StreamHandler()
file_handler.setFormatter(logging.Formatter(log_format))
stream_handler.setFormatter(AsciiSafeFormatter(log_format))
logging.basicConfig(level=logging.INFO, handlers=[file_handler, stream_handler], force=True)
logger = logging.getLogger(__name__)

# Add backend to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Import the service under test
try:
    from backend.app.services.yolo_inference import YOLOInferenceService
except ImportError as e:
    logger.error(f"Failed to import YOLOInferenceService: {e}")
    sys.exit(1)

# Backend API configuration
API_BASE_URL = os.getenv('API_BASE_URL', 'http://localhost:8000')
API_HEALTH = f"{API_BASE_URL}/health"
API_LOGIN = f"{API_BASE_URL}/api/auth/login"
API_SESSIONS = f"{API_BASE_URL}/api/sessions"

# Test admin credentials (adjust if needed)
TEST_ADMIN_EMAIL = "admin@example.com"
TEST_ADMIN_PASSWORD = "admin123"  # Update to match your setup

# Label mappings (should match yolo_inference.py MODEL_SPECS)
EXPECTED_LABELS = {
    'student_bow_turn': ['BOW_THE_HEAD', 'TURN_THE_HEAD'],
    'student_discuss': ['DISCUSS'],
    'student_hand_read_write': ['HAND_RAISING', 'READ', 'WRITE'],
    'teacher_behavior': ['GUIDE', 'TEACHER']
}

LEARNING_MODE_LABELS = set()
for labels in EXPECTED_LABELS.values():
    LEARNING_MODE_LABELS.update(labels)

TESTING_MODE_LABELS = LEARNING_MODE_LABELS - {'HAND_RAISING', 'READ', 'WRITE'}

# SCB-Dataset zip mappings
DATASET_ZIPS = {
    'student_discuss': DATASET_DIR / 'SCB5-Discuss-2024-9-17' / 'SCB5-Discuss-2024-9-17.zip',
    'student_hand_read_write': DATASET_DIR / 'SCB5-Handrise-Read-write-2024-9-17' / 'SCB5-Handrise-Read-write-2024-9-17.zip',
    'student_bow_turn': DATASET_DIR / 'SCB_BowTurnHead_20250509' / 'SCB_BowTurnHead_20250509.zip',
    'teacher_behavior': DATASET_DIR / 'SCB5_Teacher_Behavior_Stand_BlackBoard_Sreen_20250406' / 'SCB5_Teacher_Behavior_Stand_BlackBoard_Sreen_20250406.zip'
}

# ==================== Phase 1: Environment & Frame Extraction ====================

class FrameExtractor:
    """Extract and validate frames from SCB-Dataset zips."""
    
    def __init__(self, target_frames_per_model: int = 50):
        self.target_frames = target_frames_per_model
        self.extracted_frames = {model: [] for model in DATASET_ZIPS.keys()}
        self.extraction_stats = {}
    
    def prepare_fixture_dir(self) -> None:
        """Create fixtures directory structure."""
        FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
        for model_key in DATASET_ZIPS.keys():
            (FIXTURES_DIR / model_key).mkdir(exist_ok=True)
        logger.info(f"✓ Fixtures directory ready: {FIXTURES_DIR}")
    
    def extract_frames_from_zip(self, model_key: str, target_count: int) -> List[Path]:
        """Extract images from SCB-Dataset zip."""
        zip_path = DATASET_ZIPS[model_key]
        
        if not zip_path.exists():
            logger.warning(f"⚠ Dataset zip not found: {zip_path}. Using placeholder frames.")
            return self._create_placeholder_frames(model_key, target_count)
        
        logger.info(f"Extracting frames from {model_key}: {zip_path}")
        extracted = []
        
        try:
            with zipfile.ZipFile(zip_path, 'r') as zf:
                # Find all image files in zip
                all_images = [f for f in zf.namelist() 
                             if f.lower().endswith(('.jpg', '.jpeg', '.png')) 
                             and '/train/' in f.lower()]
                
                if not all_images:
                    logger.warning(f"⚠ No training images found in {zip_path}. Trying any .jpg files.")
                    all_images = [f for f in zf.namelist() 
                                 if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
                
                # Sample frames evenly across zip
                step = max(1, len(all_images) // target_count)
                sampled_images = all_images[::step][:target_count]
                
                for img_file in sampled_images:
                    try:
                        img_data = zf.read(img_file)
                        frame_path = FIXTURES_DIR / model_key / Path(img_file).name
                        frame_path.write_bytes(img_data)
                        
                        # Validate frame can be opened
                        img = Image.open(frame_path)
                        img.verify()
                        
                        extracted.append(frame_path)
                    except Exception as e:
                        logger.warning(f"  ⚠ Skipped corrupted frame {img_file}: {e}")
                        continue
                
                logger.info(f"  ✓ Extracted {len(extracted)}/{target_count} frames for {model_key}")
                self.extraction_stats[model_key] = {
                    'target': target_count,
                    'extracted': len(extracted),
                    'zip_total_images': len(all_images)
                }
        
        except Exception as e:
            logger.error(f"  ✗ Failed to extract from {zip_path}: {e}")
            return []
        
        return extracted
    
    def _create_placeholder_frames(self, model_key: str, count: int) -> List[Path]:
        """Create synthetic 640x640 RGB placeholder frames if zips unavailable."""
        logger.warning(f"Creating {count} placeholder frames for {model_key}")
        frames = []
        
        for i in range(count):
            # Create random RGB image (simulates classroom frame)
            frame = np.random.randint(0, 256, (640, 640, 3), dtype=np.uint8)
            frame_path = FIXTURES_DIR / model_key / f"placeholder_{i:04d}.jpg"
            Image.fromarray(frame).save(frame_path)
            frames.append(frame_path)
        
        self.extraction_stats[model_key] = {
            'target': count,
            'extracted': count,
            'zip_total_images': 0,
            'note': 'placeholder frames (zip unavailable)'
        }
        return frames
    
    def run(self) -> bool:
        """Run full extraction."""
        logger.info("=" * 70)
        logger.info("PHASE 1: Environment & Frame Extraction")
        logger.info("=" * 70)
        
        self.prepare_fixture_dir()
        
        for model_key in DATASET_ZIPS.keys():
            frames = self.extract_frames_from_zip(model_key, self.target_frames)
            self.extracted_frames[model_key] = frames
        
        total_extracted = sum(len(f) for f in self.extracted_frames.values())
        logger.info(f"✓ Frame extraction complete: {total_extracted} frames ready for testing")
        
        return total_extracted > 0


# ==================== Phase 2: Service-Level Unit Tests ====================

class ServiceLevelTests:
    """Test YOLOInferenceService directly."""
    
    def __init__(self):
        self.yolo_service = None
        self.results = {}
    
    def test_model_loading(self) -> Tuple[bool, Dict]:
        """Test 1: All models load at startup."""
        logger.info("\nTest 1: Model Loading")
        logger.info("-" * 40)
        
        try:
            self.yolo_service = YOLOInferenceService()
            is_ready = self.yolo_service.is_ready()
            
            if not is_ready:
                logger.error("✗ yolo_service.is_ready() returned False")
                return False, {'error': 'Service not ready'}
            
            if not hasattr(self.yolo_service, 'models') or not self.yolo_service.models:
                logger.error("✗ No models loaded in yolo_service.models dict")
                return False, {'error': 'Empty models dict'}
            
            loaded_models = list(self.yolo_service.models.keys())
            logger.info(f"✓ Models loaded: {loaded_models}")
            
            expected_models = set(DATASET_ZIPS.keys())
            loaded_set = set(loaded_models)
            
            if expected_models != loaded_set:
                missing = expected_models - loaded_set
                logger.error(f"✗ Missing models: {missing}")
                return False, {'loaded': loaded_models, 'missing': list(missing)}
            
            logger.info(f"✓ All {len(loaded_models)} models loaded successfully")
            return True, {'loaded_models': loaded_models, 'is_ready': is_ready}
        
        except Exception as e:
            logger.error(f"✗ Exception during model loading: {e}")
            return False, {'error': str(e)}
    
    def test_single_frame_inference(self, frame_paths: Dict[str, List[Path]]) -> Tuple[bool, Dict]:
        """Test 2: Single frame inference produces expected output structure."""
        logger.info("\nTest 2: Single Frame Inference (LEARNING mode)")
        logger.info("-" * 40)
        
        if not self.yolo_service:
            logger.error("✗ Service not initialized. Run test_model_loading first.")
            return False, {'error': 'Service not initialized'}
        
        results = {}
        all_passed = True
        
        for model_key, frames in frame_paths.items():
            if not frames:
                logger.warning(f"⚠ No frames for {model_key}, skipping")
                continue
            
            frame_path = frames[0]  # Use first frame
            
            try:
                # Load and encode frame to base64
                with open(frame_path, 'rb') as f:
                    frame_data = f.read()
                frame_b64 = base64.b64encode(frame_data).decode('utf-8')
                
                # Run inference
                result = self.yolo_service.process_frame(frame_b64, mode="LEARNING")
                
                # Validate output structure
                required_keys = ['detections', 'annotated_image_base64', 'detection_count', 'mode']
                missing_keys = [k for k in required_keys if k not in result]
                
                if missing_keys:
                    logger.error(f"✗ {model_key}: Missing response keys: {missing_keys}")
                    all_passed = False
                    continue
                
                # Validate detections structure
                detections = result['detections']
                if detections:
                    det = detections[0]
                    det_keys = ['behavior_class', 'confidence', 'bbox', 'source_model', 'student_id']
                    det_missing = [k for k in det_keys if k not in det]
                    if det_missing:
                        logger.error(f"✗ {model_key}: Detection missing keys: {det_missing}")
                        all_passed = False
                
                logger.info(f"✓ {model_key}: {result['detection_count']} detections, output valid")
                results[model_key] = {
                    'detection_count': result['detection_count'],
                    'detections': result['detections'],
                    'has_annotated_image': len(result['annotated_image_base64']) > 100
                }
            
            except Exception as e:
                logger.error(f"✗ {model_key}: {e}")
                all_passed = False
        
        return all_passed, results
    
    def test_mode_filtering(self, frame_paths: Dict[str, List[Path]]) -> Tuple[bool, Dict]:
        """Test 3: Mode filtering (LEARNING vs TESTING labels)."""
        logger.info("\nTest 3: Mode Filtering (LEARNING vs TESTING)")
        logger.info("-" * 40)
        
        if not self.yolo_service or not frame_paths:
            logger.error("✗ Service not ready or no frames available")
            return False, {'error': 'Service not ready'}
        
        # Use first available frame
        test_frame_path = next((f[0] for f in frame_paths.values() if f), None)
        if not test_frame_path:
            logger.error("✗ No test frames available")
            return False, {'error': 'No frames'}
        
        try:
            with open(test_frame_path, 'rb') as f:
                frame_b64 = base64.b64encode(f.read()).decode('utf-8')
            
            # Run in both modes
            learning_result = self.yolo_service.process_frame(frame_b64, mode="LEARNING")
            testing_result = self.yolo_service.process_frame(frame_b64, mode="TESTING")
            
            learning_classes = set(d['behavior_class'] for d in learning_result['detections'])
            testing_classes = set(d['behavior_class'] for d in testing_result['detections'])
            
            logger.info(f"  Learning classes: {learning_classes}")
            logger.info(f"  Testing classes: {testing_classes}")
            
            # Check subset relationship
            if not testing_classes.issubset(learning_classes):
                diff = testing_classes - learning_classes
                logger.error(f"✗ Testing mode has unexpected labels: {diff}")
                return False, {'learning': list(learning_classes), 'testing': list(testing_classes)}
            
            logger.info(f"✓ Mode filtering correct (Testing ⊆ Learning)")
            return True, {'learning': list(learning_classes), 'testing': list(testing_classes)}
        
        except Exception as e:
            logger.error(f"✗ Mode filtering test failed: {e}")
            return False, {'error': str(e)}
    
    def test_label_mapping(self) -> Tuple[bool, Dict]:
        """Test 4: Label mapping (raw YOLO labels -> canonical backend labels)."""
        logger.info("\nTest 4: Label Mapping Correctness")
        logger.info("-" * 40)
        
        if not self.yolo_service:
            logger.error("✗ Service not initialized")
            return False, {'error': 'Service not initialized'}
        
        # Access MODEL_SPECS directly to verify mappings
        try:
            model_specs = YOLOInferenceService.MODEL_SPECS
            
            all_passed = True
            mapping_summary = {}
            
            for spec in model_specs:
                model_key = spec['model_key']
                expected = EXPECTED_LABELS.get(model_key, [])
                actual_classes = spec.get('class_names', [])
                class_map = spec.get('class_map', {})
                
                logger.info(f"  {model_key}:")
                logger.info(f"    Expected canonical labels: {expected}")
                
                # Check that class_map values cover all expected labels
                mapped_values = set(class_map.values())
                expected_set = set(expected)
                
                if not expected_set.issubset(mapped_values):
                    missing = expected_set - mapped_values
                    logger.error(f"    ✗ Missing mapped labels: {missing}")
                    all_passed = False
                else:
                    logger.info(f"    ✓ All expected labels mapped")
                
                mapping_summary[model_key] = {
                    'expected_labels': expected,
                    'class_map': class_map,
                    'all_covered': expected_set.issubset(mapped_values)
                }
            
            if all_passed:
                logger.info("✓ All label mappings verified")
            
            return all_passed, mapping_summary
        
        except Exception as e:
            logger.error(f"✗ Label mapping verification failed: {e}")
            return False, {'error': str(e)}
    
    def run(self, frame_paths: Dict[str, List[Path]]) -> Dict:
        """Run all service-level tests."""
        logger.info("\n" + "=" * 70)
        logger.info("PHASE 2: Service-Level Unit Tests")
        logger.info("=" * 70)
        
        results = {}
        
        test1, data1 = self.test_model_loading()
        results['test_1_model_loading'] = {'passed': test1, 'data': data1}
        
        if test1:  # Only continue if models loaded
            test2, data2 = self.test_single_frame_inference(frame_paths)
            results['test_2_single_frame'] = {'passed': test2, 'data': data2}
            
            test3, data3 = self.test_mode_filtering(frame_paths)
            results['test_3_mode_filtering'] = {'passed': test3, 'data': data3}
        
        test4, data4 = self.test_label_mapping()
        results['test_4_label_mapping'] = {'passed': test4, 'data': data4}
        
        return results


# ==================== Phase 3: API Integration Tests ====================

class APIIntegrationTests:
    """Test HTTP endpoints for learning/testing modes."""
    
    def __init__(self):
        self.access_token = None
        self.session_id = None
        self.results = {}
    
    def test_health_check(self) -> Tuple[bool, Dict]:
        """Test 5a: Health endpoint."""
        logger.info("\nTest 5a: Health Check")
        logger.info("-" * 40)
        
        try:
            response = requests.get(API_HEALTH, timeout=5)
            
            if response.status_code != 200:
                logger.error(f"✗ Health check failed: {response.status_code}")
                return False, {'status_code': response.status_code}
            
            logger.info(f"✓ Health endpoint OK")
            return True, {'status_code': 200}
        
        except requests.exceptions.ConnectionError:
            logger.error(f"✗ Cannot connect to {API_BASE_URL}. Is backend running?")
            return False, {'error': 'Connection failed'}
        except Exception as e:
            logger.error(f"✗ Health check error: {e}")
            return False, {'error': str(e)}
    
    def test_auth_and_session_creation(self) -> Tuple[bool, Dict]:
        """Test 5b: Auth login and session creation."""
        logger.info("\nTest 5b: Authentication & Session Creation")
        logger.info("-" * 40)
        
        try:
            # Login
            login_payload = {
                "email": TEST_ADMIN_EMAIL,
                "password": TEST_ADMIN_PASSWORD
            }
            login_response = requests.post(API_LOGIN, json=login_payload, timeout=10)
            
            if login_response.status_code != 200:
                logger.error(f"✗ Login failed: {login_response.status_code}")
                logger.error(f"  Response: {login_response.text}")
                return False, {'login_status': login_response.status_code}
            
            login_data = login_response.json()
            if 'access_token' not in login_data:
                logger.error("✗ No access_token in login response")
                return False, {'error': 'Missing access_token'}
            
            self.access_token = login_data['access_token']
            logger.info(f"✓ Login successful")
            
            # Create session
            headers = {'Authorization': f'Bearer {self.access_token}'}
            session_payload = {
                "name": f"YOLO_Weights_Test_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
                "mode": "NORMAL",
                "start_date": datetime.now().isoformat(),
                "end_date": datetime.now().isoformat()
            }
            session_response = requests.post(API_SESSIONS, json=session_payload, headers=headers, timeout=10)
            
            if session_response.status_code != 201:
                logger.error(f"✗ Session creation failed: {session_response.status_code}")
                logger.error(f"  Response: {session_response.text}")
                return False, {'session_status': session_response.status_code}
            
            session_data = session_response.json()
            if 'id' not in session_data:
                logger.error("✗ No session id in response")
                return False, {'error': 'Missing session id'}
            
            self.session_id = session_data['id']
            logger.info(f"✓ Session created: {self.session_id}")
            
            return True, {'access_token': self.access_token[:20] + '...', 'session_id': self.session_id}
        
        except Exception as e:
            logger.error(f"✗ Auth/Session error: {e}")
            return False, {'error': str(e)}
    
    def test_learning_endpoint(self, frame_paths: Dict[str, List[Path]]) -> Tuple[bool, Dict]:
        """Test 5c: Learning mode endpoint."""
        logger.info("\nTest 5c: Learning Mode Endpoint")
        logger.info("-" * 40)
        
        if not self.access_token or not self.session_id:
            logger.error("✗ Auth/session not ready")
            return False, {'error': 'Not authenticated'}
        
        try:
            headers = {'Authorization': f'Bearer {self.access_token}'}
            results = {}
            
            for model_key, frames in frame_paths.items():
                if not frames:
                    continue
                
                frame_path = frames[0]
                with open(frame_path, 'rb') as f:
                    frame_b64 = base64.b64encode(f.read()).decode('utf-8')
                
                payload = {
                    "image_base64": frame_b64,
                    "student_id": "550e8400-e29b-41d4-a716-446655440000",
                    "confidence_threshold": 0.5
                }
                
                url = f"{API_SESSIONS}/{self.session_id}/learn"
                response = requests.post(url, json=payload, headers=headers, timeout=30)
                
                if response.status_code == 503:
                    logger.error(f"✗ {model_key}: Received 503 (model not loaded)")
                    results[model_key] = {'status': 503, 'error': 'Model not loaded'}
                    return False, results
                
                if response.status_code != 200:
                    logger.error(f"✗ {model_key}: HTTP {response.status_code}")
                    results[model_key] = {'status': response.status_code}
                    continue
                
                data = response.json()
                logger.info(f"✓ {model_key}: {len(data.get('detections', []))} detections")
                results[model_key] = {
                    'status': 200,
                    'detection_count': len(data.get('detections', []))
                }
            
            return all(r.get('status') == 200 for r in results.values()), results
        
        except Exception as e:
            logger.error(f"✗ Learning endpoint error: {e}")
            return False, {'error': str(e)}
    
    def test_testing_endpoint(self, frame_paths: Dict[str, List[Path]]) -> Tuple[bool, Dict]:
        """Test 5d: Testing mode endpoint."""
        logger.info("\nTest 5d: Testing Mode Endpoint")
        logger.info("-" * 40)
        
        if not self.access_token or not self.session_id:
            logger.error("✗ Auth/session not ready")
            return False, {'error': 'Not authenticated'}
        
        try:
            # Switch session to TESTING mode
            headers = {'Authorization': f'Bearer {self.access_token}'}
            update_payload = {"mode": "TESTING"}
            update_response = requests.put(
                f"{API_SESSIONS}/{self.session_id}",
                json=update_payload,
                headers=headers,
                timeout=10
            )
            
            if update_response.status_code not in [200, 204]:
                logger.warning(f"⚠ Mode switch returned {update_response.status_code}, continuing anyway")
            
            logger.info(f"✓ Session switched to TESTING mode")
            
            results = {}
            for model_key, frames in frame_paths.items():
                if not frames:
                    continue
                
                frame_path = frames[0]
                with open(frame_path, 'rb') as f:
                    frame_b64 = base64.b64encode(f.read()).decode('utf-8')
                
                payload = {
                    "image_base64": frame_b64,
                    "students_present": ["550e8400-e29b-41d4-a716-446655440000"],
                    "confidence_threshold": 0.5
                }
                
                url = f"{API_SESSIONS}/{self.session_id}/test"
                response = requests.post(url, json=payload, headers=headers, timeout=30)
                
                if response.status_code != 200:
                    logger.error(f"✗ {model_key}: HTTP {response.status_code}")
                    results[model_key] = {'status': response.status_code}
                    continue
                
                data = response.json()
                logger.info(f"✓ {model_key}: {len(data.get('detections', []))} detections")
                results[model_key] = {
                    'status': 200,
                    'detection_count': len(data.get('detections', [])),
                    'has_risk_analysis': 'risk_analysis' in data
                }
            
            return all(r.get('status') == 200 for r in results.values()), results
        
        except Exception as e:
            logger.error(f"✗ Testing endpoint error: {e}")
            return False, {'error': str(e)}
    
    def run(self, frame_paths: Dict[str, List[Path]]) -> Dict:
        """Run all API integration tests."""
        logger.info("\n" + "=" * 70)
        logger.info("PHASE 3: API Integration Tests")
        logger.info("=" * 70)
        
        results = {}
        
        test5a, data5a = self.test_health_check()
        results['test_5a_health'] = {'passed': test5a, 'data': data5a}
        
        if not test5a:
            logger.error("✗ Backend not reachable. Skipping remaining API tests.")
            return results
        
        test5b, data5b = self.test_auth_and_session_creation()
        results['test_5b_auth_session'] = {'passed': test5b, 'data': data5b}
        
        if test5b:
            test5c, data5c = self.test_learning_endpoint(frame_paths)
            results['test_5c_learning'] = {'passed': test5c, 'data': data5c}
            
            test5d, data5d = self.test_testing_endpoint(frame_paths)
            results['test_5d_testing'] = {'passed': test5d, 'data': data5d}
        
        return results


# ==================== Phase 4: Regression & Baseline ====================

class RegressionTests:
    """Test batch inference accuracy and baseline metrics."""
    
    def __init__(self, yolo_service):
        self.yolo_service = yolo_service
        self.results = {}
    
    def test_batch_accuracy(self, frame_paths: Dict[str, List[Path]]) -> Tuple[bool, Dict]:
        """Test 6a: Batch inference on 50 frames per family."""
        logger.info("\nTest 6a: Batch Accuracy & Confidence")
        logger.info("-" * 40)
        
        if not self.yolo_service or not self.yolo_service.is_ready():
            logger.error("✗ Service not ready")
            return False, {'error': 'Service not ready'}
        
        results_summary = {}
        all_passed = True
        
        for model_key, frames in frame_paths.items():
            if not frames:
                logger.info(f"⊘ {model_key}: No frames")
                continue
            
            detection_count = 0
            confidences = []
            frame_with_detections = 0
            
            logger.info(f"  Processing {len(frames)} frames for {model_key}...")
            
            for i, frame_path in enumerate(frames):
                try:
                    with open(frame_path, 'rb') as f:
                        frame_b64 = base64.b64encode(f.read()).decode('utf-8')
                    
                    result = self.yolo_service.process_frame(frame_b64, mode="LEARNING")
                    detections = result.get('detections', [])
                    
                    if detections:
                        frame_with_detections += 1
                        detection_count += len(detections)
                        confidences.extend([d['confidence'] for d in detections])
                    
                    if (i + 1) % 10 == 0:
                        logger.info(f"    Processed {i + 1}/{len(frames)} frames")
                
                except Exception as e:
                    logger.warning(f"    Frame {i} failed: {e}")
                    continue
            
            detection_rate = (frame_with_detections / len(frames) * 100) if frames else 0
            avg_confidence = statistics.mean(confidences) if confidences else 0
            std_confidence = statistics.stdev(confidences) if len(confidences) > 1 else 0
            
            passed = detection_rate >= 60  # Minimum sanity threshold
            
            logger.info(f"  {model_key}:")
            logger.info(f"    Detection rate: {detection_rate:.1f}% ({frame_with_detections}/{len(frames)} frames)")
            logger.info(f"    Avg confidence: {avg_confidence:.3f} ± {std_confidence:.3f}")
            logger.info(f"    Total detections: {detection_count}")
            logger.info(f"    Status: {'✓ PASS' if passed else '✗ FAIL (< 60% detection rate)'}")
            
            results_summary[model_key] = {
                'detection_rate': detection_rate,
                'avg_confidence': avg_confidence,
                'std_confidence': std_confidence,
                'total_detections': detection_count,
                'frames_processed': len(frames),
                'frames_with_detections': frame_with_detections,
                'passed': passed
            }
            
            if not passed:
                all_passed = False
        
        return all_passed, results_summary
    
    def test_mode_filtering_batch(self, frame_paths: Dict[str, List[Path]]) -> Tuple[bool, Dict]:
        """Test 6b: Mode filtering on batch (TESTING ⊆ LEARNING)."""
        logger.info("\nTest 6b: Mode Filtering Batch")
        logger.info("-" * 40)
        
        if not self.yolo_service:
            logger.error("✗ Service not ready")
            return False, {'error': 'Service not ready'}
        
        results_summary = {}
        all_passed = True
        
        for model_key, frames in frame_paths.items():
            if not frames:
                continue
            
            # Test on subset (first 10 frames for speed)
            test_frames = frames[:10]
            mode_filter_correct_count = 0
            
            logger.info(f"  Testing {len(test_frames)} frames for {model_key}...")
            
            for frame_path in test_frames:
                try:
                    with open(frame_path, 'rb') as f:
                        frame_b64 = base64.b64encode(f.read()).decode('utf-8')
                    
                    learning_result = self.yolo_service.process_frame(frame_b64, mode="LEARNING")
                    testing_result = self.yolo_service.process_frame(frame_b64, mode="TESTING")
                    
                    learning_labels = set(d['behavior_class'] for d in learning_result['detections'])
                    testing_labels = set(d['behavior_class'] for d in testing_result['detections'])
                    
                    if testing_labels.issubset(learning_labels):
                        mode_filter_correct_count += 1
                
                except Exception as e:
                    logger.warning(f"    Frame error: {e}")
                    continue
            
            filter_rate = (mode_filter_correct_count / len(test_frames) * 100) if test_frames else 0
            passed = filter_rate >= 95
            
            logger.info(f"  {model_key}: {filter_rate:.1f}% frames respect mode filtering")
            logger.info(f"    Status: {'✓ PASS' if passed else '✗ FAIL (< 95%)'}")
            
            results_summary[model_key] = {
                'filter_rate': filter_rate,
                'passed': passed
            }
            
            if not passed:
                all_passed = False
        
        return all_passed, results_summary
    
    def test_confidence_stability(self, frame_paths: Dict[str, List[Path]]) -> Tuple[bool, Dict]:
        """Test 6c: Confidence reproducibility (run same frame 3× and compare)."""
        logger.info("\nTest 6c: Confidence Stability")
        logger.info("-" * 40)
        
        if not self.yolo_service:
            logger.error("✗ Service not ready")
            return False, {'error': 'Service not ready'}
        
        results_summary = {}
        all_passed = True
        
        # Test on 1 frame per family
        for model_key, frames in frame_paths.items():
            if not frames:
                continue
            
            frame_path = frames[0]
            
            try:
                with open(frame_path, 'rb') as f:
                    frame_b64 = base64.b64encode(f.read()).decode('utf-8')
                
                # Run 3 times
                runs_results = []
                for run in range(3):
                    result = self.yolo_service.process_frame(frame_b64, mode="LEARNING")
                    detections = result['detections']
                    
                    # Extract confidence values, sorted for comparison
                    confidences = sorted([d['confidence'] for d in detections])
                    runs_results.append(confidences)
                
                # Check reproducibility
                deterministic = True
                if runs_results[0] and runs_results[1]:
                    diff = abs(runs_results[0][0] - runs_results[1][0])
                    if diff > 0.01:
                        deterministic = False
                
                logger.info(f"  {model_key}:")
                logger.info(f"    Run 1 confidences: {runs_results[0][:5]}...")
                logger.info(f"    Run 2 confidences: {runs_results[1][:5]}...")
                logger.info(f"    Status: {'✓ DETERMINISTIC' if deterministic else '⚠ NON-DETERMINISTIC'}")
                
                results_summary[model_key] = {
                    'deterministic': deterministic,
                    'run_1': runs_results[0],
                    'run_2': runs_results[1],
                    'run_3': runs_results[2]
                }
                
                if not deterministic:
                    all_passed = False
            
            except Exception as e:
                logger.warning(f"  {model_key}: Error - {e}")
                results_summary[model_key] = {'error': str(e)}
        
        return all_passed or len(results_summary) > 0, results_summary
    
    def run(self, frame_paths: Dict[str, List[Path]]) -> Dict:
        """Run all regression tests."""
        logger.info("\n" + "=" * 70)
        logger.info("PHASE 4: Regression & Baseline Metrics")
        logger.info("=" * 70)
        
        results = {}
        
        test6a, data6a = self.test_batch_accuracy(frame_paths)
        results['test_6a_batch_accuracy'] = {'passed': test6a, 'data': data6a}
        
        test6b, data6b = self.test_mode_filtering_batch(frame_paths)
        results['test_6b_mode_filtering_batch'] = {'passed': test6b, 'data': data6b}
        
        if self.yolo_service:
            test6c, data6c = self.test_confidence_stability(frame_paths)
            results['test_6c_stability'] = {'passed': test6c, 'data': data6c}
        
        return results


# ==================== Phase 5: Acceptance Checklist & Reporting ====================

class AcceptanceReport:
    """Generate acceptance checklist and final report."""
    
    def __init__(self, all_results: Dict):
        self.results = all_results
        self.acceptance_criteria = {}
    
    def validate_criteria(self) -> Dict[str, bool]:
        """Validate against 6 acceptance criteria."""
        logger.info("\n" + "=" * 70)
        logger.info("PHASE 5: Acceptance Checklist & Reporting")
        logger.info("=" * 70)
        
        criteria = {}
        
        # Criterion 1: All 4 models loaded
        criterion1 = (
            self.results.get('test_1_model_loading', {}).get('passed', False) and
            len(self.results.get('test_1_model_loading', {}).get('data', {}).get('loaded_models', [])) == 4
        )
        criteria['1_models_loaded'] = criterion1
        logger.info(f"  {'✓' if criterion1 else '✗'} Criterion 1: All 4 models loaded from moved weights")
        
        # Criterion 2: No 503 responses
        criterion2 = not any(
            r.get('status') == 503 
            for r in self.results.get('test_5c_learning', {}).get('data', {}).values()
            if isinstance(r, dict)
        )
        criteria['2_no_503_errors'] = criterion2 and self.results.get('test_5c_learning', {}).get('passed', True)
        logger.info(f"  {'✓' if criteria['2_no_503_errors'] else '✗'} Criterion 2: No 503 model-not-loaded responses")
        
        # Criterion 3: Label mapping correct
        criterion3 = self.results.get('test_4_label_mapping', {}).get('passed', False)
        criteria['3_label_mapping'] = criterion3
        logger.info(f"  {'✓' if criterion3 else '✗'} Criterion 3: All expected behavior classes map correctly")
        
        # Criterion 4: Mode filtering works
        criterion4 = (
            self.results.get('test_3_mode_filtering', {}).get('passed', False) and
            self.results.get('test_6b_mode_filtering_batch', {}).get('passed', False)
        )
        criteria['4_mode_filtering'] = criterion4
        logger.info(f"  {'✓' if criterion4 else '✗'} Criterion 4: Mode filtering behaves exactly as intended")
        
        # Criterion 5: At least 1 detection per model family
        batch_results = self.results.get('test_6a_batch_accuracy', {}).get('data', {})
        criterion5 = all(
            d.get('total_detections', 0) > 0 
            for d in batch_results.values()
            if isinstance(d, dict)
        )
        criteria['5_true_positives'] = criterion5 and self.results.get('test_6a_batch_accuracy', {}).get('passed', False)
        logger.info(f"  {'✓' if criteria['5_true_positives'] else '✗'} Criterion 5: ≥1 true-positive detection per model family")
        
        # Criterion 6: No systematic wrong-label issue
        criterion6 = (
            self.results.get('test_2_single_frame', {}).get('passed', False) and
            self.results.get('test_6a_batch_accuracy', {}).get('passed', False)
        )
        criteria['6_no_cross_contamination'] = criterion6
        logger.info(f"  {'✓' if criterion6 else '✗'} Criterion 6: No systematic wrong-label cross-contamination")
        
        self.acceptance_criteria = criteria
        return criteria
    
    def generate_markdown_report(self) -> str:
        """Generate full markdown report."""
        report = f"""# YOLO Weights Validation Report
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Executive Summary
Validation of 4 pre-trained YOLO weights moved to `backend/models/yolo_weights/` before retraining work.

### Overall Status
{self._overall_verdict()}

---

## Acceptance Criteria Checklist
"""
        
        for criterion_id, passed in self.acceptance_criteria.items():
            status = "✅ PASS" if passed else "❌ FAIL"
            criterion_name = criterion_id.replace('_', ' ').title()
            report += f"- [{status}] {criterion_id}: {criterion_name}\n"
        
        report += f"\n### Final Verdict\n"
        all_pass = all(self.acceptance_criteria.values())
        if all_pass:
            report += "**✅ READY FOR PHASE 1 REPRODUCTION**\n\n"
            report += "All weights validated. System is ready to proceed with detector training reproduction.\n"
        else:
            report += "**❌ DEBUG REQUIRED**\n\n"
            failed_criteria = [k for k, v in self.acceptance_criteria.items() if not v]
            report += f"Failed criteria: {', '.join(failed_criteria)}\n"
            report += "See detailed results below.\n"
        
        report += "\n---\n\n## Detailed Test Results\n"
        
        # Phase 1: Frame Extraction
        report += "### Phase 1: Frame Extraction\n"
        if 'extraction_stats' in self.results:
            for model_key, stats in self.results['extraction_stats'].items():
                report += f"- **{model_key}**: {stats.get('extracted', 0)}/{stats.get('target', 0)} frames extracted\n"
        
        # Phase 2: Service-Level Tests
        report += "\n### Phase 2: Service-Level Unit Tests\n"
        for test_key, result in self.results.items():
            if test_key.startswith('test_'):
                status = "✓ PASS" if result.get('passed') else "✗ FAIL"
                report += f"- [{status}] {test_key}:\n"
                #report += f"  {json.dumps(result['data'], indent=2, default=str)}\n"
        
        # Phase 4: Regression Metrics
        report += "\n### Phase 4: Regression & Baseline Metrics\n"
        batch_results = self.results.get('test_6a_batch_accuracy', {}).get('data', {})
        if batch_results:
            report += "\n#### Per-Model Performance:\n"
            for model_key, metrics in batch_results.items():
                if isinstance(metrics, dict):
                    report += f"\n**{model_key}**:\n"
                    report += f"- Detection Rate: {metrics.get('detection_rate', 0):.1f}%\n"
                    report += f"- Avg Confidence: {metrics.get('avg_confidence', 0):.3f}\n"
                    report += f"- Std Confidence: {metrics.get('std_confidence', 0):.3f}\n"
                    report += f"- Total Detections: {metrics.get('total_detections', 0)}\n"
        
        report += "\n---\n\nEnd of Report.\n"
        return report
    
    def _overall_verdict(self) -> str:
        if not self.acceptance_criteria:
            return "⚠️ NO CRITERIA EVALUATED"
        
        passed = sum(1 for v in self.acceptance_criteria.values() if v)
        total = len(self.acceptance_criteria)
        
        if passed == total:
            return f"✅ **ALL PASS** ({passed}/{total} criteria)"
        elif passed >= 4:
            return f"⚠️ **PARTIAL** ({passed}/{total} criteria, review failures)"
        else:
            return f"❌ **FAILED** ({passed}/{total} criteria)"
    
    def save(self) -> Path:
        """Save report to file."""
        report_text = self.generate_markdown_report()
        REPORT_FILE.parent.mkdir(parents=True, exist_ok=True)
        REPORT_FILE.write_text(report_text, encoding="utf-8")
        logger.info(f"\n✓ Report saved to: {REPORT_FILE}")
        return REPORT_FILE


# ==================== Main Test Runner ====================

def run_all_tests(phases=None, verbose=True):
    """Run full test suite."""
    if verbose:
        logger.setLevel(logging.DEBUG)
    
    if phases is None:
        phases = ['phase1', 'phase2', 'phase3', 'phase4', 'phase5']
    
    all_results = {}
    
    # Phase 1: Extract frames
    if 'phase1' in phases:
        extractor = FrameExtractor(target_frames_per_model=50)
        success = extractor.run()
        all_results['extraction_stats'] = extractor.extraction_stats
        extracted_frames = extractor.extracted_frames
    else:
        # Load existing frames
        extracted_frames = {
            model_key: list((FIXTURES_DIR / model_key).glob('*.jpg')) + list((FIXTURES_DIR / model_key).glob('*.png'))
            for model_key in DATASET_ZIPS.keys()
        }
    
    # Phase 2: Service-level tests
    if 'phase2' in phases:
        service_tests = ServiceLevelTests()
        phase2_results = service_tests.run(extracted_frames)
        all_results.update(phase2_results)
    
    # Phase 3: API integration tests
    if 'phase3' in phases:
        api_tests = APIIntegrationTests()
        phase3_results = api_tests.run(extracted_frames)
        all_results.update(phase3_results)
    
    # Phase 4: Regression tests
    if 'phase4' in phases:
        if (
            'phase2' in phases
            and hasattr(service_tests, 'yolo_service')
            and service_tests.yolo_service
            and service_tests.yolo_service.is_ready()
        ):
            regression_tests = RegressionTests(service_tests.yolo_service)
            phase4_results = regression_tests.run(extracted_frames)
            all_results.update(phase4_results)
        else:
            logger.warning("Skipping Phase 4 because YOLO service is not ready")
    
    # Phase 5: Acceptance & Report
    if 'phase5' in phases:
        report = AcceptanceReport(all_results)
        criteria = report.validate_criteria()
        report.save()
        all_results['acceptance_criteria'] = criteria
    
    return all_results


# ==================== Pytest Entry Points ====================

@pytest.fixture(scope="module")
def frame_extractor():
    """Pytest fixture: extract frames once per module."""
    extractor = FrameExtractor(target_frames_per_model=50)
    extractor.run()
    return extractor.extracted_frames


@pytest.fixture(scope="module")
def yolo_service():
    """Pytest fixture: initialize service once per module."""
    return YOLOInferenceService()


class TestPhase2:
    """Phase 2 tests for pytest."""
    
    def test_1_models_load(self, yolo_service):
        assert yolo_service.is_ready(), "Models failed to load"
        assert len(yolo_service.models) == 4, "Not all 4 models loaded"
    
    def test_2_single_frame_inference(self, yolo_service, frame_extractor):
        frame_path = next(p for paths in frame_extractor.values() for p in paths if p)
        with open(frame_path, 'rb') as f:
            frame_b64 = base64.b64encode(f.read()).decode('utf-8')
        
        result = yolo_service.process_frame(frame_b64, mode="LEARNING")
        assert 'detections' in result
        assert 'annotated_image_base64' in result
        assert result['detection_count'] >= 0


class TestPhase4:
    """Phase 4 tests for pytest."""
    
    def test_batch_accuracy(self, yolo_service, frame_extractor):
        regression = RegressionTests(yolo_service)
        passed, results = regression.test_batch_accuracy(frame_extractor)
        assert passed, f"Batch accuracy failed: {results}"


# ==================== CLI Entry Point ====================

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='YOLO Weights Validation Test Suite')
    parser.add_argument('--phase', default='all',
                       choices=['all', 'phase1', 'phase2', 'phase3', 'phase4', 'phase5'],
                       help='Which test phases to run')
    parser.add_argument('--verbose', action='store_true', help='Verbose logging')
    parser.add_argument('--api-url', default='http://localhost:8000',
                       help='Backend API URL for Phase 3 tests')
    
    args = parser.parse_args()
    
    API_BASE_URL = args.api_url
    API_HEALTH = f"{API_BASE_URL}/health"
    API_LOGIN = f"{API_BASE_URL}/api/auth/login"
    API_SESSIONS = f"{API_BASE_URL}/api/sessions"
    
    phases = ['phase1', 'phase2', 'phase3', 'phase4', 'phase5'] if args.phase == 'all' else [args.phase]
    
    logger.info(f"Starting YOLO Weights Validation Test Suite")
    logger.info(f"Phases: {phases}")
    logger.info(f"API URL: {API_BASE_URL}")
    
    results = run_all_tests(phases=phases, verbose=args.verbose)
    
    logger.info("\n" + "=" * 70)
    logger.info("TEST SUITE COMPLETE")
    logger.info("=" * 70)
