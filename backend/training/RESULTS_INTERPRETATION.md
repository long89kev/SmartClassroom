# YOLO Training Results Interpretation Guide

This guide explains how to interpret the benchmark reports and training results.

---

## Output Files

After training completes, you'll have:

```
training_results/
├── BENCHMARK_REPORT.md          # Executive summary & recommendations
├── metrics_comparison.csv       # Raw data for analysis
├── comparison_plots.png         # Performance visualizations
├── experiments.json             # Complete logs (all runs)
└── {version}/{model}/best.pt   # Trained model weights
```

---

## Key Files Explained

### 1. BENCHMARK_REPORT.md

**Start here.** Contains:

#### Summary Section
- Total number of experiments run
- Breakdown by YOLO version (e.g., "v8: 10 runs, v11: 10 runs, v26: 10 runs")

#### Detailed Results Table
Shows each trained model variant:

```
| Version | Model   | Epochs | Batch | LR    | Status    | Metrics |
|---------|---------|--------|-------|-------|-----------|---------|
| v8      | bow_turn| 50     | 16    | 0.01  | completed | {...}   |
| v8      | discuss | 100    | 32    | 0.001 | completed | {...}   |
```

**Column meanings:**
- **Version**: YOLO version (v8, v11, v26)
- **Model**: Behavior model trained (bow_turn, discuss)
- **Epochs**: Training epochs (higher = more training)
- **Batch**: Batch size (higher = faster but more memory)
- **LR**: Learning rate (higher = faster convergence but risk of overshooting)
- **Status**: "completed" = success, "failed" = error
- **Metrics**: Performance metrics (abbreviated in report)

#### Recommendations Section
Provides guidance on:
- Which version performed best
- Next steps for integration

### 2. metrics_comparison.csv

**For detailed analysis.** Open in Excel or pandas:

```python
import pandas as pd
df = pd.read_csv("metrics_comparison.csv")
df.head()
```

Each row is one training run with columns:
- `version`, `model_key`, `epochs`, `batch_size`, `learning_rate`, `status`
- `metric_*` columns with specific performance metrics (mAP50, precision, recall, etc.)

**Useful analysis:**
```python
# Find best model by mAP50
best = df.loc[df['metric_mAP50'].idxmax()]
print(f"Best model: {best['version']}/{best['model_key']} with mAP50={best['metric_mAP50']}")

# Compare versions
print(df.groupby('version')['metric_mAP50'].agg(['mean', 'max', 'std']))

# Filter successful runs
successful = df[df['status'] == 'completed']
```

### 3. comparison_plots.png

Visual comparison showing:
- **Bar chart 1**: Number of completed runs per YOLO version
- **Bar chart 2**: Status breakdown (successful vs failed)

---

## Interpreting Metrics

### Accuracy Metrics

**mAP50**: Mean Average Precision at IoU 0.5
- Range: 0-1 (or 0-100%)
- **What it means**: How many detections are correct at 50% overlap threshold
- **Goal**: Higher is better (typically 0.6+ is good)
- **Use case**: Most common metric in papers

**mAP50-95**: Mean Average Precision at IoU 0.5-0.95
- Range: 0-1 (or 0-100%)
- **What it means**: Average precision across all IoU thresholds
- **Goal**: Higher is better (typically 0.4+ is good)
- **Use case**: More strict metric for production

**Precision**: True Positives / (True Positives + False Positives)
- Range: 0-1
- **What it means**: Of all detections, what % are correct?
- **Goal**: Higher is better
- **Interpretation**: If Precision=0.95, then 95% of detected behaviors are actually there (5% false alarms)

**Recall**: True Positives / (True Positives + False Negatives)
- Range: 0-1
- **What it means**: Of all ground truth behaviors, what % did we find?
- **Goal**: Higher is better
- **Interpretation**: If Recall=0.85, then we catch 85% of behaviors (miss 15%)

**F1 Score**: Harmonic mean of Precision & Recall
- Formula: 2 × (Precision × Recall) / (Precision + Recall)
- Range: 0-1
- **What it means**: Balanced score between precision and recall
- **Goal**: Higher is better (balances false positives and false negatives)

### Speed Metrics

**avg_inference_time_ms**: Average inference time per image (milliseconds)
- Measured on test set
- **What it means**: How long to process one frame
- **Goal**: Lower is better (for real-time detection)
- **Real-time target**: <30ms for 30 FPS (33ms per frame)

**fps**: Frames per second at 640×640 resolution
- Calculated as: 1000 / avg_inference_time_ms
- **What it means**: How many frames can be processed per second
- **Goal**: Higher is better (typically 15-30 FPS for classroom video)
- **Real-time target**: ≥15 FPS for acceptable real-time performance

### Model Efficiency

**Model size**: File size of best.pt in MB
- Smaller = faster loading, less memory required
- **Goal**: Balance size with accuracy

---

## Decision Making Framework

Use this to choose the best YOLO version:

### Scenario 1: Real-Time Inference Priority
Choose based on **speed**:
1. Look at `avg_inference_time_ms` in results
2. Select version with lowest time while maintaining acceptable mAP50 (>0.5)
3. Example: v8 might be 15ms vs v11 20ms → choose v8

### Scenario 2: Maximum Accuracy Priority
Choose based on **mAP50**:
1. Filter to successful runs only
2. Find maximum `mAP50` score
3. Select that version/model variant
4. Example: v26 reaches 0.75 mAP50 vs v8 0.72 → choose v26

