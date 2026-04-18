"""
YOLO inference service for behavior detection in classroom frames.
- Loads YOLOv8 model
- Runs inference on base64 images
- Extracts behavior detections
- Annotates images with bounding boxes and labels
"""

import base64
import io
from pathlib import Path
from typing import Any, Dict, List, Optional
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import logging
from types import SimpleNamespace

logger = logging.getLogger(__name__)


class _ModelLoadError(RuntimeError):
    pass


class YOLOInferenceService:
    """
    Wrapper around YOLO for classroom behavior detection.
    Maps YOLO classes to behavior types.
    """

    LEARNING_STUDENT_LABELS = {
        "HAND_RAISING",
        "READ",
        "WRITE",
        "BOW_THE_HEAD",
        "TALK",
        "STAND",
        "ANSWER",
        "ON_STAGE_INTERACTION",
        "DISCUSS",
        "YAWN",
        "CLAP",
        "LEANING_ON_DESK",
        "USING_PHONE",
        "USING_COMPUTER",
    }

    LEARNING_TEACHER_LABELS = {
        "GUIDE",
        "ANSWER",
        "ON_STAGE_INTERACTION",
        "BLACKBOARD_WRITING",
        "TEACHER",
        "STAND",
        "USING_COMPUTER",
        "BLACKBOARD",
    }

    TESTING_LABELS = {
        "TURN_THE_HEAD",
        "TALK",
        "DISCUSS",
        "USING_PHONE",
        "USING_COMPUTER",
    }

    LABEL_ALIASES = {
        "DISCUSS": ["TALK"],
    }

    COLOR_MAP = {
        "HAND_RAISING": (0, 255, 127),
        "READ": (0, 255, 0),
        "WRITE": (0, 220, 0),
        "BOW_THE_HEAD": (255, 255, 0),
        "TURN_THE_HEAD": (255, 235, 59),
        "DISCUSS": (255, 165, 0),
        "TALK": (255, 140, 0),
        "STAND": (0, 191, 255),
        "ANSWER": (30, 144, 255),
        "ON_STAGE_INTERACTION": (72, 209, 204),
        "GUIDE": (46, 139, 87),
        "BLACKBOARD_WRITING": (33, 150, 243),
        "BLACKBOARD": (100, 149, 237),
        "TEACHER": (50, 205, 50),
        "USING_COMPUTER": (186, 104, 200),
        "USING_PHONE": (220, 20, 60),
        "YAWN": (255, 193, 7),
        "CLAP": (255, 215, 0),
        "LEANING_ON_DESK": (205, 133, 63),
    }

    # Canonical labels from all available model classes in YOLO/SCB-Dataset.
    MODEL_SPECS: List[Dict[str, Any]] = [
        {
            "model_key": "student_bow_turn",
            "actor_type": "STUDENT",
            "relative_weight_path": [
                "yolo_weights",
                "student_bow_turn",
                "best.pt",
            ],
            "class_names": ["BowHead", "TurnHead"],
            "class_map": {
                "BowHead": "BOW_THE_HEAD",
                "TurnHead": "TURN_THE_HEAD",
            },
        },
        {
            "model_key": "student_discuss",
            "actor_type": "STUDENT",
            "relative_weight_path": [
                "yolo_weights",
                "student_discuss",
                "best.pt",
            ],
            "class_names": ["discuss"],
            "class_map": {
                "discuss": "DISCUSS",
            },
        },
        {
            "model_key": "student_hand_read_write",
            "actor_type": "STUDENT",
            "relative_weight_path": [
                "yolo_weights",
                "student_hand_read_write",
                "best.pt",
            ],
            "class_names": ["hand-raising", "read", "write"],
            "class_map": {
                "hand-raising": "HAND_RAISING",
                "read": "READ",
                "write": "WRITE",
            },
        },
        {
            "model_key": "teacher_behavior",
            "actor_type": "TEACHER",
            "relative_weight_path": [
                "yolo_weights",
                "teacher_behavior",
                "best.pt",
            ],
            "class_names": [
                "guide",
                "answer",
                "On-stage interaction",
                "blackboard-writing",
                "teacher",
                "stand",
                "screen",
                "blackBoard",
            ],
            "class_map": {
                "guide": "GUIDE",
                "answer": "ANSWER",
                "On-stage interaction": "ON_STAGE_INTERACTION",
                "blackboard-writing": "BLACKBOARD_WRITING",
                "teacher": "TEACHER",
                "stand": "STAND",
                "screen": "USING_COMPUTER",
                "blackBoard": "BLACKBOARD",
            },
        },
    ]

    def __init__(self):
        """Initialize all configured YOLO models."""
        self.models: Dict[str, Dict[str, Any]] = {}
        try:
            for spec in self.MODEL_SPECS:
                loaded_model = self._load_model_for_spec(spec)
                if loaded_model is None:
                    continue

                self.models[spec["model_key"]] = loaded_model
        except Exception as e:
            logger.error(f"Failed to load YOLO model: {e}")
            self.models = {}

        if not self.models:
            logger.warning("No YOLO models loaded. Inference endpoints will fail until paths are valid.")

        # NOTE: Requested labels like USING_PHONE/YAWN/CLAP/LEANING_ON_DESK are not present
        # in the selected 4 model class lists, so they cannot be detected without retraining.
        logger.warning(
            "Selected models do not include direct classes for USING_PHONE, YAWN, CLAP, LEANING_ON_DESK."
        )

    def _load_model_for_spec(self, spec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        model_path = self._resolve_model_path(spec["relative_weight_path"])
        if not model_path:
            logger.warning(
                "Skipping model %s because best.pt was not found",
                spec["model_key"],
            )
            return None

        try:
            from ultralytics import YOLO

            model = YOLO(str(model_path))

            # If Ultralytics reconstructed a legacy YOLOv7 class from pickle,
            # its runtime API may not satisfy the Ultralytics predictor stack.
            # In that case, use our explicit legacy wrapper instead.
            inner_model = getattr(model, "model", None)
            inner_module = getattr(getattr(inner_model, "__class__", None), "__module__", "")
            if isinstance(inner_module, str) and inner_module.startswith("models.yolo"):
                raise _ModelLoadError(
                    "Checkpoint resolved to legacy models.yolo.* classes; switching to legacy loader"
                )

            logger.info("YOLOv8 loader succeeded for %s", spec["model_key"])
            return {
                "model": model,
                "class_names": spec["class_names"],
                "class_map": spec["class_map"],
                "actor_type": spec["actor_type"],
                "model_path": str(model_path),
                "loader": "ultralytics",
            }
        except Exception as ultralytics_error:
            logger.warning(
                "Ultralytics loader failed for %s: %s. Trying legacy YOLOv7 compatibility loader.",
                spec["model_key"],
                ultralytics_error,
            )

        try:
            from models.yolo import load_legacy_yolov7_detector

            legacy_model = load_legacy_yolov7_detector(model_path, names=spec["class_names"])
            logger.info("Legacy YOLOv7 loader succeeded for %s", spec["model_key"])
            return {
                "model": legacy_model,
                "class_names": spec["class_names"],
                "class_map": spec["class_map"],
                "actor_type": spec["actor_type"],
                "model_path": str(model_path),
                "loader": "legacy_yolov7",
            }
        except Exception as legacy_error:
            logger.error(
                "Failed to load YOLO model %s via both loaders: %s",
                spec["model_key"],
                legacy_error,
            )
            return None

    def _resolve_model_path(self, relative_path: List[str]) -> Optional[Path]:
        """Resolve weight path from common workspace/container roots."""
        repo_root = Path(__file__).resolve().parents[3]
        candidates = [
            repo_root.joinpath("backend", "models", *relative_path),
            repo_root.joinpath("models", *relative_path),
            repo_root.joinpath(*relative_path),
            Path("/app", "models").joinpath(*relative_path),
            Path("/app", "backend", "models").joinpath(*relative_path),
            Path(*relative_path),
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return None

    def _get_active_mode(self, mode: Optional[str], student_id: Optional[str]) -> str:
        """
        Resolve mode while keeping backward compatibility:
        - explicit mode wins
        - otherwise infer TESTING when no student_id is passed
        - default to LEARNING
        """
        if mode:
            normalized = mode.strip().upper()
            if normalized in {"LEARNING", "TESTING"}:
                return normalized
        if student_id is None:
            return "TESTING"
        return "LEARNING"

    def _allowed_labels_for_mode(self, mode: str) -> set:
        if mode == "TESTING":
            return set(self.TESTING_LABELS)
        return set(self.LEARNING_STUDENT_LABELS) | set(self.LEARNING_TEACHER_LABELS)

    def _models_for_mode(self, mode: str) -> List[str]:
        # Keep testing lightweight by skipping the hand/read/write detector.
        if mode == "TESTING":
            return ["student_bow_turn", "student_discuss", "teacher_behavior"]
        return [
            "student_bow_turn",
            "student_discuss",
            "student_hand_read_write",
            "teacher_behavior",
        ]

    @staticmethod
    def _safe_raw_label(class_names: List[str], class_id: int) -> str:
        if 0 <= class_id < len(class_names):
            return class_names[class_id]
        return f"class_{class_id}"

    def is_ready(self) -> bool:
        """Check if model is loaded and ready."""
        return bool(self.models)

    def decode_base64_image(self, image_base64: str) -> Image.Image:
        """
        Decode base64 string to PIL Image.
        
        Args:
            image_base64: Base64 encoded image string (without data: prefix)
            
        Returns:
            PIL Image object
        """
        try:
            # Remove data URI prefix if present
            if "," in image_base64:
                image_base64 = image_base64.split(",")[1]

            image_data = base64.b64decode(image_base64)
            image = Image.open(io.BytesIO(image_data)).convert("RGB")
            return image
        except Exception as e:
            logger.error(f"Failed to decode base64 image: {e}")
            raise ValueError(f"Invalid base64 image: {e}")

    def run_inference(
        self,
        image: Image.Image,
        conf_threshold: float = 0.5,
        mode: str = "LEARNING",
    ) -> List[Dict]:
        """
        Run YOLO inference on image.
        
        Args:
            image: PIL Image object
            conf_threshold: Confidence threshold (0-1)
            
        Returns:
            List of detections: [{
                "class": "CHEATING",
                "confidence": 0.92,
                "bbox": [x, y, w, h],  # Normalized 0-1
                "student_id": "auto-generated-or-provided"
            }]
        """
        if not self.is_ready():
            raise RuntimeError("YOLO models not loaded")

        try:
            # Convert PIL to numpy array
            image_array = np.array(image)

            detections = []
            allowed_labels = self._allowed_labels_for_mode(mode)
            enabled_model_keys = self._models_for_mode(mode)
            detection_idx = 0

            for model_key in enabled_model_keys:
                model_entry = self.models.get(model_key)
                if not model_entry:
                    continue

                results = model_entry["model"](image_array, conf=conf_threshold, verbose=False)
                class_names = model_entry["class_names"]
                class_map = model_entry["class_map"]
                actor_type = model_entry["actor_type"]

                for result in results:
                    for box in result.boxes:
                        confidence = float(box.conf[0])
                        class_id = int(box.cls[0])
                        raw_label = self._safe_raw_label(class_names, class_id)
                        behavior_class = class_map.get(raw_label, raw_label.upper().replace("-", "_"))

                        if behavior_class not in allowed_labels:
                            continue

                        # Get normalized bbox (0-1)
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        img_w, img_h = image.size

                        x_norm = x1 / img_w
                        y_norm = y1 / img_h
                        w_norm = (x2 - x1) / img_w
                        h_norm = (y2 - y1) / img_h

                        detection = {
                            "behavior_class": behavior_class,
                            "behavior_aliases": self.LABEL_ALIASES.get(behavior_class, []),
                            "raw_label": raw_label,
                            "actor_type": actor_type,
                            "source_model": model_key,
                            "confidence": round(confidence, 3),
                            "bbox": [round(x, 3) for x in [x_norm, y_norm, w_norm, h_norm]],
                            "bbox_pixels": [x1, y1, x2, y2],
                            "student_id": f"detected_{detection_idx}",
                        }

                        detections.append(detection)
                        detection_idx += 1
            
            logger.info(f"Inference complete: {len(detections)} detections")
            return detections

        except Exception as e:
            logger.error(f"YOLO inference failed: {e}")
            raise RuntimeError(f"Inference error: {e}")

    def annotate_image(
        self,
        image: Image.Image,
        detections: List[Dict],
        include_confidence: bool = True,
    ) -> Image.Image:
        """
        Draw bounding boxes and labels on image.
        
        Args:
            image: PIL Image object
            detections: List of detection objects
            include_confidence: Include confidence score in label
            
        Returns:
            Annotated PIL Image
        """
        image_copy = image.copy()
        draw = ImageDraw.Draw(image_copy)
        
        try:
            # Try to load a TTF font, fallback to default
            font = ImageFont.truetype("arial.ttf", 15)
        except:
            font = ImageFont.load_default()
        
        for detection in detections:
            x1, y1, x2, y2 = detection["bbox_pixels"]
            behavior_class = detection["behavior_class"]
            confidence = detection["confidence"]
            
            # Get color for this behavior class
            color = self.COLOR_MAP.get(behavior_class, (255, 255, 255))
            
            # Draw bounding box
            draw.rectangle([x1, y1, x2, y2], outline=color, width=2)
            
            # Draw label
            label = behavior_class
            if include_confidence:
                label = f"{behavior_class} {confidence:.1%}"
            
            # Background for text
            bbox = draw.textbbox((x1, y1), label, font=font)
            draw.rectangle(bbox, fill=color)
            
            # Draw text
            draw.text((x1, y1), label, fill="white", font=font)
        
        return image_copy

    def encode_image_to_base64(self, image: Image.Image, format: str = "PNG") -> str:
        """
        Encode PIL Image to base64 string.
        
        Args:
            image: PIL Image object
            format: Image format (PNG, JPEG)
            
        Returns:
            Base64 encoded image string
        """
        buffer = io.BytesIO()
        image.save(buffer, format=format)
        image_data = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/{format.lower()};base64,{image_data}"

    def process_frame(
        self,
        image_base64: str,
        conf_threshold: float = 0.5,
        student_id: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> Dict:
        """
        End-to-end frame processing:
        1. Decode base64 image
        2. Run YOLO inference
        3. Annotate image
        4. Encode result
        
        Args:
            image_base64: Base64 encoded frame
            conf_threshold: Confidence threshold
            student_id: Optional student ID to assign to detections
            
        Returns:
            {
                "detections": [...],
                "annotated_image_base64": "data:image/png;base64,...",
                "detection_count": 5
            }
        """
        try:
            # Decode
            image = self.decode_base64_image(image_base64)
            active_mode = self._get_active_mode(mode, student_id)
            
            # Infer
            detections = self.run_inference(
                image,
                conf_threshold=conf_threshold,
                mode=active_mode,
            )
            
            # Assign student_id if provided
            if student_id:
                for detection in detections:
                    detection["student_id"] = student_id
            
            # Annotate
            annotated_image = self.annotate_image(image, detections)
            
            # Encode
            annotated_base64 = self.encode_image_to_base64(annotated_image)
            
            return {
                "detections": detections,
                "annotated_image_base64": annotated_base64,
                "detection_count": len(detections),
                "mode": active_mode,
            }
        
        except Exception as e:
            logger.error(f"Frame processing failed: {e}")
            raise RuntimeError(f"Failed to process frame: {e}")

    def batch_process_frames(
        self,
        frames: List[Dict],  # [{image_base64, student_id?}, ...]
        conf_threshold: float = 0.5,
        mode: Optional[str] = None,
    ) -> List[Dict]:
        """
        Process multiple frames (for batch analysis).
        
        Args:
            frames: List of frame data
            conf_threshold: Confidence threshold
            
        Returns:
            List of processed results
        """
        results = []
        
        for frame in frames:
            try:
                result = self.process_frame(
                    frame["image_base64"],
                    conf_threshold,
                    frame.get("student_id"),
                    mode,
                )
                results.append(result)
            except Exception as e:
                logger.error(f"Failed to process frame: {e}")
                results.append({"error": str(e)})
        
        return results
