"""
enroll_faces.py — Student Face Enrollment Helper
Smart AI-IoT Classroom System

Populates the face_db/ directory with student reference images.
Can pull student photos from a local folder or interactively capture
from the webcam.

Usage:
    python enroll_faces.py --from-folder ./photos     # Batch from folder
    python enroll_faces.py --capture                  # Interactive webcam capture
    python enroll_faces.py --list                     # List enrolled faces
"""

import argparse
import os
import shutil
import sys

import cv2

import config


def ensure_face_db():
    """Create face_db directory if it doesn't exist."""
    os.makedirs(config.FACE_DB_DIR, exist_ok=True)
    print(f"Face database: {config.FACE_DB_DIR}")


def list_enrolled():
    """List all enrolled student faces."""
    ensure_face_db()
    entries = []
    for item in sorted(os.listdir(config.FACE_DB_DIR)):
        path = os.path.join(config.FACE_DB_DIR, item)
        if os.path.isdir(path):
            images = [f for f in os.listdir(path) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
            entries.append((item, len(images)))
        elif item.lower().endswith(('.jpg', '.jpeg', '.png')):
            code = os.path.splitext(item)[0]
            entries.append((code, 1))

    if not entries:
        print("No faces enrolled yet.")
        return

    print(f"\n{'Student Code':<20} {'Images':<10}")
    print("-" * 30)
    for code, count in entries:
        print(f"{code:<20} {count:<10}")
    print(f"\nTotal: {len(entries)} students")


def enroll_from_folder(folder_path: str):
    """
    Enroll faces from a folder of images.
    Expected naming: student_code.jpg or student_code/img1.jpg
    """
    ensure_face_db()

    if not os.path.isdir(folder_path):
        print(f"Error: Folder not found: {folder_path}")
        sys.exit(1)

    count = 0
    for item in os.listdir(folder_path):
        src = os.path.join(folder_path, item)

        if os.path.isdir(src):
            # Directory named by student_code containing images
            student_code = item
            dst_dir = os.path.join(config.FACE_DB_DIR, student_code)
            if os.path.exists(dst_dir):
                print(f"  [SKIP] {student_code} (already exists)")
                continue
            shutil.copytree(src, dst_dir)
            images = [f for f in os.listdir(dst_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
            print(f"  [ADD]  {student_code} ({len(images)} images)")
            count += 1

        elif item.lower().endswith(('.jpg', '.jpeg', '.png')):
            student_code = os.path.splitext(item)[0]
            dst_dir = os.path.join(config.FACE_DB_DIR, student_code)
            os.makedirs(dst_dir, exist_ok=True)
            dst = os.path.join(dst_dir, item)
            if os.path.exists(dst):
                print(f"  [SKIP] {student_code} (already exists)")
                continue
            shutil.copy2(src, dst)
            print(f"  [ADD]  {student_code}")
            count += 1

    print(f"\nEnrolled {count} new students.")


def capture_from_webcam():
    """Interactive webcam capture for face enrollment."""
    ensure_face_db()

    cap = cv2.VideoCapture(config.CAMERA_INDEX)
    if not cap.isOpened():
        print(f"Error: Cannot open webcam (index {config.CAMERA_INDEX})")
        sys.exit(1)

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)

    print("\n=== Webcam Face Enrollment ===")
    print("Instructions:")
    print("  1. Enter the student code when prompted")
    print("  2. Look at the camera, press SPACE to capture")
    print("  3. Press 'r' to retake, 'y' to confirm")
    print("  4. Press 'q' or Ctrl+C to quit\n")

    while True:
        student_code = input("Student code (or 'q' to quit): ").strip()
        if student_code.lower() == 'q':
            break
        if not student_code:
            continue

        student_dir = os.path.join(config.FACE_DB_DIR, student_code)
        os.makedirs(student_dir, exist_ok=True)

        print(f"  Capturing for {student_code}... Press SPACE to capture, 'q' to skip.")

        captured = False
        img_count = len([f for f in os.listdir(student_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])

        while True:
            ret, frame = cap.read()
            if not ret:
                continue

            # Draw guide rectangle
            h, w = frame.shape[:2]
            cx, cy = w // 2, h // 2
            box_size = min(w, h) // 3
            cv2.rectangle(frame,
                          (cx - box_size, cy - box_size),
                          (cx + box_size, cy + box_size),
                          (0, 255, 0), 2)
            cv2.putText(frame, f"Student: {student_code}", (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            cv2.putText(frame, "SPACE=capture  Q=skip", (10, h - 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

            cv2.imshow("Enroll Face", frame)
            key = cv2.waitKey(1) & 0xFF

            if key == ord(' '):
                # Capture
                img_count += 1
                filename = f"{student_code}_{img_count:03d}.jpg"
                filepath = os.path.join(student_dir, filename)
                # Save the raw frame (without annotations)
                ret2, raw_frame = cap.read()
                if ret2:
                    cv2.imwrite(filepath, raw_frame)
                else:
                    cv2.imwrite(filepath, frame)
                print(f"  ✓ Saved: {filename}")
                captured = True

            elif key == ord('q'):
                break

        if captured:
            total = len([f for f in os.listdir(student_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
            print(f"  ✓ {student_code}: {total} images enrolled\n")
        else:
            # Clean up empty directory
            if not os.listdir(student_dir):
                os.rmdir(student_dir)
            print(f"  ✗ {student_code}: skipped\n")

    cap.release()
    cv2.destroyAllWindows()
    print("Enrollment complete.")


def main():
    parser = argparse.ArgumentParser(description="Student Face Enrollment")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--from-folder", type=str, help="Enroll from folder of images")
    group.add_argument("--capture", action="store_true", help="Interactive webcam capture")
    group.add_argument("--list", action="store_true", help="List enrolled faces")
    parser.add_argument("--camera", type=int, default=config.CAMERA_INDEX, help="Camera index")
    args = parser.parse_args()

    config.CAMERA_INDEX = args.camera

    if args.list:
        list_enrolled()
    elif args.from_folder:
        enroll_from_folder(args.from_folder)
    elif args.capture:
        capture_from_webcam()


if __name__ == "__main__":
    main()
