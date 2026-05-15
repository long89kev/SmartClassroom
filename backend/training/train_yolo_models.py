#!/usr/bin/env python3
"""
Consolidated YOLO Training & Comparison Script
YOLOv8 vs YOLOv11 vs YOLOv26 for Classroom Behavior Detection

Designed for Kaggle execution with single-file portability.
All logic self-contained: dataset handling, training, evaluation, reporting.

Usage:
    # Quick test (5 epochs)
    python train_yolo_models.py --model bow_turn --yolo-version v8 --epochs 5

    # Full grid search (2 models × 3 versions × ~5 hyperparams = ~30 runs)
    python train_yolo_models.py --all --grid-search

    # Single model with specific hyperparams
    python train_yolo_models.py --model discuss --yolo-version v11 --lr 0.01 --batch 16

    # Resume from checkpoint
    python train_yolo_models.py --all --grid-search --resume

Author: Classroom Behavior Detection Team
"""

import argparse
import json
import logging
import os
import shutil
import sys
import tempfile
import traceback
import zipfile
from abc import ABC, abstractmethod
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import pandas as pd
from PIL import Image

# ============================================================================
# REQUIREMENTS: pip install ultralytics opencv-python pillow pandas matplotlib
# ============================================================================

# Defer hard-failing on missing optional packages so the script can run in
# notebooks that haven't installed dependencies yet. We set flags and provide
# clear errors when attempting to train.
HAS_ULTRALYTICS = True
try:
    from ultralytics import YOLO
except Exception:
    HAS_ULTRALYTICS = False
    YOLO = None

HAS_MATPLOTLIB = True
try:
    import matplotlib.pyplot as plt
except Exception:
    HAS_MATPLOTLIB = False
    plt = None


# ============================================================================
# LOGGING CONFIGURATION
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS & CONFIGURATION
# ============================================================================

class Config:
    """Global configuration for training."""
    
    # Dataset paths: prefer Kaggle input when present, otherwise prefer local
    # workspace layout YOLO/SCB-Dataset, then fallback to ./data.
    if Path("/kaggle/input").exists():
        DATASET_ROOT = Path("/kaggle/input")
    elif Path("./YOLO/SCB-Dataset").exists():
        DATASET_ROOT = Path("./YOLO/SCB-Dataset")
    else:
        DATASET_ROOT = Path("./data")
    RESULTS_ROOT = Path("./training_results")
    
    # Behavior models to train
    MODELS_TO_TRAIN = {
        "bow_turn": {
            "classes": ["BowHead", "TurnHead"],
            "dataset_name": "SCB5-BowTurnHead",
            "dataset_aliases": ["SCB5-BowTurnHead", "SCB_BowTurnHead", "BowTurnHead"],
        },
        "discuss": {
            "classes": ["discuss"],
            "dataset_name": "SCB5-Discuss",
            "dataset_aliases": ["SCB5-Discuss", "SCB5-Discuss-2024-9-17", "Discuss"],
        },
        "bow_turn_discuss": {
            "classes": ["BowHead", "TurnHead", "discuss"],
            "dataset_name": "SCB5-BowTurnDiscuss",
            "dataset_aliases": ["SCB5-BowTurnDiscuss", "BowTurnDiscuss"],
        },
        "handrise": {
            "classes": ["hand-raising", "read", "write"],
            "dataset_name": "SCB5-Handrise-Read-write-2024-9-17",
            "dataset_aliases": ["SCB5-Handrise-Read-write", "Handrise-Read-write", "Handrise"],
        },
        "teacher_extracted": {
            "classes": ["guide", "answer", "On-stage interaction", "teacher"],
            "dataset_name": "SCB5-Teacher-Extracted",
            "dataset_aliases": ["SCB5-Teacher-Extracted", "Teacher-Extracted"],
        },
    }

    # === ADDED: HARDCODED ABSOLUTE KAGGLE PATHS ===
    HARDCODED_PATHS = {
        "SCB5-Handrise-Read-write-2024-9-17": Path("/kaggle/input/datasets/hejuncheung/scb-datasets/SCB5-Handrise-Read-write-2024-9-17/SCB5-Handrise-Read-write-2024-9-17"),
        "SCB5-Discuss": Path("/kaggle/input/datasets/hejuncheung/scb-datasets/SCB5-Discuss-2024-9-17/SCB5-Discuss-2024-9-17"),
        "SCB5-BowTurnHead": Path("/kaggle/input/datasets/hejuncheung/scb-datasets/SCB_BowTurnHead_20250509/SCB_BowTurnHead_20250509/SCB5-Turn-Bow-Head-2024-9-17"),
        "SCB5-BowTurnDiscuss": Path("/kaggle/input/datasets/hejuncheung/scb-datasets/SCB5-BowTurnDiscuss"),
        "SCB5-Teacher-Extracted": Path("/kaggle/input/datasets/hejuncheung/scb-datasets/SCB5-Teacher-Extracted"),
        "SCB5_Teacher": Path("/kaggle/input/datasets/hejuncheung/scb-datasets/SCB5_Teacher_Behavior_Stand_BlackBoard_Sreen_20250406-2/SCB5_Teacher_Behavior_Stand_BlackBoard_Sreen_20250406-2")
    }

    # === Training knobs requested by handoff ===
    CLOSE_MOSAIC = 10
    COSINE_LR = True
    MODEL_SIZE = "m"
    AUTO_WEIGHT = True  # Automatically balance classes via oversampling
    
    # YOLO versions to compare
    YOLO_VERSIONS = ["v8", "v11", "v26"]
    
    # Default training params
    DEFAULT_IMAGE_SIZE = 1024
    DEFAULT_CONFIDENCE_THRESHOLD = 0.5
    
    # Paths for checkpoint resumption
    CHECKPOINT_DIR = RESULTS_ROOT / "checkpoints"
    EXPERIMENTS_LOG = RESULTS_ROOT / "experiments.json"


# ============================================================================
# DATASET MANAGER
# ============================================================================

