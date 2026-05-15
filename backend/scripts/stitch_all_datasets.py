import os
import subprocess
import sys
from pathlib import Path

def stitch_all():
    base_dir = Path(__file__).resolve().parents[2]
    dataset_root = base_dir / "YOLO" / "SCB-Dataset"
    stitcher_script = base_dir / "backend" / "scripts" / "stitch_images_to_video.py"
    python_exe = sys.executable

    # List of datasets to process
    datasets = [
        "SCB5-BowTurnDiscuss",
        "SCB5-Discuss-2024-9-17",
        "SCB5-Handrise-Read-write-2024-9-17",
        "SCB5-Teacher-Extracted",
        "SCB5_Teacher_Behavior_Stand_BlackBoard_Sreen_20250406",
        "SCB_BowTurnHead_20250509"
    ]

    splits = ["train", "val", "test"]

    for ds_name in datasets:
        ds_path = dataset_root / ds_name
        if not ds_path.exists():
            print(f"Skipping {ds_name} (not found)")
            continue

        for split in splits:
            img_dir = ds_path / "images" / split
            if not img_dir.exists():
                # Some datasets might have direct images or different structure
                # Check for just 'images'
                if split == "train" and (ds_path / "images").exists() and not (ds_path / "images" / "train").exists():
                    img_dir = ds_path / "images"
                else:
                    continue

            output_name = f"{ds_name}_{split}_1fps.mp4"
            print(f"\n>>> Processing {ds_name} [{split}]...")
            
            cmd = [
                str(python_exe),
                str(stitcher_script),
                "--src", str(img_dir),
                "--fps", "1",
                "--max-images", "200", # Limit to 200 images per dataset split to keep files small
                "--output", str(base_dir / "backend" / "scripts" / "test_videos" / output_name)
            ]
            
            try:
                subprocess.run(cmd, check=True)
            except subprocess.CalledProcessError as e:
                print(f"Error processing {ds_name} {split}: {e}")

if __name__ == "__main__":
    stitch_all()
