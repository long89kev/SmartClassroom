"""Quick test script to verify YOLO inference inside Docker."""
from app.services.yolo_inference import YOLOInferenceService
from pathlib import Path
import base64
import sys

svc = YOLOInferenceService()
print("Ready:", svc.is_ready())
print("Models:", list(svc.models.keys()))

temp_dir = Path("/app/app/services/Temp")
frames = sorted([
    f for f in temp_dir.iterdir()
    if f.suffix.lower() in {".jpg", ".jpeg", ".png"}
])
print("Found %d temp frames" % len(frames))

if not frames:
    print("No temp frames found, cannot test inference")
    sys.exit(1)

img_bytes = frames[0].read_bytes()
b64 = "data:image/jpeg;base64," + base64.b64encode(img_bytes).decode()
print("Testing inference on: %s (%d bytes)" % (frames[0].name, len(img_bytes)))

result = svc.process_frame(b64, conf_threshold=0.5, mode="LEARNING")
det_count = result["detection_count"]
ann_len = len(result["annotated_image_base64"])
print("Detections: %d" % det_count)
print("Annotated image length: %d chars" % ann_len)

# Test saving to Temp_output
output_dir = Path("/app/app/services/Temp_output")
result2 = svc.process_frame(
    b64,
    conf_threshold=0.5,
    mode="LEARNING",
    output_dir=output_dir,
    source_filename=frames[0].name,
)
saved = result2.get("saved_output_path")
print("Saved output path: %s" % saved)

if saved and Path(saved).exists():
    print("OUTPUT FILE EXISTS: %d bytes" % Path(saved).stat().st_size)
else:
    print("WARNING: Output file not found at %s" % saved)

print("SUCCESS!")