class DatasetManager:
    """Handles dataset extraction, validation, and train/val/test splitting."""
    
    def __init__(self, dataset_root: Path = None):
        self.dataset_root = dataset_root or Config.DATASET_ROOT
        self.logger = logging.getLogger(f"{__name__}.DatasetManager")
    
    def find_dataset_zip(self, dataset_name: str) -> Optional[Path]:
        """Find .zip file for dataset in common locations."""
        search_paths = [
            self.dataset_root / f"{dataset_name}.zip",
            self.dataset_root / dataset_name / f"{dataset_name}.zip",
            Path(f"./YOLO/SCB-Dataset/{dataset_name}/{dataset_name}.zip"),
            Path(f"./YOLO/SCB-Dataset/{dataset_name}/{dataset_name}-2.zip"),
        ]

        for path in search_paths:
            if path.exists():
                self.logger.info(f"Found dataset zip: {path}")
                return path

        self.logger.debug(f"Dataset zip not found for {dataset_name}")
        return None

    @staticmethod
    def _normalize_name(value: str) -> str:
        return "".join(ch.lower() for ch in value if ch.isalnum())

    def _match_dataset_dir(self, base_dir: Path, candidates: List[str]) -> Optional[Path]:
        """Find best matching dataset folder under base_dir by normalized alias matching."""
        if not base_dir.exists() or not base_dir.is_dir():
            return None

        normalized_candidates = [self._normalize_name(c) for c in candidates if c]
        for child in sorted(base_dir.iterdir()):
            if not child.is_dir():
                continue
            child_norm = self._normalize_name(child.name)
            for cand_norm in normalized_candidates:
                if cand_norm in child_norm or child_norm in cand_norm:
                    # Prefer folders that contain images/labels structure directly
                    if (child / "images").exists() and (child / "labels").exists():
                        return child
                    # Check one level deeper (Kaggle often wraps datasets in a single parent folder)
                    for subchild in child.iterdir():
                        if subchild.is_dir() and (subchild / "images").exists() and (subchild / "labels").exists():
                            return subchild
                    return child
        return None

    def find_dataset_dir(self, dataset_name: str, aliases: Optional[List[str]] = None) -> Optional[Path]:
        """Find an already-extracted dataset directory, checking hardcoded paths first."""
        
        if dataset_name in Config.HARDCODED_PATHS:
            hardcoded_path = Config.HARDCODED_PATHS[dataset_name]
            if hardcoded_path.exists() and hardcoded_path.is_dir():
                self.logger.info(f"Found HARDCODED dataset directory: {hardcoded_path}")
                return hardcoded_path
            else:
                self.logger.warning(f"Hardcoded path for {dataset_name} does not exist: {hardcoded_path}. Falling back to fuzzy search.")
        
        aliases = aliases or []
        candidate_names = [dataset_name] + aliases

        exact_candidates = [
            Path('/kaggle/input/datasets/hejuncheung/scb-datasets') / dataset_name,
            Path('/kaggle/input/datasets/nguyenduythanh2005/scb-data/SCB5-Handrise-Read-write-2024-9-17') / dataset_name,
            Path('/kaggle/input/datasets/nguyenduythanh2005/scb-data') / dataset_name,
            Path('/kaggle/input/datasets/shreyasudaya/scb-05-dataset/SCB-Dataset') / dataset_name,
            Path('/kaggle/input') / dataset_name,
            Path('/kaggle/input') / 'scb-05-dataset' / dataset_name,
            Path(f"./YOLO/SCB-Dataset/{dataset_name}"),
            self.dataset_root / dataset_name,
        ]

        for cand in exact_candidates:
            if cand.exists() and cand.is_dir():
                self.logger.info(f"Found dataset directory (exact): {cand}")
                return cand

        search_roots = [
            Path('/kaggle/input/datasets/hejuncheung/scb-datasets'),
            Path('/kaggle/input/datasets/nguyenduythanh2005/scb-data'),
            Path('/kaggle/input/datasets/shreyasudaya/scb-05-dataset/SCB-Dataset'),
            Path('/kaggle/input/scb-05-dataset/SCB-Dataset'),
            Path('/kaggle/input/SCB-Dataset'),
            Path('/kaggle/input'),
            Path('/kaggle/working/training_results/datasets'),
            Path('./YOLO/SCB-Dataset'),
            self.dataset_root,
        ]

        for root in search_roots:
            match = self._match_dataset_dir(root, candidate_names)
            if match:
                self.logger.info(f"Found dataset directory (matched): {match}")
                return match

        self.logger.debug(f"No extracted dataset directory found for {dataset_name}")
        return None
    
    def extract_dataset(self, zip_path: Path, extract_to: Path) -> bool:
        """Extract dataset zip file."""
        try:
            self.logger.info(f"Extracting {zip_path} to {extract_to}")
            extract_to.mkdir(parents=True, exist_ok=True)
            
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(extract_to)
            
            self.logger.info("Extraction complete")
            return True
        except Exception as e:
            self.logger.error(f"Extraction failed: {e}")
            return False
    
    def validate_yolo_format(self, data_dir: Path) -> Tuple[bool, Dict[str, int]]:
        """
        Validate YOLO format directory structure.
        Returns (is_valid, class_counts).
        """
        required_dirs = ["images", "labels"]
        splits = ["train", "val"]
        
        # Check directory structure
        for req_dir in required_dirs:
            if not (data_dir / req_dir).exists():
                self.logger.warning(f"Missing directory: {data_dir / req_dir}")
                return False, {}
        
        # Count classes
        class_counts = defaultdict(int)
        labels_dir = data_dir / "labels"
        
        for label_file in labels_dir.rglob("*.txt"):
            with open(label_file, 'r') as f:
                for line in f:
                    if line.strip():
                        parts = line.split()
                        if parts:
                            class_id = int(parts[0])
                            class_counts[class_id] += 1
        
        self.logger.info(f"Found {len(class_counts)} classes, {sum(class_counts.values())} total labels")
        return True, dict(class_counts)
    
    def create_train_val_test_split(
        self,
        source_dir: Path,
        output_dir: Path,
        train_ratio: float = 0.8,
        val_ratio: float = 0.2,
        test_ratio: float = 0.0,
        seed: int = 42,
        label_mapping: Optional[Dict[int, int]] = None,
        auto_weight: bool = True,
    ) -> bool:
        """
        Create train/val split from existing images/labels.
        Assumes source_dir has images/ and labels/ subdirectories.
        """
        try:
            np.random.seed(seed)
            
            # Directories
            source_images = source_dir / "images"
            source_labels = source_dir / "labels"
            
            if not (source_images.exists() and source_labels.exists()):
                self.logger.error(f"Missing images or labels in {source_dir}")
                return False
            
            # Create output structure
            for split in ["train", "val"]:
                (output_dir / "images" / split).mkdir(parents=True, exist_ok=True)
                (output_dir / "labels" / split).mkdir(parents=True, exist_ok=True)
            
            # Get all image files
            image_extensions = {".jpg", ".jpeg", ".png"}
            image_files = [f for f in source_images.glob("*") if f.suffix.lower() in image_extensions]
            
            self.logger.info(f"Found {len(image_files)} images")
            
            # Shuffle and split
            image_files = sorted(image_files)
            np.random.shuffle(image_files)
            
            n_train = int(len(image_files) * train_ratio)
            
            train_files = image_files[:n_train]
            val_files = image_files[n_train:]
            
            # Copy files
            splits_data = {
                "train": train_files,
                "val": val_files,
            }
            
            for split, files in splits_data.items():
                for img_file in files:
                    # Copy image
                    dest_img = output_dir / "images" / split / img_file.name
                    shutil.copy2(img_file, dest_img)
                    
                    label_file = source_labels / f"{img_file.stem}.txt"
                    if label_file.exists():
                        dest_label = output_dir / "labels" / split / label_file.name
                        shutil.copy2(label_file, dest_label)

            self.logger.info(f"Split: train={len(train_files)}, val={len(val_files)}")
            
            # --- AUTO BALANCE (OVERSAMPLING) ---
            if auto_weight:
                self.logger.info("Applying auto-balancing (oversampling minority classes)...")
                self._balance_train_split(output_dir)
                
            return True
        
        except Exception as e:
            self.logger.error(f"Split creation failed: {e}")
            traceback.print_exc()
            return False

    def _balance_train_split(self, dataset_dir: Path):
        """Oversample minority classes in the training set."""
        train_images = dataset_dir / "images" / "train"
        train_labels = dataset_dir / "labels" / "train"
        
        # 1. Count instances
        counts = defaultdict(int)
        image_to_classes = defaultdict(set)
        
        label_files = list(train_labels.glob("*.txt"))
        for lf in label_files:
            try:
                with open(lf, 'r') as f:
                    for line in f:
                        parts = line.strip().split()
                        if parts:
                            cls_id = int(parts[0])
                            counts[cls_id] += 1
                            image_to_classes[lf.stem].add(cls_id)
            except:
                continue
        
        if not counts:
            return
            
        self.logger.info(f"Original class distribution: {dict(counts)}")
        
        max_count = max(counts.values())
        
        # 2. Identify minority images
        # We target a multiplier for images containing minority classes
        for cls_id, count in counts.items():
            if count < max_count * 0.8: # If less than 80% of max
                multiplier = min(5, int(max_count / count)) # Max 5x oversampling
                if multiplier <= 1:
                    continue
                    
                self.logger.info(f"Oversampling class {cls_id} by {multiplier}x")
                
                # Find images containing this class
                target_images = [img_stem for img_stem, classes in image_to_classes.items() if cls_id in classes]
                
                for img_stem in target_images:
                    # Find original image file
                    orig_img = None
                    for ext in ['.jpg', '.jpeg', '.png']:
                        p = train_images / f"{img_stem}{ext}"
                        if p.exists():
                            orig_img = p
                            break
                    
                    if not orig_img:
                        continue
                        
                    orig_label = train_labels / f"{img_stem}.txt"
                    
                    # Copy multiple times
                    for i in range(1, multiplier):
                        new_stem = f"{img_stem}_bal_{i}"
                        new_img_path = train_images / f"{new_stem}{orig_img.suffix}"
                        new_label_path = train_labels / f"{new_stem}.txt"
                        
                        if not new_img_path.exists():
                            shutil.copy2(orig_img, new_img_path)
                        if not new_label_path.exists():
                            shutil.copy2(orig_label, new_label_path)

        # Recount for logging
        new_counts = defaultdict(int)
        for lf in train_labels.glob("*.txt"):
            try:
                with open(lf, 'r') as f:
                    for line in f:
                        parts = line.strip().split()
                        if parts:
                            new_counts[int(parts[0])] += 1
            except:
                continue
        self.logger.info(f"Balanced class distribution: {dict(new_counts)}")
    
    def prepare_dataset(
        self,
        model_key: str,
        dataset_name: str,
        dataset_aliases: Optional[List[str]] = None,
        use_existing: bool = False,
        auto_weight: bool = True,
    ) -> Optional[Path]:
        """
        Prepare dataset for training:
        1. Find and extract .zip if needed
        2. Validate YOLO format
        3. Create train/val/test split (now train/val only)
        
        Returns path to prepared dataset directory.
        """
        prepared_dir = Config.RESULTS_ROOT / f"datasets" / model_key
        
        # If already prepared, return
        if use_existing and (prepared_dir / "images").exists():
            self.logger.info(f"Using existing prepared dataset at {prepared_dir}")
            return prepared_dir
        
        # First, check for already-extracted dataset directories (Kaggle or local)
        dataset_dir = self.find_dataset_dir(dataset_name, aliases=dataset_aliases)
        if dataset_dir:
            # If the directory contains images/ and labels/, use it directly
            if (dataset_dir / 'images').exists() and (dataset_dir / 'labels').exists():
                split_dir = prepared_dir / 'split'
                # If user requested existing and split already present, return it
                if use_existing and (split_dir / 'images').exists():
                    self.logger.info(f"Using existing prepared dataset at {split_dir}")
                    return split_dir

                # If the dataset already has train/val/test, copy or link into prepared_dir
                if (dataset_dir / 'images' / 'train').exists() and (dataset_dir / 'labels' / 'train').exists():
                    # Copy structure to prepared_dir/split
                    shutil.copytree(dataset_dir, split_dir, dirs_exist_ok=True)
                    self.logger.info(f"Copied existing split dataset to {split_dir}")
                else:
                    # Create split from extracted dataset
                    split_dir.mkdir(parents=True, exist_ok=True)
                    if not self.create_train_val_test_split(dataset_dir, split_dir, label_mapping=label_mapping, auto_weight=auto_weight):
                        return None
                        
                model_config = Config.MODELS_TO_TRAIN.get(model_key, {})
                label_mapping = model_config.get("label_mapping")
                marker_file = split_dir / ".remapped"
                
                if label_mapping and not marker_file.exists():
                    self.logger.info("Applying label remapping to existing split...")
                    self._remap_labels_in_dir(split_dir / "labels", label_mapping)
                    marker_file.touch()
                    
                return split_dir

        # If no extracted dir, try to find zip and extract
        zip_path = self.find_dataset_zip(dataset_name)
        if not zip_path:
            self.logger.error(f"Cannot find dataset for {model_key} (no dir or zip)")
            return None

        # Prepare working directory
        temp_dir = prepared_dir / "temp"
        temp_dir.mkdir(parents=True, exist_ok=True)

        # Extract
        if not self.extract_dataset(zip_path, temp_dir):
            return None

        # Find extracted content (might be nested)
        extracted_content = None
        for item in temp_dir.iterdir():
            if item.is_dir() and (item / "images").exists():
                extracted_content = item
                break

        if not extracted_content:
            # Try direct extraction
            if (temp_dir / "images").exists():
                extracted_content = temp_dir

        if not extracted_content:
            self.logger.error(f"Could not find images/labels in extracted data")
            return None
        
        # Validate
        is_valid, class_counts = self.validate_yolo_format(extracted_content)
        if not is_valid:
            self.logger.error("Dataset validation failed")
            return None
        
        # Create split
        split_dir = prepared_dir / "split"
        split_dir.mkdir(parents=True, exist_ok=True)
        
        model_config = Config.MODELS_TO_TRAIN.get(model_key, {})
        label_mapping = model_config.get("label_mapping")
        
        if not self.create_train_val_test_split(extracted_content, split_dir, label_mapping=label_mapping):
            return None
        
        # Clean temp
        shutil.rmtree(temp_dir, ignore_errors=True)
        
        self.logger.info(f"Dataset prepared at {split_dir}")
        return split_dir


