"""
YOLO inference service for behavior detection in classroom frames.
- Loads YOLOv8 model
- Runs inference on base64 images
- Extracts behavior detections
- Annotates images with bounding boxes and labels
"""

import base64
import io
from typing import List, Dict, Tuple, Optional
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import logging

logger = logging.getLogger(__name__)


class YOLOInferenceService:
    """
    Wrapper around YOLO for classroom behavior detection.
    Maps YOLO classes to behavior types.
    """

    # Map YOLO detected classes to behavior classes
    CLASS_TO_BEHAVIOR = {
        0: "CHEATING",
        1: "TALKING",
        2: "USING_DEVICE",  # Phone/unauthorized device
        3: "HEAD_TURN",
        4: "EYE_GAZE_AWAY",
        5: "SLEEPING",
        6: "DISTRACTED",
        7: "ATTENTIVE",
        8: "TAKING_NOTES",
        9: "HAND_RAISED",
        10: "NORMAL",
        # Expand as needed for other behaviors
    }

    COLOR_MAP = {
        "CHEATING": (255, 0, 0),              # Red
        "TALKING": (255, 165, 0),            # Orange
        "USING_DEVICE": (255, 0, 0),         # Red
        "HEAD_TURN": (255, 255, 0),          # Yellow
        "EYE_GAZE_AWAY": (255, 255, 0),      # Yellow
        "SLEEPING": (128, 0, 128),           # Purple
        "DISTRACTED": (255, 165, 0),         # Orange
        "ATTENTIVE": (0, 255, 0),            # Green
        "TAKING_NOTES": (0, 255, 0),         # Green
        "HAND_RAISED": (0, 255, 127),        # Spring Green
        "NORMAL": (0, 255, 0),               # Green
    }

    def __init__(self):
        """Initialize YOLO model."""
        try:
            from ultralytics import YOLO
            model_path = "/app/models/yolo_weights/best.pt"
            self.model = YOLO(model_path)
            logger.info(f"YOLO model loaded from {model_path}")
        except Exception as e:
            logger.error(f"Failed to load YOLO model: {e}")
            self.model = None

    def is_ready(self) -> bool:
        """Check if model is loaded and ready."""
        return self.model is not None

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

    def run_inference(self, image: Image.Image, conf_threshold: float = 0.5) -> List[Dict]:
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
            raise RuntimeError("YOLO model not loaded")

        try:
            # Convert PIL to numpy array
            image_array = np.array(image)

            # Run inference
            results = self.model(image_array, conf=conf_threshold, verbose=False)
            
            detections = []
            
            # Process results
            for result in results:
                boxes = result.boxes
                
                for i, box in enumerate(boxes):
                    confidence = float(box.conf[0])
                    class_id = int(box.cls[0])
                    
                    # Map to behavior class
                    behavior_class = self.CLASS_TO_BEHAVIOR.get(class_id, "UNKNOWN")
                    
                    # Get normalized bbox (0-1)
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    img_w, img_h = image.size
                    
                    x_norm = x1 / img_w
                    y_norm = y1 / img_h
                    w_norm = (x2 - x1) / img_w
                    h_norm = (y2 - y1) / img_h
                    
                    detection = {
                        "behavior_class": behavior_class,
                        "confidence": round(confidence, 3),
                        "bbox": [round(x, 3) for x in [x_norm, y_norm, w_norm, h_norm]],
                        "bbox_pixels": [x1, y1, x2, y2],  # For annotation
                        "student_id": f"detected_{i}",  # Placeholder, can be specified later
                    }
                    
                    detections.append(detection)
            
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
            
            # Infer
            detections = self.run_inference(image, conf_threshold)
            
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
            }
        
        except Exception as e:
            logger.error(f"Frame processing failed: {e}")
            raise RuntimeError(f"Failed to process frame: {e}")

    def batch_process_frames(
        self,
        frames: List[Dict],  # [{image_base64, student_id?}, ...]
        conf_threshold: float = 0.5,
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
                )
                results.append(result)
            except Exception as e:
                logger.error(f"Failed to process frame: {e}")
                results.append({"error": str(e)})
        
        return results
