import os
import subprocess
import sys
from pathlib import Path

def stitch_all():
    base_dir = Path(__file__).resolve().parents[2]
    dataset_root = base_dir / "YOLO" / "SCB-Dataset"
    stitcher_script = base_dir / "backend" / "scripts" / "stitch_images_to_video.py"
    python_exe = base_dir / ".venv311" / "Scripts" / "python.exe"
    
    if not python_exe.exists():
        # Fallback for other systems
        python_exe = Path(sys.executable)

    # Find all directories that contain an "images" folder
    dataset_dirs = []
    for root, dirs, files in os.walk(dataset_root):
        if "images" in dirs:
            dataset_dirs.append(Path(root))
            # Don't recurse deeper once we found an images folder
            dirs.remove("images")

    print(f"Found {len(dataset_dirs)} dataset folders with 'images' directories.")

    for ds_path in dataset_dirs:
        # Determine a nice name for the output
        if ds_path == dataset_root:
            ds_name = "RootDataset"
        else:
            # Use the folder name, but if it's nested like .../Name/Name, use Name
            ds_name = ds_path.name
            if ds_path.parent.name == ds_name:
                ds_name = f"{ds_name}_nested"

        img_root = ds_path / "images"
        
        # We want to combine train and val into one video
        src_args = []
        
        train_dir = img_root / "train"
        val_dir = img_root / "val"
        test_dir = img_root / "test"

        for split in ["train", "val", "test"]:
            split_dir = img_root / split
            if split_dir.exists():
                src_args.append(str(split_dir))
        
        # If no subfolders found, use the image root itself
        if not src_args:
            src_args.append(str(img_root))

        output_name = f"{ds_name}_full_dataset_1fps.mp4"
        print(f"\n>>> Processing {ds_name} [Full Dataset] with {len(src_args)} sources...")
        
        cmd = [
            str(python_exe),
            str(stitcher_script),
            "--src"
        ] + src_args + [
            "--fps", "1",
            "--max-images", "500", # Combined limit
            "--output", str(base_dir / "backend" / "scripts" / "test_videos" / output_name)
        ]
        
        try:
            subprocess.run(cmd, check=True)
        except subprocess.CalledProcessError as e:
            print(f"Error processing {ds_name}: {e}")

if __name__ == "__main__":
    stitch_all()
