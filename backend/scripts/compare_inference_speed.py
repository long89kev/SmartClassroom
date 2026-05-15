import time
from pathlib import Path
from ultralytics import YOLO

def benchmark():
    base_dir = Path(__file__).resolve().parents[2]
    weights_dir = base_dir / "backend" / "models" / "yolo_weights" / "student_bow_turn"
    
    onnx_path = weights_dir / "best.onnx"
    openvino_path = weights_dir / "best_int8_openvino_model"
    
    img_dir = base_dir / "YOLO" / "SCB-Dataset" / "SCB5-BowTurnDiscuss" / "images" / "train"
    
    # Get up to 100 images
    img_paths = list(img_dir.glob("*.jpg"))[:100]
    
    if not img_paths:
        print(f"No images found in {img_dir} for benchmark.")
        return

    print(f"Benchmarking with {len(img_paths)} images at 640x640 resolution...")
    
    # --- ONNX Benchmark ---
    if onnx_path.exists():
        print(f"\n[ONNX] Loading model from {onnx_path}...")
        try:
            model_onnx = YOLO(str(onnx_path), task="detect")
            
            # Warmup (first run is always slow)
            print("[ONNX] Warming up...")
            model_onnx(img_paths[0], imgsz=640, verbose=False)
            
            print("[ONNX] Running benchmark...")
            start = time.time()
            for img in img_paths:
                model_onnx(img, imgsz=640, verbose=False)
            end = time.time()
            
            total_time = end - start
            avg_time = total_time / len(img_paths)
            print(f"[ONNX] Results: {total_time:.2f}s total | {avg_time*1000:.2f}ms per frame | {1/avg_time:.2f} FPS")
        except Exception as e:
            print(f"[ONNX] Failed: {e}")
    else:
        print("\n[ONNX] model not found.")
        
    # --- OpenVINO Benchmark ---
    if openvino_path.exists():
        print(f"\n[OpenVINO] Loading model from {openvino_path}...")
        try:
            model_ov = YOLO(str(openvino_path), task="detect")
            
            # Warmup
            print("[OpenVINO] Warming up...")
            model_ov(img_paths[0], imgsz=640, verbose=False)
            
            print("[OpenVINO] Running benchmark...")
            start = time.time()
            for img in img_paths:
                model_ov(img, imgsz=640, verbose=False)
            end = time.time()
            
            total_time = end - start
            avg_time = total_time / len(img_paths)
            print(f"[OpenVINO] Results: {total_time:.2f}s total | {avg_time*1000:.2f}ms per frame | {1/avg_time:.2f} FPS")
        except Exception as e:
            print(f"[OpenVINO] Failed: {e}")
    else:
        print("\n[OpenVINO] model not found.")

if __name__ == "__main__":
    benchmark()
