import json
import os

script_path = r"d:\Projects\DoAnDN\backend\training\train_yolo_models.py"
ipynb_path = r"d:\Projects\DoAnDN\backend\training\train_yolo_model.ipynb"

with open(script_path, "r", encoding="utf-8-sig") as f:
    script_content = f.read()

with open(ipynb_path, "r", encoding="utf-8-sig") as f:
    ipynb_data = json.load(f)

# Cell 3 is index 2
new_source = ["%%writefile train_yolo_models.py\n"]
script_lines = script_content.splitlines(keepends=True)
new_source.extend(script_lines)

ipynb_data["cells"][2]["source"] = new_source

with open(ipynb_path, "w", encoding="utf-8") as f:
    json.dump(ipynb_data, f, indent=1)

print(f"CellCount: {len(ipynb_data['cells'])}")
print(f"FirstLine: {ipynb_data['cells'][2]['source'][0].strip()}")
