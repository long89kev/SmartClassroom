import os
import sys
from pathlib import Path
import logging

# Ensure backend directory is in PYTHONPATH so we can import from app
repo_root = Path(__file__).resolve().parents[2]
backend_dir = repo_root / "backend"
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from ultralytics import YOLO
from app.services.yolo_inference import YOLOInferenceService

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

def export_models():
    service = YOLOInferenceService()
    
    for spec in service.MODEL_SPECS:
        model_key = spec["model_key"]
        
        # We need to find the best.pt first
        # Let's temporarily change the candidates to prioritize .pt just for exporting
        pt_candidates = []
        for cand in spec["weight_candidates"]:
            if "best.pt" in cand:
                pt_candidates.append(cand)
            elif "best.onnx" not in cand:
                # If it's a directory structure, we'll try it
                pt_candidates.append(cand)
        
        if not pt_candidates:
            logger.warning(f"No .pt candidates found for {model_key}, skipping export.")
            continue
            
        model_path = service._resolve_model_path(pt_candidates)
        if not model_path:
            logger.warning(f"Could not resolve .pt path for {model_key}")
            continue
            
        # Ensure it's a .pt file
        if not str(model_path).endswith('.pt'):
            logger.info(f"Resolved path for {model_key} is not a .pt file ({model_path}), skipping export.")
            continue
            
        logger.info(f"Loading {model_key} from {model_path} for ONNX export...")
        try:
            model = YOLO(str(model_path))
            logger.info(f"Exporting {model_key} to ONNX format...")
            # Export to ONNX
            # dynamic=True allows variable image sizes if needed
            # opset=12 is standard
            # simplify=True can help with onnxruntime compatibility
            onnx_path = model.export(format="onnx", imgsz=640, dynamic=True, opset=12, simplify=True)
            logger.info(f"Successfully exported {model_key} to ONNX: {onnx_path}")
            
            logger.info(f"Exporting {model_key} to OpenVINO format (INT8)...")
            # Export to OpenVINO with INT8 quantization for Intel CPUs
            ov_path = model.export(format="openvino", imgsz=640, int8=True)
            logger.info(f"Successfully exported {model_key} to OpenVINO: {ov_path}")
        except Exception as e:
            logger.error(f"Failed to export {model_key}: {e}")

if __name__ == "__main__":
    logger.info("Starting ONNX export process...")
    export_models()
    logger.info("ONNX export process completed.")
