import os
from pathlib import Path
from ultralytics import YOLO

def auto_annotate():
    base_dir = Path(__file__).resolve().parents[2]
    
    # 1. Load the good, individual models
    bt_model_path = base_dir / "backend" / "models" / "yolo_weights" / "student_bow_turn" / "best.onnx"
    dc_model_path = base_dir / "backend" / "models" / "yolo_weights" / "student_discuss" / "best.onnx"
    
    print("Loading models for auto-annotation...")
    model_bt = YOLO(str(bt_model_path), task="detect")
    model_dc = YOLO(str(dc_model_path), task="detect")
    
    # 2. Combined dataset path
    dataset_dir = base_dir / "YOLO" / "SCB-Dataset" / "SCB5-BowTurnDiscuss"
    splits = ["train", "val"]
    
    CONF_THRESHOLD = 0.50 # Only trust confident predictions
    
    total_added_discuss = 0
    total_added_bt = 0

    for split in splits:
        img_dir = dataset_dir / "images" / split
        lbl_dir = dataset_dir / "labels" / split
        
        if not img_dir.exists():
            continue
            
        images = list(img_dir.glob("*.jpg"))
        print(f"\nProcessing {split} split ({len(images)} images)...")
        
        for i, img_path in enumerate(images):
            label_path = lbl_dir / f"{img_path.stem}.txt"
            
            # If it's a BowTurn image, it is missing "discuss" labels
            if img_path.name.startswith("bt_"):
                results = model_dc(img_path, imgsz=640, verbose=False, conf=CONF_THRESHOLD)
                added_lines = []
                for box in results[0].boxes:
                    # model_dc only outputs class 0 (discuss)
                    # We need to map it to class 2 in the combined dataset
                    cls_id = 2 
                    x, y, w, h = box.xywhn[0].tolist() # Normalized coordinates
                    added_lines.append(f"{cls_id} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n")
                
                if added_lines:
                    with open(label_path, "a") as f:
                        f.writelines(added_lines)
                    total_added_discuss += len(added_lines)

            # If it's a Discuss image, it is missing "bow_turn" labels
            elif img_path.name.startswith("dc_"):
                results = model_bt(img_path, imgsz=640, verbose=False, conf=CONF_THRESHOLD)
                added_lines = []
                for box in results[0].boxes:
                    # model_bt outputs class 0 (bow) and class 1 (turn)
                    # These remain class 0 and 1 in the combined dataset!
                    cls_id = int(box.cls[0].item())
                    x, y, w, h = box.xywhn[0].tolist()
                    added_lines.append(f"{cls_id} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n")
                
                if added_lines:
                    with open(label_path, "a") as f:
                        f.writelines(added_lines)
                    total_added_bt += len(added_lines)
                    
            if (i + 1) % 500 == 0:
                print(f"  Processed {i+1}/{len(images)}...")

    print("\n--- AUTO-ANNOTATION COMPLETE ---")
    print(f"Added {total_added_discuss} missing 'discuss' labels to BowTurn images.")
    print(f"Added {total_added_bt} missing 'bow/turn' labels to Discuss images.")
    print("The combined dataset is now fully labeled and ready for retraining!")

if __name__ == "__main__":
    auto_annotate()
