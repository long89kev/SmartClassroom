"""Stitch YOLO dataset images into a browser-compatible H.264 MP4 video.

Usage examples:
  # Stitch Teacher-Extracted train images at 10 FPS
  python stitch_images_to_video.py

  # Stitch a specific folder at 5 FPS, shuffle, limit to 300 images
  python stitch_images_to_video.py --src "../../YOLO/SCB-Dataset/SCB5-BowTurnDiscuss/images/train" --fps 5 --shuffle --max-images 300

  # Stitch multiple folders together
  python stitch_images_to_video.py --src folder1 folder2 folder3
"""

import argparse
import random
import sys
from pathlib import Path

import cv2
import imageio.v3 as iio


REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_SOURCES = [
    REPO_ROOT / "YOLO" / "SCB-Dataset" / "SCB5-Teacher-Extracted" / "images" / "train",
    REPO_ROOT / "YOLO" / "SCB-Dataset" / "SCB5-Teacher-Extracted" / "images" / "val",
]

OUTPUT_DIR = Path(__file__).resolve().parent / "test_videos"
DEFAULT_FPS = 10
DEFAULT_RESOLUTION = (1280, 720)


def collect_images(src_dirs: list, extensions: set = {".jpg", ".jpeg", ".png", ".bmp"}) -> list:
    """Collect all image files from the given directories."""
    images = []
    for src in src_dirs:
        if not src.exists():
            print(f"WARNING: Source directory does not exist: {src}")
            continue
        for f in sorted(src.iterdir()):
            if f.suffix.lower() in extensions and f.is_file():
                images.append(f)
    return images


def stitch(
    image_paths: list,
    output_path: Path,
    fps: int,
    resolution: tuple,
) -> None:
    """Write images into a browser-compatible H.264 MP4 file using imageio-ffmpeg."""
    width, height = resolution
    total = len(image_paths)
    print(f"Stitching {total} images -> {output_path}  ({width}x{height} @ {fps} FPS, H.264)")
    print(f"Estimated duration: {total / fps:.1f}s")

    # Use imageio with ffmpeg backend for H.264 encoding
    with iio.imopen(str(output_path), "w", plugin="pyav") as writer:
        writer.init_video_stream("libx264", fps=fps)

        for i, img_path in enumerate(image_paths):
            frame = cv2.imread(str(img_path))
            if frame is None:
                print(f"  SKIP (unreadable): {img_path.name}")
                continue

            # Resize to target resolution
            frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
            # Convert BGR (OpenCV) -> RGB (imageio)
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            writer.write_frame(frame_rgb)

            # Progress
            if (i + 1) % 200 == 0 or (i + 1) == total:
                pct = (i + 1) / total * 100
                print(f"  [{i+1}/{total}] {pct:.0f}%")

    file_size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"\nDone! Output: {output_path}  ({file_size_mb:.1f} MB)")


def main():
    parser = argparse.ArgumentParser(description="Stitch YOLO dataset images into an MP4 video.")
    parser.add_argument(
        "--src",
        nargs="+",
        type=str,
        default=None,
        help="One or more source image directories. Defaults to Teacher-Extracted train+val.",
    )
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS, help=f"Frames per second (default: {DEFAULT_FPS})")
    parser.add_argument("--shuffle", action="store_true", help="Randomly shuffle images before stitching")
    parser.add_argument("--max-images", type=int, default=None, help="Limit the number of images to stitch")
    parser.add_argument("--output", type=str, default=None, help="Output file path. Defaults to test_videos/<auto>.mp4")
    parser.add_argument(
        "--resolution",
        type=str,
        default="1280x720",
        help="Output resolution WxH (default: 1280x720)",
    )

    args = parser.parse_args()

    # Resolve source directories
    if args.src:
        src_dirs = [Path(s) for s in args.src]
    else:
        src_dirs = DEFAULT_SOURCES

    # Parse resolution
    try:
        w, h = args.resolution.lower().split("x")
        resolution = (int(w), int(h))
    except ValueError:
        print(f"ERROR: Invalid resolution format '{args.resolution}'. Use WxH, e.g. 1280x720")
        sys.exit(1)

    # Collect images
    images = collect_images(src_dirs)
    if not images:
        print("ERROR: No images found in the specified directories.")
        sys.exit(1)

    print(f"Found {len(images)} images across {len(src_dirs)} director(y/ies).")

    # Shuffle
    if args.shuffle:
        random.shuffle(images)
        print("Shuffled image order.")

    # Limit
    if args.max_images and args.max_images < len(images):
        images = images[: args.max_images]
        print(f"Limited to {args.max_images} images.")

    # Output path
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if args.output:
        output_path = Path(args.output)
    else:
        # Auto-name from first source directory
        folder_name = src_dirs[0].parent.parent.name if src_dirs[0].parent.name in {"train", "val", "test"} else src_dirs[0].name
        output_path = OUTPUT_DIR / f"{folder_name}_{args.fps}fps_{len(images)}imgs.mp4"

    stitch(images, output_path, args.fps, resolution)


if __name__ == "__main__":
    main()
