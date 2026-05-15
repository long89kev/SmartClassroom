"""YOLO inference service for classroom behavior detection using retrained YOLO26 weights.

This module keeps the same public service surface as the legacy inference wrapper,
but loads the retrained YOLO26 checkpoints instead of the legacy YOLOv7 models.
"""

from __future__ import annotations

import base64
import io
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger(__name__)


class _ModelLoadError(RuntimeError):
    pass


class YOLOInferenceService:
    """Wrapper around YOLO26 for classroom behavior detection."""

    INFERENCE_IMGSZ = 640

    # Dynamically configure ONNX Runtime / BLAS thread count based on CPU cores
    # to balance throughput vs. CPU thrashing on multi-core systems and Docker.
    # Formula: min(max(2, cores // 4), 8)  →  2-core=2, 8-core=2, 16-core=4, 32+=8
    import os as _os
    _INTRA_THREADS = str(min(max(2, (_os.cpu_count() or 2) // 4), 8))
    _os.environ.setdefault("OMP_NUM_THREADS", _INTRA_THREADS)
    _os.environ.setdefault("MKL_NUM_THREADS", _INTRA_THREADS)
    _os.environ.setdefault("NUMEXPR_NUM_THREADS", _INTRA_THREADS)
    _os.environ.setdefault("OPENBLAS_NUM_THREADS", _INTRA_THREADS)

    LEARNING_STUDENT_LABELS = {
        "HAND_RAISING",
        "READ",
        "WRITE",
        "BOW_THE_HEAD",
        "ANSWER",
        "ON_STAGE_INTERACTION",
        "DISCUSS",
    }

    LEARNING_TEACHER_LABELS = {
        "GUIDE",
        "TEACHER",
        "ANSWER",
        "ON_STAGE_INTERACTION",
    }

    TESTING_LABELS = {
        "TURN_THE_HEAD",
        "DISCUSS",
        "ANSWER",
    }

    LABEL_ALIASES = {}
    
    COLOR_MAP = {
        "HAND_RAISING": (0, 255, 127),
        "READ": (0, 255, 0),
        "WRITE": (0, 220, 0),
        "BOW_THE_HEAD": (255, 255, 0),
        "TURN_THE_HEAD": (255, 235, 59),
        "DISCUSS": (255, 165, 0),
        "ANSWER": (30, 144, 255),
        "ON_STAGE_INTERACTION": (72, 209, 204),
        "GUIDE": (46, 139, 87),
        "TEACHER": (50, 205, 50),
    }

    MODEL_SPECS: List[Dict[str, Any]] = [
        {
            "model_key": "student_bow_turn_discuss",
            "actor_type": "STUDENT",
            "weight_candidates": [
                ["backend", "models", "yolo_weights", "student_bow_turn_discuss", "best.onnx"],
                ["backend", "models", "yolo_weights", "student_bow_turn_discuss", "best.pt"],
                ["models", "yolo_weights", "student_bow_turn_discuss", "best.onnx"],
                ["models", "yolo_weights", "student_bow_turn_discuss", "best.pt"],
            ],
            "class_names": ["BowHead", "TurnHead", "discuss"],
            "class_map": {
                "BowHead": "BOW_THE_HEAD",
                "TurnHead": "TURN_THE_HEAD",
                "discuss": "DISCUSS",
            },
        },
        {
            "model_key": "student_hand_read_write",
            "actor_type": "STUDENT",
            "weight_candidates": [
                ["backend", "models", "yolo_weights", "student_hand_read_write", "best.onnx"],
                ["backend", "models", "yolo_weights", "student_hand_read_write", "best.pt"],
                ["backend", "models", "yolo_weights", "student_hand_read_write", "exp", "weights", "best.pt"],
                ["models", "yolo_weights", "student_hand_read_write", "best.onnx"],
                ["models", "yolo_weights", "student_hand_read_write", "best.pt"],
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
            "weight_candidates": [
                ["backend", "models", "yolo_weights", "teacher_behavior", "best.onnx"],
                ["backend", "models", "yolo_weights", "teacher_behavior", "best.pt"],
                ["backend", "models", "yolo_weights", "teacher_behavior", "exp", "weights", "best.pt"],
                ["models", "yolo_weights", "teacher_behavior", "best.onnx"],
                ["models", "yolo_weights", "teacher_behavior", "best.pt"],
            ],
            "class_names": ["guide", "answer", "On-stage interaction", "teacher"],
            "class_map": {
                "guide": "GUIDE",
                "answer": "ANSWER",
                "On-stage interaction": "ON_STAGE_INTERACTION",
                "teacher": "TEACHER",
            },
        },
    ]

    def __init__(self):
        self.models: Dict[str, Dict[str, Any]] = {}
        try:
            for spec in self.MODEL_SPECS:
                loaded_model = self._load_model_for_spec(spec)
                if loaded_model is None:
                    continue
                self.models[spec["model_key"]] = loaded_model
        except Exception as exc:
            logger.error("Failed to load YOLO model: %s", exc)
            self.models = {}

        if not self.models:
            logger.warning("No YOLO models loaded. Inference endpoints will fail until paths are valid.")

    def _load_model_for_spec(self, spec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        model_path = self._resolve_model_path(spec["weight_candidates"])
        if not model_path:
            logger.warning("Skipping model %s because best.pt was not found", spec["model_key"])
            return None

        logger.info("Loading YOLO26 model %s from %s", spec["model_key"], model_path)

        try:
            from ultralytics import YOLO

            model = YOLO(str(model_path))
            logger.info("Ultralytics YOLO loader succeeded for %s", spec["model_key"])
            return {
                "model": model,
                "class_names": spec["class_names"],
                "class_map": spec["class_map"],
                "actor_type": spec["actor_type"],
                "model_path": str(model_path),
                "loader": "ultralytics_yolo26",
            }
        except Exception as exc:
            logger.error("Failed to load YOLO26 model %s: %s", spec["model_key"], exc)
            return None

    # Ordered list of root directories to search for model weights.
    # Populated lazily to support both local dev and Docker container layouts.
    _SEARCH_ROOTS: List[Path] = []

    @classmethod
    def _get_search_roots(cls) -> List[Path]:
        """Return root dirs for weight resolution (repo root, Docker /app, etc.)."""
        if not cls._SEARCH_ROOTS:
            repo_root = Path(__file__).resolve().parents[3]
            cls._SEARCH_ROOTS = [
                repo_root,
                Path("/app"),              # Docker WORKDIR
                Path("/app") / "backend",  # Docker alt layout
            ]
        return cls._SEARCH_ROOTS

    def _resolve_model_path(self, relative_paths: List[List[str]]) -> Optional[Path]:
        """Resolve weight path from common workspace/container roots."""
        roots = self._get_search_roots()
        candidates: List[Path] = []

        for path_parts in relative_paths:
            for root in roots:
                candidates.append(root.joinpath(*path_parts))
                # Try with "backend" prefix stripped (if present) or added (if absent)
                if path_parts[:1] == ["backend"]:
                    candidates.append(root.joinpath(*path_parts[1:]))
                else:
                    candidates.append(root / "backend" / Path(*path_parts))

        for candidate in candidates:
            if candidate.exists() and candidate.is_file():
                return candidate
            if candidate.exists() and candidate.is_dir():
                best_onnx = candidate / "best.onnx"
                if best_onnx.exists():
                    return best_onnx
                best_pt = candidate / "best.pt"
                if best_pt.exists():
                    return best_pt
                exp_pt = candidate / "exp" / "weights" / "best.pt"
                if exp_pt.exists():
                    return exp_pt
                nested_pt = candidate / "exp" / "exp" / "weights" / "best.pt"
                if nested_pt.exists():
                    return nested_pt
        return None

    def _get_active_mode(self, mode: Optional[str], student_id: Optional[str]) -> str:
        """Resolve mode while keeping backward compatibility."""
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
        if mode == "TESTING":
            return ["student_bow_turn_discuss", "teacher_behavior"]
        return [
            "student_bow_turn_discuss",
            "student_hand_read_write",
            "teacher_behavior",
        ]

    @staticmethod
    def _safe_raw_label(class_names: List[str], class_id: int) -> str:
        if 0 <= class_id < len(class_names):
            return class_names[class_id]
        return f"class_{class_id}"

    @staticmethod
    def _allowed_class_ids_for_model(
        model_entry: Dict[str, Any], allowed_labels: set
    ) -> Optional[List[int]]:
        """Map allowed behavior labels back to model class IDs for early NMS filtering.

        Returns a list of integer class IDs that should be kept, or ``None``
        if every class in the model is allowed (no filtering needed).
        """
        class_names = model_entry["class_names"]
        class_map = model_entry["class_map"]
        ids = []
        for idx, raw_name in enumerate(class_names):
            mapped = class_map.get(raw_name, raw_name.upper().replace("-", "_"))
            if mapped in allowed_labels:
                ids.append(idx)
        # Return None when all classes pass — avoids an unnecessary filter
        return ids if len(ids) < len(class_names) else None

    def is_ready(self) -> bool:
        return bool(self.models)

    def decode_base64_image(self, image_base64: str) -> Image.Image:
        try:
            if "," in image_base64:
                image_base64 = image_base64.split(",")[1]

            image_data = base64.b64decode(image_base64)
            return Image.open(io.BytesIO(image_data)).convert("RGB")
        except Exception as exc:
            logger.error("Failed to decode base64 image: %s", exc)
            raise ValueError(f"Invalid base64 image: {exc}")

    def run_inference(
        self,
        image: Image.Image,
        conf_threshold: float = 0.5,
        mode: str = "LEARNING",
    ) -> List[Dict]:
        if not self.is_ready():
            raise RuntimeError("YOLO models not loaded")

        try:
            # Capture original dimensions for coordinate scaling later
            orig_w, orig_h = image.size
            
            # Pre-resize a copy once so each model receives an already-correct-sized
            # image, avoiding redundant resize operations across multiple models.
            inference_image = image
            scale_factor = 1.0
            
            if max(image.size) > self.INFERENCE_IMGSZ:
                inference_image = image.copy()
                inference_image.thumbnail(
                    (self.INFERENCE_IMGSZ, self.INFERENCE_IMGSZ),
                    Image.LANCZOS,
                )
                resized_w, _ = inference_image.size
                scale_factor = orig_w / resized_w

            allowed_labels = self._allowed_labels_for_mode(mode)
            enabled_model_keys = self._models_for_mode(mode)

            detections: List[Dict] = []
            
            # Use a ThreadPoolExecutor to run multiple YOLO models in parallel.
            # Inference in Ultralytics releases the GIL, allowing true parallel execution.
            with ThreadPoolExecutor(max_workers=len(enabled_model_keys)) as executor:
                futures = []
                for model_key in enabled_model_keys:
                    model_entry = self.models.get(model_key)
                    if not model_entry:
                        continue
                    
                    futures.append(
                        executor.submit(
                            self._run_inference_on_model,
                            model_key,
                            model_entry,
                            inference_image,
                            allowed_labels,
                            conf_threshold,
                            scale_factor,
                            orig_w,
                            orig_h
                        )
                    )
                
                for future in as_completed(futures):
                    try:
                        model_detections = future.result()
                        detections.extend(model_detections)
                    except Exception as e:
                        logger.error("Parallel inference task failed: %s", e)

            # Re-assign unique student IDs after merging results
            for idx, detection in enumerate(detections):
                detection["student_id"] = f"detected_{idx}"

            logger.info("Inference complete: %d detections", len(detections))
            return detections

        except Exception as exc:
            logger.error("YOLO inference failed: %s", exc)
            raise RuntimeError(f"Inference error: {exc}")

    def _run_inference_on_model(
        self,
        model_key: str,
        model_entry: Dict[str, Any],
        inference_image: Image.Image,
        allowed_labels: set,
        conf_threshold: float,
        scale_factor: float,
        orig_w: int,
        orig_h: int
    ) -> List[Dict]:
        """Helper to run inference on a single model, used by parallel executor."""
        model_detections = []
        
        # Filter classes at the model / NMS level for efficiency
        allowed_ids = self._allowed_class_ids_for_model(
            model_entry, allowed_labels
        )

        results = model_entry["model"](
            inference_image,
            conf=conf_threshold,
            imgsz=self.INFERENCE_IMGSZ,
            verbose=False,
            classes=allowed_ids,
        )
        
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

                # Map coordinates back to the original image space
                x1, y1, x2, y2 = [coord * scale_factor for coord in box.xyxy[0].tolist()]

                detection = {
                    "behavior_class": behavior_class,
                    "behavior_aliases": self.LABEL_ALIASES.get(behavior_class, []),
                    "raw_label": raw_label,
                    "actor_type": actor_type,
                    "source_model": model_key,
                    "confidence": round(confidence, 3),
                    "bbox": [
                        round(x1 / orig_w, 3),
                        round(y1 / orig_h, 3),
                        round((x2 - x1) / orig_w, 3),
                        round((y2 - y1) / orig_h, 3),
                    ],
                    "bbox_pixels": [x1, y1, x2, y2],
                    "student_id": "temp" # Will be finalized in run_inference
                }
                model_detections.append(detection)
        
        return model_detections

    def annotate_image(
        self,
        image: Image.Image,
        detections: List[Dict],
        include_confidence: bool = True,
    ) -> Image.Image:
        image_copy = image.copy()
        draw = ImageDraw.Draw(image_copy)

        try:
            font = ImageFont.truetype("arial.ttf", 15)
        except Exception:
            font = ImageFont.load_default()

        for detection in detections:
            x1, y1, x2, y2 = detection["bbox_pixels"]
            behavior_class = detection["behavior_class"]
            confidence = detection["confidence"]
            color = self.COLOR_MAP.get(behavior_class, (255, 255, 255))

            draw.rectangle([x1, y1, x2, y2], outline=color, width=2)

            label = behavior_class
            if include_confidence:
                label = f"{behavior_class} {confidence:.1%}"

            bbox = draw.textbbox((x1, y1), label, font=font)
            draw.rectangle(bbox, fill=color)
            draw.text((x1, y1), label, fill="white", font=font)

        return image_copy

    def encode_image_to_base64(self, image: Image.Image, format: str = "PNG") -> str:
        buffer = io.BytesIO()
        image.save(buffer, format=format)
        image_data = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/{format.lower()};base64,{image_data}"

    def save_annotated_image(self, image: Image.Image, output_dir: Path, filename: str) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)

        stem = Path(filename).stem
        suffix = Path(filename).suffix.lower()
        if suffix in {".jpg", ".jpeg"}:
            save_format = "JPEG"
            out_name = f"{stem}{suffix}"
        else:
            save_format = "PNG"
            out_name = f"{stem}.png"

        out_path = output_dir / out_name
        out_path = output_dir / filename
        image.save(out_path)
        logger.info("Saved annotated image to %s", out_path)
        return out_path

    def process_frame(
        self,
        image_base64: str,
        conf_threshold: float = 0.5,
        student_id: Optional[str] = None,
        mode: Optional[str] = None,
        output_dir: Optional[Path] = None,
        source_filename: Optional[str] = None,
        skip_annotation: bool = False,
    ) -> Dict:
        try:
            logger.debug(
                "[YOLO] process_frame start mode=%s student_id=%s output_dir=%s source_filename=%s",
                mode,
                student_id,
                output_dir,
                source_filename,
            )
            image = self.decode_base64_image(image_base64)
            active_mode = self._get_active_mode(mode, student_id)

            detections = self.run_inference(image, conf_threshold=conf_threshold, mode=active_mode)

            if student_id:
                for detection in detections:
                    detection["student_id"] = student_id

            # Skip the expensive annotate + encode cycle when the caller
            # only needs the detection list (e.g. headless batch jobs).
            annotated_base64 = None
            saved_path = None

            if not skip_annotation:
                annotated_image = self.annotate_image(image, detections)

                # Save annotated image ONLY if output_dir is explicitly provided
                if output_dir and source_filename:
                    try:
                        saved_path = self.save_annotated_image(
                            annotated_image, output_dir, source_filename
                        )
                    except Exception:
                        logger.exception("Failed to save annotated image")

                annotated_base64 = self.encode_image_to_base64(annotated_image)

            logger.debug(
                "[YOLO] process_frame complete: detections=%d saved_path=%s",
                len(detections),
                saved_path,
            )

            return {
                "detections": detections,
                "annotated_image_base64": annotated_base64,
                "detection_count": len(detections),
                "mode": active_mode,
                "saved_output_path": str(saved_path) if saved_path else None,
            }
        except Exception as exc:
            logger.error("Frame processing failed: %s", exc)
            raise RuntimeError(f"Failed to process frame: {exc}")

    def batch_process_frames(
        self,
        frames: List[Dict],
        conf_threshold: float = 0.5,
        mode: Optional[str] = None,
    ) -> List[Dict]:
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
            except Exception as exc:
                logger.error("Failed to process frame: %s", exc)
                results.append({"error": str(exc)})
        return results