### Scenario 3: Balanced Approach (Recommended)
1. Create efficiency score: `efficiency = mAP50 / (inference_time_ms + model_size_mb)`
2. Rank models by efficiency score
3. Choose top 3 candidates
4. Manually review based on deployment constraints

**Example calculation:**
```python
# For each model in CSV:
df['efficiency'] = df['metric_mAP50'] / (df['speed_metrics_avg_inference_time_ms'] + 1)
top_models = df.nlargest(3, 'efficiency')
print(top_models[['version', 'model_key', 'metric_mAP50', 'speed_metrics_avg_inference_time_ms', 'efficiency']])
```

---

## Common Patterns & Interpretations

### Pattern 1: High mAP but Slow
**Observation**: v26 has mAP50=0.75, but inference_time=45ms
**Interpretation**: High accuracy but can't run real-time (30ms target)
**Action**: Either accept slower speed, or downgrade to faster version with slightly lower accuracy

### Pattern 2: Low Performance Across Versions
**Observation**: All versions have mAP50 < 0.4
**Interpretation**: Dataset might be too small, classes not balanced, or model not converging
**Action**: 
- Check `experiments.json` for training logs (loss should decrease)
- Verify dataset split is balanced
- Consider longer training (increase epochs)

### Pattern 3: Diminishing Returns with Larger Models
**Observation**: v8 mAP50=0.70 in 15ms, v11 mAP50=0.72 in 25ms
**Interpretation**: v11 is slightly more accurate but 67% slower
**Action**: For real-time use, v8 is better trade-off

### Pattern 4: One Model Significantly Better
**Observation**: v8/discuss mAP50=0.78 vs others 0.55-0.65
**Interpretation**: This model trained well, others may need tuning
**Action**: Review hyperparameters for this model, try similar settings on others

---

## Troubleshooting Poor Results

### Issue: Low accuracy (mAP50 < 0.3)

**Possible causes:**
1. Dataset too small or imbalanced
2. Learning rate too high (model diverges) or too low (doesn't converge)
3. Training interrupted before convergence
4. Wrong dataset path

**Solutions:**
- Check `experiments.json` for training curves (loss should smoothly decrease)
- Verify dataset: `python -c "import json; df = json.load(open('experiments.json')); print(df[0])"` 
- Try longer training: rerun with `--epochs 150`
- Try different learning rates: `--lr 0.001` or `--lr 0.005`

### Issue: Inference very slow (>100ms)

**Possible causes:**
1. Large model (v26) on slow GPU
2. High resolution input (640×640 is already large)
3. CPU fallback (GPU not available)

**Solutions:**
- Use smaller model (v8 nano)
- Check GPU availability: `nvidia-smi` in Kaggle
- Try lower resolution if acceptable (but will hurt accuracy)

### Issue: Training failed or crashed

**Possible causes:**
1. CUDA out of memory
2. Dataset file corruption
3. Script error

**Solutions:**
- Reduce batch size: `--batch 8` or `--batch 4`
- Re-extract dataset: delete `training_results/datasets/` and retry
- Check error in `experiments.json` for details
- Contact team with error message

---

## Integration Steps

Once you've selected the best model:

### 1. Copy Model to Production

From Kaggle results, download best model:
```
training_results/v8/bow_turn/best.pt
→ Copy to: backend/models/yolo_weights/bow_turn/best.pt
```

### 2. Update Inference Service (if paths changed)

Check `backend/app/services/yolo_inference.py`:
```python
MODEL_SPECS = [
    {
        "model_key": "student_bow_turn",
        "actor_type": "STUDENT",
        "relative_weight_path": ["yolo_weights", "student_bow_turn", "best.pt"],  # Verify this path
        ...
    }
]
```

### 3. Test Inference

```python
from backend.app.services.yolo_inference import YOLOInferenceService

service = YOLOInferenceService()
if service.is_ready():
    print("✓ Models loaded successfully")
else:
    print("✗ Failed to load models")
```

### 4. Benchmark Inference

Time end-to-end:
```python
import time
start = time.time()
result = service.process_frame(base64_image)
elapsed = time.time() - start
print(f"Processing time: {elapsed*1000:.1f}ms")
```

---

## Further Analysis

### Generate Custom Metrics

```python
import pandas as pd

df = pd.read_csv("metrics_comparison.csv")

# Best model per version
for version in ['v8', 'v11', 'v26']:
    subset = df[df['version'] == version]
    if not subset.empty:
        best = subset.loc[subset['metric_mAP50'].idxmax()]
        print(f"{version}: mAP50={best['metric_mAP50']:.3f}, "
              f"time={best['speed_metrics_avg_inference_time_ms']:.1f}ms, "
              f"model={best['model_key']}")

# Performance scaling with epochs
print("\nPerformance vs Training Epochs:")
for epochs in sorted(df['epochs'].unique()):
    subset = df[df['epochs'] == epochs]
    print(f"  {epochs} epochs: avg mAP50 = {subset['metric_mAP50'].mean():.3f}")

# Batch size impact
print("\nPerformance vs Batch Size:")
for batch in sorted(df['batch_size'].unique()):
    subset = df[df['batch_size'] == batch]
    print(f"  Batch {batch}: avg mAP50 = {subset['metric_mAP50'].mean():.3f}, "
          f"avg time = {subset['speed_metrics_avg_inference_time_ms'].mean():.1f}ms")
```

---

## Questions?

For detailed metrics or issues interpreting results:
1. Check `experiments.json` for complete run logs
2. Share relevant CSV snippet with team
3. Include benchmark plot for visual reference
