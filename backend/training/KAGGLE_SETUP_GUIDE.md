# Kaggle Training Setup Guide

This guide explains how to set up and run the consolidated YOLO training script on Kaggle.

## Overview

The `train_yolo_models.py` script is designed to run on Kaggle with minimal setup. It will:
- Train YOLOv8, v11, and v26 on classroom behavior detection datasets
- Compare ~30 model variants (2 models × 3 versions × ~5 hyperparameter combinations)
- Generate benchmark reports with recommendations
- Output all trained models and metrics

**Estimated runtime**: 24-48 hours depending on Kaggle GPU allocation

---

## Prerequisites

- Kaggle account with GPU access
- SCB-Dataset files (downloaded or referenced from Kaggle Datasets)

---

## Step 1: Prepare Your Dataset on Kaggle

### Option A: Use Existing SCB-Dataset on Kaggle

If SCB-Dataset is already available on Kaggle Datasets (e.g., from the GitHub repo):
1. Go to https://www.kaggle.com/datasets
2. Search for "SCB-Dataset" or "SmartClassroom"
3. Note the dataset name/ID

### Option B: Upload Your Own Dataset

1. Go to https://www.kaggle.com/datasets
2. Click "New Dataset"
3. Upload `.zip` files for each behavior model:
   - `SCB5-BowTurnHead.zip` (from `YOLO/SCB-Dataset/SCB5-BowTurnHead/`)
   - `SCB5-Discuss.zip` (from `YOLO/SCB-Dataset/SCB5-Discuss/`)
4. Note the dataset name (you'll use this when setting up the notebook)

---

## Step 2: Create a Kaggle Notebook

1. Go to https://www.kaggle.com/notebooks
2. Click "Create Notebook"
3. Choose **Python** environment with **GPU** accelerator

---

## Step 3: Set Up Notebook Environment

In the first cell, add dataset input:

```
# Click "Input" → "Add data input" → Select your SCB-Dataset
# This mounts the dataset to /kaggle/input/
```

In the second cell, install dependencies:

```python
!pip install -q ultralytics opencv-python pillow pandas matplotlib
```

---

## Step 4: Upload and Run Training Script

### Option A: Copy Script Directly

In a new cell, paste the full content of `train_yolo_models.py`:

```python
# Paste full content of train_yolo_models.py here
```

Then run training:

```python
import sys
sys.argv = ["train_yolo_models.py", "--all", "--grid-search"]
main()
```

### Option B: Upload as File

1. Download `train_yolo_models.py` locally
2. In Kaggle Notebook, create a cell with:

```python
# Create the script file
script_content = """
[paste full content of train_yolo_models.py]
"""

with open("/kaggle/working/train_yolo_models.py", "w") as f:
    f.write(script_content)
```

Then run:

```python
!cd /kaggle/working && python train_yolo_models.py --all --grid-search
```

---

## Step 5: Monitor Training

The script will print progress for each run:

```
2026-05-12 10:30:45 - Orchestrator - INFO - Starting training: v8/bow_turn (e=50, b=16, lr=0.01)
2026-05-12 10:35:22 - Orchestrator - INFO - Training completed: completed
2026-05-12 10:35:23 - Orchestrator - INFO - [1/30] Running: v8/bow_turn
...
```

**Key things to monitor:**
- GPU memory usage (aim for <90%)
- Training time per model (typically 10-20 min per 50 epochs)
- Total elapsed time

**If interrupted:** 
- Kaggle notebooks auto-save checkpoints
- Restart with `--resume` flag to continue from last checkpoint

---

## Step 6: Download Results

After training completes:

1. Click "Output" panel on the right
2. Download the `training_results/` folder containing:
   - `BENCHMARK_REPORT.md` — summary and recommendations
   - `metrics_comparison.csv` — detailed metrics
   - `comparison_plots.png` — visualization
   - `experiments.json` — all run logs
   - `v8/`, `v11/`, `v26/` folders with trained model weights

---

## Common Commands

### Quick Test (5 epochs per model)
```bash
python train_yolo_models.py --model bow_turn --yolo-version v8 --epochs 5
```

### Full Grid Search (all combinations)
```bash
python train_yolo_models.py --all --grid-search
```

### Train Single Model with Custom Params
```bash
python train_yolo_models.py --model discuss --yolo-version v11 --epochs 100 --batch 16 --lr 0.01
```

### Generate Reports from Existing Results
```bash
python train_yolo_models.py --report
```

### Resume Interrupted Training
```bash
python train_yolo_models.py --all --grid-search --resume
```

---

## Troubleshooting

### "Module ultralytics not found"
```bash
pip install ultralytics
```

### "CUDA out of memory"
- Reduce batch size: `--batch 8` or `--batch 4`
- Use smaller model: script uses nano variants (yolov8n, etc.)

### "Dataset not found"
- Verify dataset is added to notebook inputs
- Check dataset path in error message matches `/kaggle/input/...`

### "Training stopped unexpectedly"
- Kaggle notebooks have 12-hour runtime limit
- Use `--resume` flag to continue from checkpoint
- Consider running on RunPod or AutoDL instead for longer runs

---

## Output Structure

After successful training:

```
training_results/
├── BENCHMARK_REPORT.md          # Read this first!
├── metrics_comparison.csv       # Raw metrics table
├── comparison_plots.png         # Performance visualizations
├── experiments.json             # Complete training logs
├── datasets/
│   ├── bow_turn/split/          # Prepared dataset
│   └── discuss/split/
└── v8/, v11/, v26/             # Trained models per version
    ├── bow_turn/best.pt
    └── discuss/best.pt
```

---

## Next Steps After Training

1. **Review `BENCHMARK_REPORT.md`** for recommendations
2. **Analyze `metrics_comparison.csv`** for detailed metrics
3. **Select best YOLO version** based on:
   - mAP50/mAP50-95 (accuracy)
   - Inference time (speed)
   - Model size (deployment)
4. **Copy best models** to production:
   ```
   backend/models/yolo_weights/bow_turn/best.pt
   backend/models/yolo_weights/discuss/best.pt
   backend/models/yolo_weights/{other_models}/best.pt
   ```
5. **Integrate into `yolo_inference.py`** if model paths changed

---

## Cost Estimation

Kaggle provides **30 GPU hours per week** for free tier:
- Grid search (~30 runs, 20-40 min each) ≈ 10-20 GPU hours
- Should fit within free quota

If training is interrupted:
- Switch to **RunPod** or **AutoDL** for uninterrupted access
- Update dataset paths in script (same logic applies)

---

## Support

For issues:
1. Check logs in training output
2. Review `experiments.json` for failed runs
3. Post error messages in team chat with:
   - Error message
   - Command used
   - Kaggle notebook link (if shareable)