# ============================================================================
# YOLO TRAINER CLASSES
# ============================================================================

class YOLOTrainerBase(ABC):
    """Base class for YOLO trainers (version-agnostic)."""
    
    def __init__(self, version: str, model_key: str, dataset_dir: Path):
        self.version = version
        self.model_key = model_key
        self.dataset_dir = dataset_dir
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
        self.model = None
        self.results = {}
    
    @abstractmethod
    def _get_model_name(self) -> str:
        """Return YOLO model name (e.g., 'yolov8n', 'yolov11n')."""
        pass
    
    @abstractmethod
    def _get_training_args(self, **kwargs) -> Dict[str, Any]:
        """Get training arguments specific to this version."""
        pass
    
    def load_model(self) -> bool:
        """Load YOLO model."""
        try:
            if not HAS_ULTRALYTICS:
                self.logger.error("Ultralytics package is not installed. Install with: pip install ultralytics")
                return False

            model_name = self._get_model_name()
            self.logger.info(f"Loading model: {model_name}")
            self.model = YOLO(model_name)
            return True
        except Exception as e:
            self.logger.error(f"Failed to load model: {e}")
            return False
    
    def generate_dataset_yaml(self) -> Path:
        """Generate YOLO dataset yaml file dynamically based on config classes."""
        yaml_path = self.dataset_dir / "dataset.yaml"
        
        model_config = Config.MODELS_TO_TRAIN.get(self.model_key, {})
        classes = model_config.get("classes", ["behavior"])
        nc = len(classes)
        
        names_str = "\n".join([f"  {i}: {name}" for i, name in enumerate(classes)])
        
        yaml_content = f"""path: {self.dataset_dir.absolute()}
train: images/train
val: images/val
test: images/test
nc: {nc}
names:
{names_str}
"""
        
        yaml_path.write_text(yaml_content)
        self.logger.info(f"Generated dataset yaml: {yaml_path}")
        return yaml_path
    
    def train(
        self,
        epochs: int = 100,
        batch_size: int = 8,
        learning_rate: float = 0.01,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Train the model.
        
        Args:
            epochs: Number of training epochs
            batch_size: Batch size
            learning_rate: Learning rate
            **kwargs: Additional training arguments
        
        Returns:
            Dictionary with training results
        """
        try:
            if not self.model:
                if not self.load_model():
                    return {"error": "Failed to load model"}
            
            # Generate dataset yaml
            yaml_path = self.generate_dataset_yaml()
            
            # Prepare output directory
            output_dir = Config.RESULTS_ROOT / self.version / self.model_key
            output_dir.mkdir(parents=True, exist_ok=True)
            
            # Get training arguments
            train_args = self._get_training_args(
                data=str(yaml_path),
                epochs=epochs,
                batch=batch_size,
                lr0=learning_rate,
                project=str(output_dir.parent),
                name=self.model_key,
                **kwargs
            )
            
            self.logger.info(f"Starting training: {train_args}")
            
            # Train
            results = self.model.train(**train_args)
            
            # Save results
            self.results = {
                "version": self.version,
                "model_key": self.model_key,
                "epochs": epochs,
                "batch_size": batch_size,
                "learning_rate": learning_rate,
                "status": "completed",
                "timestamp": datetime.now().isoformat(),
            }
            
            # Extract key metrics if available
            if hasattr(results, 'results_dict'):
                self.results["metrics"] = results.results_dict
            
            self.logger.info(f"Training completed")
            return self.results
        
        except Exception as e:
            self.logger.error(f"Training failed: {e}")
            traceback.print_exc()
            return {
                "error": str(e),
                "version": self.version,
                "model_key": self.model_key,
                "status": "failed",
            }
    
    def evaluate(self, conf_threshold: float = 0.5) -> Dict[str, Any]:
        """Evaluate on test set."""
        try:
            if not self.model:
                self.logger.error("Model not loaded")
                return {}
            
            yaml_path = self.dataset_dir / "dataset.yaml"
            test_images = self.dataset_dir / "images" / "test"
            
            if not test_images.exists():
                self.logger.warning(f"Test images not found at {test_images}")
                return {}
            
            self.logger.info("Evaluating on test set")
            results = self.model.val(data=str(yaml_path), conf=conf_threshold)
            
            eval_results = {
                "confidence_threshold": conf_threshold,
            }
            
            if hasattr(results, 'results_dict'):
                eval_results.update(results.results_dict)
            
            self.logger.info(f"Evaluation results: {eval_results}")
            return eval_results
        
        except Exception as e:
            self.logger.error(f"Evaluation failed: {e}")
            return {}
    
    def infer_speed(self, num_samples: int = 10) -> Dict[str, float]:
        """Measure inference speed on test set."""
        try:
            test_images = self.dataset_dir / "images" / "test"
            image_files = list(test_images.glob("*.jpg")) + list(test_images.glob("*.png"))
            
            if not image_files:
                self.logger.warning("No test images found for speed measurement")
                return {}
            
            # Sample images
            sample_files = image_files[:min(num_samples, len(image_files))]
            
            import time
            times = []
            
            for img_file in sample_files:
                start = time.time()
                _ = self.model.predict(source=str(img_file), verbose=False)
                elapsed = time.time() - start
                times.append(elapsed)
            
            avg_time = np.mean(times) * 1000  # ms
            fps = 1000.0 / avg_time if avg_time > 0 else 0
            
            return {
                "avg_inference_time_ms": round(avg_time, 3),
                "fps": round(fps, 2),
                "num_samples": len(sample_files),
            }
        
        except Exception as e:
            self.logger.error(f"Speed measurement failed: {e}")
            return {}


class YOLOv8Trainer(YOLOTrainerBase):
    """YOLOv8 trainer."""
    
    def _get_model_name(self) -> str:
        return f"yolov8{Config.MODEL_SIZE}"
    
    def _get_training_args(self, **kwargs) -> Dict[str, Any]:
        args = {
            "device": 0 if self._has_gpu() else "cpu",
            "imgsz": Config.DEFAULT_IMAGE_SIZE,
            "optimizer": "SGD",
            # Behavior-friendly augmentations (disable destructive ones)
            "mosaic": 0.0,
            "mixup": 0.0,
            "copy_paste": 0.0,
            "degrees": 10.0,
            "translate": 0.1,
            "scale": 0.5,
            "fliplr": 0.5,
            "close_mosaic": 0,
            "cos_lr": Config.COSINE_LR,
            "fl_gamma": 1.5,   # Enable Focal Loss for auto-weighting effect
            "cls": 1.5,        # Slightly increase classification loss gain
            "save": True,
            "verbose": False,
        }
        
        # Combined Config from YOLOv7 adapted for YOLOv8 BowTurnDiscuss
        if self.model_key == "bow_turn_discuss":
            self.logger.info("Applying YOLOv7 adapted hyperparams for bow_turn_discuss")
            args.update({
                "lr0": 0.01,
                "lrf": 0.1,
                "momentum": 0.937,
                "weight_decay": 0.0005,
                "warmup_epochs": 3.0,
                "warmup_momentum": 0.8,
                "warmup_bias_lr": 0.1,
                "hsv_h": 0.015,
                "hsv_s": 0.7,
                "hsv_v": 0.4,
                "degrees": 0.0,
                "translate": 0.2,
                "scale": 0.9,
                "shear": 0.0,
                "perspective": 0.0,
                "flipud": 0.0,
                "fliplr": 0.5,
                "mosaic": 1.0,      # From user v7 config
                "mixup": 0.15,      # From user v7 config
                "copy_paste": 0.0,
                # YOLO architecture specific loss adjustments
                "box": 7.5,         # v8 default
                "cls": 0.5,         # v8 default
                "dfl": 1.5,         # v8 specific
                "close_mosaic": 10, # Standard when mosaic is used in v8
            })
            
        args.update(kwargs)
        return args
    
    @staticmethod
    def _has_gpu():
        try:
            import torch
            return torch.cuda.is_available()
        except:
            return False


class YOLOv11Trainer(YOLOTrainerBase):
    """YOLOv11 trainer."""
    
    def _get_model_name(self) -> str:
        return f"yolo11{Config.MODEL_SIZE}"
    
    def _get_training_args(self, **kwargs) -> Dict[str, Any]:
        args = {
            "device": 0 if self._has_gpu() else "cpu",
            "imgsz": Config.DEFAULT_IMAGE_SIZE,
            "optimizer": "SGD",
            # Behavior-friendly augmentations (disable destructive ones)
            "mosaic": 0.0,
            "mixup": 0.0,
            "copy_paste": 0.0,
            "degrees": 10.0,
            "translate": 0.1,
            "scale": 0.5,
            "fliplr": 0.5,
            "close_mosaic": 0,
            "cos_lr": Config.COSINE_LR,
            "fl_gamma": 1.5,   # Enable Focal Loss for auto-weighting effect
            "cls": 1.5,        # Slightly increase classification loss gain
            "save": True,
            "verbose": False,
        }
        
        # Combined Config from YOLOv7 adapted for YOLOv11 BowTurnDiscuss
        if self.model_key == "bow_turn_discuss":
            self.logger.info("Applying YOLOv7 adapted hyperparams for bow_turn_discuss")
            args.update({
                "lr0": 0.01,
                "lrf": 0.1,
                "momentum": 0.937,
                "weight_decay": 0.0005,
                "warmup_epochs": 3.0,
                "warmup_momentum": 0.8,
                "warmup_bias_lr": 0.1,
                "hsv_h": 0.015,
                "hsv_s": 0.7,
                "hsv_v": 0.4,
                "degrees": 0.0,
                "translate": 0.2,
                "scale": 0.9,
                "shear": 0.0,
                "perspective": 0.0,
                "flipud": 0.0,
                "fliplr": 0.5,
                "mosaic": 1.0,      # From user v7 config
                "mixup": 0.15,      # From user v7 config
                "copy_paste": 0.0,
                # YOLO architecture specific loss adjustments
                "box": 7.5,         # v11 default
                "cls": 0.5,         # v11 default
                "dfl": 1.5,         # v11 specific
                "close_mosaic": 10, # Standard when mosaic is used in v11
            })
            
        args.update(kwargs)
        return args
    
    @staticmethod
    def _has_gpu():
        try:
            import torch
            return torch.cuda.is_available()
        except:
            return False


class YOLOv26Trainer(YOLOTrainerBase):
    """YOLOv26 trainer (fallback to v11 if v26 not available)."""
    
    def _get_model_name(self) -> str:
        try:
            YOLO(f"yolo26{Config.MODEL_SIZE}")
            return f"yolo26{Config.MODEL_SIZE}"
        except:
            self.logger.warning("YOLOv26 not available, using YOLOv11")
            return f"yolo11{Config.MODEL_SIZE}"
    
    def _get_training_args(self, **kwargs) -> Dict[str, Any]:
        args = {
            "device": 0 if self._has_gpu() else "cpu",
            "imgsz": Config.DEFAULT_IMAGE_SIZE,
            "optimizer": "SGD",
            # Behavior-friendly augmentations (disable destructive ones)
            "mosaic": 0.0,
            "mixup": 0.0,
            "copy_paste": 0.0,
            "degrees": 10.0,
            "translate": 0.1,
            "scale": 0.5,
            "fliplr": 0.5,
            "close_mosaic": 0,
            "cos_lr": Config.COSINE_LR,
            "fl_gamma": 1.5,   # Enable Focal Loss for auto-weighting effect
            "cls": 1.5,        # Slightly increase classification loss gain
            "save": True,
            "verbose": False,
        }
        
        # Combined Config from YOLOv7 adapted for YOLOv26 BowTurnDiscuss
        if self.model_key == "bow_turn_discuss":
            self.logger.info("Applying YOLOv7 adapted hyperparams for bow_turn_discuss")
            args.update({
                "lr0": 0.01,
                "lrf": 0.1,
                "momentum": 0.937,
                "weight_decay": 0.0005,
                "warmup_epochs": 3.0,
                "warmup_momentum": 0.8,
                "warmup_bias_lr": 0.1,
                "hsv_h": 0.015,
                "hsv_s": 0.7,
                "hsv_v": 0.4,
                "degrees": 0.0,
                "translate": 0.2,
                "scale": 0.9,
                "shear": 0.0,
                "perspective": 0.0,
                "flipud": 0.0,
                "fliplr": 0.5,
                "mosaic": 1.0,      # From user v7 config
                "mixup": 0.15,      # From user v7 config
                "copy_paste": 0.0,
                # YOLOv26/v8 architecture specific loss adjustments
                "box": 7.5,         # v8 default (v7's 0.05 is incompatible)
                "cls": 0.5,         # v8 default
                "dfl": 1.5,         # v8 specific
                "close_mosaic": 10, # Standard when mosaic is used in v8
            })
            
        args.update(kwargs)
        return args
    
    @staticmethod
    def _has_gpu():
        try:
            import torch
            return torch.cuda.is_available()
        except:
            return False


# ============================================================================
# HYPERPARAMETER GRIDS
# ============================================================================

class HyperparameterGrid:
    """Define hyperparameter search space for each YOLO version."""
    
    @staticmethod
    def get_grid(version: str) -> List[Dict[str, Any]]:
        """Get hyperparameter grid combinations for version."""
        if version == "v8":
            return HyperparameterGrid.v8_grid()
        elif version == "v11":
            return HyperparameterGrid.v11_grid()
        elif version == "v26":
            return HyperparameterGrid.v26_grid()
        else:
            return []
    
    @staticmethod
    def v8_grid() -> List[Dict[str, Any]]:
        """YOLOv8 hyperparameter grid."""
        return [
            {"epochs": 50, "batch_size": 16, "learning_rate": 0.01},
            {"epochs": 50, "batch_size": 8, "learning_rate": 0.001},
            {"epochs": 100, "batch_size": 16, "learning_rate": 0.01},
            {"epochs": 100, "batch_size": 32, "learning_rate": 0.001},
            {"epochs": 100, "batch_size": 16, "learning_rate": 0.005},
        ]
    
    @staticmethod
    def v11_grid() -> List[Dict[str, Any]]:
        """YOLOv11 hyperparameter grid."""
        return [
            {"epochs": 50, "batch_size": 16, "learning_rate": 0.01},
            {"epochs": 50, "batch_size": 8, "learning_rate": 0.001},
            {"epochs": 100, "batch_size": 16, "learning_rate": 0.01},
            {"epochs": 100, "batch_size": 32, "learning_rate": 0.005},
            {"epochs": 100, "batch_size": 16, "learning_rate": 0.001},
        ]
    
    @staticmethod
    def v26_grid() -> List[Dict[str, Any]]:
        """YOLOv26 hyperparameter grid (conservative for memory)."""
        return [
            {"epochs": 50, "batch_size": 8, "learning_rate": 0.01},
            {"epochs": 50, "batch_size": 4, "learning_rate": 0.001},
            {"epochs": 100, "batch_size": 8, "learning_rate": 0.01},
            {"epochs": 100, "batch_size": 16, "learning_rate": 0.005},
        ]


# ============================================================================
# EXPERIMENT TRACKER
# ============================================================================

class ExperimentTracker:
    """Track and log all training experiments."""
    
    def __init__(self, log_file: Path = None):
        self.log_file = log_file or Config.EXPERIMENTS_LOG
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        self.experiments = self._load_experiments()
    
    def _load_experiments(self) -> List[Dict]:
        """Load existing experiments from log file."""
        if self.log_file.exists():
            with open(self.log_file, 'r') as f:
                return json.load(f)
        return []
    
    def log_experiment(self, experiment: Dict) -> None:
        """Log a training experiment."""
        self.experiments.append(experiment)
        self._save_experiments()
    
    def _save_experiments(self) -> None:
        """Save experiments to log file."""
        with open(self.log_file, 'w') as f:
            json.dump(self.experiments, f, indent=2)
    
    def get_best_model(self, model_key: str, metric: str = "mAP50") -> Optional[Dict]:
        """Get best model for given metric."""
        matching = [e for e in self.experiments if e.get("model_key") == model_key]
        if not matching:
            return None
        return max(matching, key=lambda x: x.get("metrics", {}).get(metric, 0))


# ============================================================================
# BENCHMARK REPORTER
# ============================================================================

class BenchmarkReporter:
    """Generate benchmark reports and comparison visualizations."""
    
    def __init__(self, experiments: List[Dict], output_dir: Path = None):
        self.experiments = experiments
        self.output_dir = output_dir or Config.RESULTS_ROOT
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.logger = logging.getLogger(f"{__name__}.BenchmarkReporter")
    
    def generate_markdown_report(self) -> Path:
        """Generate markdown benchmark report."""
        report_path = self.output_dir / "BENCHMARK_REPORT.md"
        
        report = "# YOLOv8 vs YOLOv11 vs YOLOv26 Benchmark Report\n\n"
        report += f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
        
        # Summary stats
        report += "## Summary\n\n"
        report += f"Total experiments: {len(self.experiments)}\n"
        
        by_version = defaultdict(list)
        for exp in self.experiments:
            by_version[exp.get("version", "unknown")].append(exp)
        
        report += "Experiments per version:\n"
        for version, exps in sorted(by_version.items()):
            report += f"  - {version}: {len(exps)} runs\n"
        
        report += "\n"
        
        # Detailed results table
        report += "## Detailed Results\n\n"
        report += "| Version | Model | Epochs | Batch | LR | Status | Metrics |\n"
        report += "|---------|-------|--------|-------|----|---------|---------|\n"
        
        for exp in sorted(self.experiments, key=lambda x: (x.get("version", ""), x.get("model_key", ""))):
            version = exp.get("version", "?")
            model = exp.get("model_key", "?")
            epochs = exp.get("epochs", "?")
            batch = exp.get("batch_size", "?")
            lr = exp.get("learning_rate", "?")
            status = exp.get("status", "?")
            metrics_str = str(exp.get("metrics", {}))[:50] + "..." if exp.get("metrics") else "N/A"
            
            report += f"| {version} | {model} | {epochs} | {batch} | {lr} | {status} | {metrics_str} |\n"
        
        report += "\n"
        
        # Recommendations
        report += "## Recommendations\n\n"
        report += self._generate_recommendations()
        
        with open(report_path, 'w') as f:
            f.write(report)
        
        self.logger.info(f"Report generated: {report_path}")
        return report_path
    
    def _generate_recommendations(self) -> str:
        """Generate recommendations based on results."""
        rec = "Based on the benchmark results:\n\n"
        
        by_version = defaultdict(list)
        for exp in self.experiments:
            if exp.get("status") == "completed":
                by_version[exp.get("version", "unknown")].append(exp)
        
        if not by_version:
            rec += "- No completed experiments to compare\n"
            return rec
        
        rec += "**Results by Version:**\n"
        for version in sorted(by_version.keys()):
            exps = by_version[version]
            rec += f"- **{version}**: {len(exps)} successful runs\n"
        
        rec += "\n**Next Steps:**\n"
        rec += "1. Review detailed metrics for each model variant\n"
        rec += "2. Choose version based on:\n"
        rec += "   - **Speed**: Lowest inference time preferred\n"
        rec += "   - **Accuracy**: Highest mAP preferred\n"
        rec += "   - **Size**: Smaller models preferred for edge deployment\n"
        rec += "3. Copy best model to production: `backend/models/yolo_weights/{model_key}/best.pt`\n"
        
        return rec
    
    def export_csv(self) -> Path:
        """Export metrics as CSV."""
        csv_path = self.output_dir / "metrics_comparison.csv"
        
        rows = []
        for exp in self.experiments:
            row = {
                "version": exp.get("version"),
                "model_key": exp.get("model_key"),
                "epochs": exp.get("epochs"),
                "batch_size": exp.get("batch_size"),
                "learning_rate": exp.get("learning_rate"),
                "status": exp.get("status"),
                "timestamp": exp.get("timestamp"),
            }
            
            # Flatten metrics
            for key, value in exp.get("metrics", {}).items():
                row[f"metric_{key}"] = value
            
            rows.append(row)
        
        df = pd.DataFrame(rows)
        df.to_csv(csv_path, index=False)
        
        self.logger.info(f"CSV exported: {csv_path}")
        return csv_path
    
    def plot_comparisons(self) -> Optional[Path]:
        """Generate comparison plots."""
        if not HAS_MATPLOTLIB:
            self.logger.warning("matplotlib not available, skipping plots")
            return None
        import matplotlib.pyplot as plt
        
        try:
            plot_path = self.output_dir / "comparison_plots.png"
            
            # Simple comparison: count experiments per version
            by_version = defaultdict(int)
            for exp in self.experiments:
                if exp.get("status") == "completed":
                    by_version[exp.get("version", "unknown")] += 1
            
            fig, axes = plt.subplots(1, 2, figsize=(12, 4))
            
            # Bar chart: experiments per version
            versions = list(by_version.keys())
            counts = list(by_version.values())
            axes[0].bar(versions, counts, color=['#1f77b4', '#ff7f0e', '#2ca02c'])
            axes[0].set_title('Completed Runs per YOLO Version')
            axes[0].set_ylabel('Count')
            axes[0].set_xlabel('Version')
            
            # Bar chart: successful vs failed
            by_status = defaultdict(int)
            for exp in self.experiments:
                by_status[exp.get("status", "unknown")] += 1
            
            statuses = list(by_status.keys())
            status_counts = list(by_status.values())
            axes[1].bar(statuses, status_counts, color=['#2ca02c', '#d62728'])
            axes[1].set_title('Experiment Status')
            axes[1].set_ylabel('Count')
            
            plt.tight_layout()
            plt.savefig(plot_path, dpi=100)
            plt.close()
            
            self.logger.info(f"Plots saved: {plot_path}")
            return plot_path
        
        except Exception as e:
            self.logger.error(f"Plot generation failed: {e}")
            return None


# ============================================================================
# MAIN ORCHESTRATOR
# ============================================================================

class TrainingOrchestrator:
    """Main orchestrator for training experiments."""
    
    def __init__(self):
        self.logger = logging.getLogger(f"{__name__}.Orchestrator")
        self.dataset_manager = DatasetManager()
        self.tracker = ExperimentTracker()
    
    def train_single_model(
        self,
        model_key: str,
        version: str,
        epochs: int = 100,
        batch_size: int = 16,
        learning_rate: float = 0.01,
        auto_weight: bool = Config.AUTO_WEIGHT,
    ) -> Dict[str, Any]:
        """Train a single model with given hyperparameters."""
        
        self.logger.info(f"Starting training: {version}/{model_key} (e={epochs}, b={batch_size}, lr={learning_rate})")
        
        # Prepare dataset
        model_config = Config.MODELS_TO_TRAIN.get(model_key)
        if not model_config:
            self.logger.error(f"Unknown model: {model_key}")
            return {"error": f"Unknown model: {model_key}"}
        
        dataset_dir = self.dataset_manager.prepare_dataset(
            model_key,
            model_config["dataset_name"],
            dataset_aliases=model_config.get("dataset_aliases", []),
            use_existing=True,  # Skip re-extraction if exists
            auto_weight=auto_weight,
        )
        
        if not dataset_dir:
            self.logger.error(f"Failed to prepare dataset for {model_key}")
            return {"error": "Failed to prepare dataset"}
        
        # Create trainer
        trainer_class = {
            "v8": YOLOv8Trainer,
            "v11": YOLOv11Trainer,
            "v26": YOLOv26Trainer,
        }.get(version)
        
        if not trainer_class:
            self.logger.error(f"Unknown YOLO version: {version}")
            return {"error": f"Unknown version: {version}"}
        
        trainer = trainer_class(version, model_key, dataset_dir)
        if not HAS_ULTRALYTICS:
            self.logger.error("Ultralytics is not installed in the environment. Cannot run training.\nInstall with: pip install ultralytics")
            result = {
                "version": version,
                "model_key": model_key,
                "status": "skipped",
                "error": "ultralytics_not_installed",
                "timestamp": datetime.now().isoformat(),
            }
            self.tracker.log_experiment(result)
            return result
        
        # Train
        train_result = trainer.train(
            epochs=epochs,
            batch_size=batch_size,
            learning_rate=learning_rate,
        )
        
        # Evaluate
        if train_result.get("status") == "completed":
            eval_result = trainer.evaluate()
            speed_result = trainer.infer_speed()
            
            train_result["eval_metrics"] = eval_result
            train_result["speed_metrics"] = speed_result
        
        # Log experiment
        self.tracker.log_experiment(train_result)
        
        self.logger.info(f"Training completed: {train_result.get('status')}")
        return train_result
    
    def run_grid_search(self):
        """Run full grid search: all versions × all models × all hyperparams."""
        
        total_runs = len(Config.YOLO_VERSIONS) * len(Config.MODELS_TO_TRAIN) * 5  # ~5 hyperparams per version
        self.logger.info(f"Starting grid search: {total_runs} total runs")
        
        run_count = 0
        for version in Config.YOLO_VERSIONS:
            hyperparams = HyperparameterGrid.get_grid(version)
            
            for model_key in Config.MODELS_TO_TRAIN.keys():
                for hparams in hyperparams:
                    run_count += 1
                    self.logger.info(f"\n[{run_count}/{total_runs}] Running: {version}/{model_key}")
                    
                    try:
                        self.train_single_model(
                            model_key=model_key,
                            version=version,
                            epochs=hparams.get("epochs", 100),
                            batch_size=hparams.get("batch_size", 16),
                            learning_rate=hparams.get("learning_rate", 0.01),
                        )
                    except Exception as e:
                        self.logger.error(f"Run failed: {e}")
                        self.tracker.log_experiment({
                            "version": version,
                            "model_key": model_key,
                            "status": "failed",
                            "error": str(e),
                            "timestamp": datetime.now().isoformat(),
                        })
                    # If ultralytics is not present, avoid running remaining experiments
                    if not HAS_ULTRALYTICS:
                        self.logger.warning("Ultralytics not installed; stopping remaining grid runs.")
                        return
        
        self.logger.info("Grid search completed!")
    
    def generate_reports(self):
        """Generate benchmark reports."""
        self.logger.info("Generating benchmark reports...")
        
        reporter = BenchmarkReporter(self.tracker.experiments)
        reporter.generate_markdown_report()
        reporter.export_csv()
        reporter.plot_comparisons()
        
        self.logger.info("Reports generated!")


# ============================================================================
# CLI & MAIN
# ============================================================================

def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Train YOLOv8/v11/v26 for classroom behavior detection",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Quick test with v8 (5 epochs)
  python train_yolo_models.py --model bow_turn --yolo-version v8 --epochs 5

  # Full grid search (2 models × 3 versions × ~5 hyperparams)
  python train_yolo_models.py --all --grid-search

  # Single model with custom hyperparams
  python train_yolo_models.py --model discuss --yolo-version v11 --epochs 100 --batch 16 --lr 0.01
        """
    )
    
    parser.add_argument("--model", choices=["bow_turn", "discuss", "bow_turn_discuss", "handrise", "teacher", "teacher_extracted", "all"], default="teacher_extracted",
                        help="Behavior model to train")
    parser.add_argument("--yolo-version", choices=["v8", "v11", "v26", "all"], default="v8",
                        help="YOLO version to train")
    parser.add_argument("--all", action="store_true",
                        help="Train all model/version combinations")
    parser.add_argument("--grid-search", action="store_true",
                        help="Run hyperparameter grid search")
    parser.add_argument("--epochs", type=int, default=100,
                        help="Number of training epochs")
    parser.add_argument("--batch", type=int, default=16,
                        help="Batch size")
    parser.add_argument("--lr", type=float, default=0.01,
                        help="Learning rate")
    parser.add_argument("--auto-weight", action="store_true", default=Config.AUTO_WEIGHT,
                        help="Automatically balance classes via oversampling")
    parser.add_argument("--resume", action="store_true",
                        help="Resume from checkpoint")
    parser.add_argument("--report", action="store_true",
                        help="Generate reports without training")
    parser.add_argument("--output-dir", type=Path, default=Config.RESULTS_ROOT,
                        help="Output directory for results")
    
    # Use parse_known_args so Jupyter/IPython kernel arguments (like -f) are ignored
    # This makes the script notebook-friendly when pasted into Colab/Kaggle cells.
    args, unknown = parser.parse_known_args()
    if unknown:
        logger.debug(f"Ignored unknown CLI args: {unknown}")
    
    # Create orchestrator
    orchestrator = TrainingOrchestrator()
    
    # Handle report-only mode
    if args.report:
        logger.info("Generating reports from existing experiments...")
        orchestrator.generate_reports()
        return
    
    # Run training
    if args.all or args.grid_search:
        orchestrator.run_grid_search()
    else:
        # Single model training
        model = args.model if args.model != "all" else "bow_turn"
        version = args.yolo_version if args.yolo_version != "all" else "v8"
        
        orchestrator.train_single_model(
            model_key=model,
            version=version,
            epochs=args.epochs,
            batch_size=args.batch,
            learning_rate=args.lr,
            auto_weight=args.auto_weight,
        )
    
    # Generate reports
    logger.info("Generating reports...")
    orchestrator.generate_reports()


if __name__ == "__main__":
    main()
