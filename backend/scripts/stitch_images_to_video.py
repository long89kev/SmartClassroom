"""Stitch YOLO dataset images into a browser-compatible H.264 MP4 video.
"""

import argparse
import random
import sys
from pathlib import Path

import cv2
import imageio.v3 as iio

OUTPUT_DIR = Path(__file__).resolve().parent / "test_videos"
DEFAULT_FPS = 10
DEFAULT_RESOLUTION = (1280, 720)

def collect_images(src_dirs: list, extensions: set = {".jpg", ".jpeg", ".png", ".bmp"}) -> list:
    images = []
    for src in src_dirs:
        src_path = Path(src)
        if not src_path.exists():
            print(f"WARNING: Source directory does not exist: {src_path}")
            continue
        for f in sorted(src_path.iterdir()):
            if f.suffix.lower() in extensions and f.is_file():
                images.append(f)
    return images

def stitch(image_paths: list, output_path: Path, fps: int, resolution: tuple) -> None:
    width, height = resolution
    total = len(image_paths)
    print(f"Stitching {total} images -> {output_path} ({width}x{height} @ {fps} FPS, H.264)")

    with iio.imopen(str(output_path), "w", plugin="pyav") as writer:
        writer.init_video_stream("libx264", fps=fps)
        for i, img_path in enumerate(image_paths):
            frame = cv2.imread(str(img_path))
            if frame is None:
                continue
            frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            writer.write_frame(frame_rgb)
            if (i + 1) % 200 == 0 or (i + 1) == total:
                print(f"  [{i+1}/{total}] {int((i+1)/total*100)}%")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", nargs="+", type=str, required=True)
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS)
    parser.add_argument("--shuffle", action="store_true")
    parser.add_argument("--max-images", type=int, default=None)
    parser.add_argument("--output", type=str, default=None)
    parser.add_argument("--resolution", type=str, default="1280x720")

    args = parser.parse_args()
    try:
        w, h = args.resolution.lower().split("x")
        resolution = (int(w), int(h))
    except ValueError:
        sys.exit(1)

    images = collect_images(args.src)
    if not images:
        print("ERROR: No images found.")
        sys.exit(1)

    if args.shuffle:
        random.shuffle(images)
    if args.max_images and args.max_images < len(images):
        images = images[:args.max_images]

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = Path(args.output) if args.output else OUTPUT_DIR / "output.mp4"
    stitch(images, output_path, args.fps, resolution)

if __name__ == "__main__":
    main()
