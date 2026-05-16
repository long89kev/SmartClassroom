"""Export YOLO .pt weights to ONNX and (optionally) TensorRT engine formats.

Usage:
    # Export ONNX only (works on CPU, any machine)
    python export_onnx.py

    # Export ONNX + TensorRT engine (requires NVIDIA GPU + TensorRT)
    python export_onnx.py --tensorrt

    # Export TensorRT with FP16 precision (faster, slight accuracy trade-off)
    python export_onnx.py --tensorrt --fp16

    # Custom image size
    python export_onnx.py --tensorrt --imgsz 640

Notes:
    - ONNX export is always performed (portable, works on CPU and GPU).
    - TensorRT export creates a GPU-specific .engine file optimised for the
      exact GPU it is built on (e.g. RTX 3060).  The engine is NOT portable
      across different GPU architectures.
    - TensorRT export requires: NVIDIA GPU, CUDA toolkit, and the
      `tensorrt` Python package (pip install tensorrt).
    - Run the TensorRT export on the SAME machine/container that will serve
      inference (e.g. inside the Docker GPU container).
"""

import argparse
import os
import sys
from pathlib import Path
import logging

# Ensure backend directory is in PYTHONPATH so we can import from app.
# Works in both layouts:
#   Local dev:  d:/Projects/DoAnDN/backend/scripts/export_onnx.py
#               → parents[2] = d:/Projects/DoAnDN → backend_dir = .../DoAnDN/backend
#   Docker:     /app/scripts/export_onnx.py
#               → parents[1] = /app (WORKDIR, where app/ lives)
script_dir = Path(__file__).resolve().parent          # .../scripts
backend_dir = script_dir.parent                       # .../backend  (or /app in Docker)
repo_root = backend_dir.parent                        # .../DoAnDN   (or /     in Docker)

for p in [str(backend_dir), str(repo_root / "backend")]:
    if p not in sys.path:
        sys.path.insert(0, p)

from ultralytics import YOLO
from app.services.yolo_inference import YOLOInferenceService

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def _find_pt_path(service: YOLOInferenceService, spec: dict) -> Path | None:
    """Resolve the .pt weight file for a given model spec."""
    pt_candidates = []
    for cand in spec["weight_candidates"]:
        if "best.pt" in cand:
            pt_candidates.append(cand)
        elif "best.onnx" not in cand:
            pt_candidates.append(cand)

    if not pt_candidates:
        return None

    model_path = service._resolve_model_path(pt_candidates)
    if model_path and str(model_path).endswith(".pt"):
        return model_path
    return None


def export_models(
    export_tensorrt: bool = False,
    fp16: bool = False,
    imgsz: int = 640,
):
    """Export all configured YOLO models to ONNX and optionally TensorRT."""
    service = YOLOInferenceService()

    # Pre-flight check for TensorRT
    if export_tensorrt:
        try:
            import torch
            if not torch.cuda.is_available():
                logger.error(
                    "TensorRT export requires an NVIDIA GPU with CUDA. "
                    "No CUDA device detected — skipping TensorRT export.\n"
                    "Hint: run this inside the GPU Docker container:\n"
                    "  docker compose -f docker-compose.yml -f docker-compose.gpu.yml "
                    "run --rm backend python scripts/export_onnx.py --tensorrt"
                )
                export_tensorrt = False
        except ImportError:
            logger.error("PyTorch not installed — cannot check CUDA availability.")
            export_tensorrt = False

    for spec in service.MODEL_SPECS:
        model_key = spec["model_key"]
        model_path = _find_pt_path(service, spec)

        if not model_path:
            logger.warning(f"No .pt weights found for {model_key}, skipping.")
            continue

        logger.info(f"Loading {model_key} from {model_path}")

        try:
            model = YOLO(str(model_path))
        except Exception as e:
            logger.error(f"Failed to load {model_key}: {e}")
            continue

        # ── ONNX export (always) ──
        try:
            logger.info(f"Exporting {model_key} → ONNX …")
            onnx_path = model.export(
                format="onnx",
                imgsz=imgsz,
                dynamic=True,
                opset=12,
                simplify=True,
            )
            logger.info(f"  ✓ ONNX: {onnx_path}")
        except Exception as e:
            logger.error(f"  ✗ ONNX export failed for {model_key}: {e}")

        # ── TensorRT export (optional) ──
        if export_tensorrt:
            try:
                precision = "FP16" if fp16 else "FP32"
                logger.info(f"Exporting {model_key} → TensorRT ({precision}) …")
                engine_path = model.export(
                    format="engine",
                    imgsz=imgsz,
                    half=fp16,
                    simplify=True,
                    device=0,  # Build on GPU 0
                )
                logger.info(f"  ✓ TensorRT: {engine_path}")
            except Exception as e:
                logger.error(f"  ✗ TensorRT export failed for {model_key}: {e}")
                logger.info(
                    "  Hint: ensure 'tensorrt' is installed: pip install tensorrt"
                )


def parse_args():
    parser = argparse.ArgumentParser(
        description="Export YOLO .pt models to ONNX and TensorRT formats.",
    )
    parser.add_argument(
        "--tensorrt", "--trt",
        action="store_true",
        help="Also export TensorRT .engine files (requires NVIDIA GPU + TensorRT).",
    )
    parser.add_argument(
        "--fp16", "--half",
        action="store_true",
        help="Use FP16 (half-precision) for TensorRT export. Faster inference, "
             "negligible accuracy loss for detection models.",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=640,
        help="Input image size for export (default: 640).",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    logger.info("Starting model export process …")
    logger.info(f"  Formats : ONNX{' + TensorRT' if args.tensorrt else ''}")
    if args.tensorrt:
        logger.info(f"  Precision: {'FP16' if args.fp16 else 'FP32'}")
    logger.info(f"  Image size: {args.imgsz}")

    export_models(
        export_tensorrt=args.tensorrt,
        fp16=args.fp16,
        imgsz=args.imgsz,
    )
    logger.info("Export process completed.")
