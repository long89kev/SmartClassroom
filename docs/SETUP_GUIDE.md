# 📘 Hướng Dẫn Setup Dự Án Smart AI-IoT Classroom

> Tài liệu hướng dẫn chi tiết từng bước để cài đặt và chạy toàn bộ hệ thống Smart Classroom trên máy Windows.

---

## 📋 Mục Lục

1. [Yêu cầu hệ thống](#1-yêu-cầu-hệ-thống)
2. [Clone dự án](#2-clone-dự-án)
3. [Cấu hình biến môi trường](#3-cấu-hình-biến-môi-trường)
4. [Cách 1: Chạy bằng Docker (Khuyến nghị)](#4-cách-1-chạy-bằng-docker)
5. [Cách 2: Chạy Local (Không Docker)](#5-cách-2-chạy-local)
6. [Cách 3: Docker + GPU](#6-cách-3-docker--gpu-acceleration)
7. [Setup YOLO Weights](#7-setup-yolo-weights)
8. [Khởi tạo dữ liệu & tài khoản](#8-khởi-tạo-dữ-liệu--tài-khoản)
9. [Chạy Attendance Service](#9-chạy-attendance-camera-service)
10. [Chạy IoT Simulator (Không cần phần cứng)](#10-chạy-iot-simulator)
11. [Setup phần cứng ESP32 (Tùy chọn)](#11-setup-phần-cứng-esp32)
12. [Kiểm tra hệ thống](#12-kiểm-tra-hệ-thống)
13. [Các lệnh Docker hữu ích](#13-các-lệnh-docker-hữu-ích)
14. [Xử lý lỗi thường gặp](#14-xử-lý-lỗi-thường-gặp)

---

## 1. Yêu cầu hệ thống

### Phần mềm bắt buộc

| Phần mềm | Phiên bản | Link tải |
|-----------|-----------|----------|
| **Docker Desktop** | Latest | https://www.docker.com/products/docker-desktop |
| **Git** | Latest | https://git-scm.com/downloads |

### Phần mềm tùy chọn (cho dev local không Docker)

| Phần mềm | Phiên bản | Mục đích |
|-----------|-----------|----------|
| Python | 3.11+ | Backend FastAPI |
| Node.js | 18+ | Frontend React |
| PostgreSQL | 16 | Database |
| Redis | 7 | Cache |

### Phần mềm tùy chọn (cho phần cứng IoT)

| Phần mềm | Mục đích |
|-----------|----------|
| Arduino IDE | Flash firmware ESP32 |
| CP2102 Driver | USB-to-Serial cho ESP32 |

### Phần cứng tùy chọn (cho GPU acceleration)

- NVIDIA GPU (GTX 10xx trở lên)
- NVIDIA Driver 525+
- NVIDIA Container Toolkit (WSL2)

---

## 2. Clone dự án

```powershell
git clone <repository-url> SmartClassroom
cd SmartClassroom
```

---

## 3. Cấu hình biến môi trường

### Bước 3.1: Tạo file `.env` từ template

```powershell
copy .env.example .env
```

### Bước 3.2: Chỉnh sửa file `.env`

Mở file `.env` và cập nhật các giá trị quan trọng:

```ini
# ─── Database ───────────────────────────────────────
POSTGRES_USER=doai_user
POSTGRES_PASSWORD=doai_password          # ⚠️ Đổi cho production
POSTGRES_DB=doai_classroom
DATABASE_URL=postgresql://doai_user:doai_password@localhost:5432/doai_classroom

# ─── Redis ──────────────────────────────────────────
REDIS_URL=redis://localhost:6379/0

# ─── Auth ───────────────────────────────────────────
JWT_SECRET=your-super-secret-jwt-key     # ⚠️ Đổi cho production
DEBUG=True

# ─── YOLO AI Model ─────────────────────────────────
YOLO_MODEL_VERSION=v8
YOLO_WEIGHTS_PATH=backend/models/yolo_weights/
YOLO_CONFIDENCE_THRESHOLD=0.5
YOLO_DEVICE=auto                         # auto | cpu | cuda

# ─── MQTT ───────────────────────────────────────────
MQTT_BROKER_HOST=localhost
MQTT_BROKER_PORT=1883
MQTT_USE_MOCK=True

# ─── Embedded / Gateway ────────────────────────────
ROOM_CODE=B1-103
```

> [!IMPORTANT]
> Với môi trường **production**, bắt buộc phải đổi `JWT_SECRET` và `POSTGRES_PASSWORD`.

---

## 4. Cách 1: Chạy bằng Docker

> **Đây là cách đơn giản nhất**, chỉ cần Docker Desktop.

### Bước 4.1: Khởi động Docker Desktop

Mở Docker Desktop và đợi cho đến khi icon chuyển sang trạng thái **Running** (màu xanh).

### Bước 4.2: Build và start tất cả services

```powershell
docker compose up -d --build
```

Lệnh này sẽ tự động khởi động **6 services**:

| Service | Container | Port | Mô tả |
|---------|-----------|------|--------|
| PostgreSQL | `doai_postgres` | 5432 | Database chính |
| Redis | `doai_redis` | 6379 | Cache & pub/sub |
| Mosquitto | `doai_mosquitto` | 1883, 9001 | MQTT Broker |
| Backend | `doai_backend` | 8000 | FastAPI API Server |
| Frontend | `doai_frontend` | 5173 | React Dev Server |
| MQTT Gateway | `doai_mqtt_gateway` | — | Cầu nối MQTT ↔ Backend |
| pgAdmin | `doai_pgadmin` | 5050 | Quản lý DB (Web UI) |

### Bước 4.3: Kiểm tra trạng thái

```powershell
docker compose ps
```

Đợi tất cả services chuyển sang trạng thái `healthy` hoặc `running`.

### Bước 4.4: Truy cập ứng dụng

| Dịch vụ | URL |
|---------|-----|
| 🖥️ Frontend | http://localhost:5173 |
| ⚙️ Backend API | http://localhost:8000 |
| 📖 Swagger Docs | http://localhost:8000/docs |
| 📊 pgAdmin | http://localhost:5050 |

> **pgAdmin login**: Email `admin@doai.com` / Password `admin_password`

---

## 5. Cách 2: Chạy Local

> Dành cho developer muốn debug trực tiếp, không dùng Docker cho backend/frontend.

### Bước 5.1: Khởi động infrastructure bằng Docker

Vẫn cần Docker cho PostgreSQL, Redis, Mosquitto:

```powershell
docker compose up -d postgres redis mosquitto
```

### Bước 5.2: Setup Backend (Python)

```powershell
cd backend

# Tạo virtual environment
python -m venv venv

# Kích hoạt venv
.\venv\Scripts\activate

# Cài đặt dependencies
pip install -r requirements.txt

# Chạy backend server (auto-reload)
uvicorn app.main:app --reload --port 8000
```

> [!NOTE]
> Backend sử dụng **Python 3.11**. File `requirements.txt` cài PyTorch CPU version (~2GB download).

### Bước 5.3: Setup Frontend (Node.js)

Mở **terminal mới**:

```powershell
cd frontend

# Cài đặt packages
npm install

# Chạy dev server
npm run dev
```

Frontend sẽ chạy tại http://localhost:3000 (Vite dev server) với proxy tới backend.

### Bước 5.4: (Tùy chọn) Chạy MQTT Gateway

Mở **terminal mới**:

```powershell
cd embedded\gateway

pip install -r requirements.txt

python mqtt_gateway.py
```

---

## 6. Cách 3: Docker + GPU Acceleration

> Dành cho máy có NVIDIA GPU để tăng tốc YOLO inference.

### Yêu cầu trước

1. NVIDIA GPU (GTX 10xx+, RTX 20xx+, RTX 30xx+, RTX 40xx+, RTX 50xx+)
2. NVIDIA Driver phiên bản ≥525
3. Docker Desktop cấu hình WSL2 backend

### Bước 6.1: Kiểm tra GPU trong Docker

```powershell
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

Nếu thấy output `nvidia-smi` với thông tin GPU → sẵn sàng.

### Bước 6.2: Build và chạy với GPU override

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d
```

Lệnh này sẽ:
- Dùng `Dockerfile.gpu` (CUDA 12.4 + cuDNN 9) thay vì `Dockerfile` thường
- Cài `torch==2.5.1+cu124` và `onnxruntime-gpu`
- Tự động cấp phát 1 GPU cho backend container

### Bước 6.3: Xác nhận GPU hoạt động

```powershell
docker exec doai_backend python -c "import torch; print(f'CUDA: {torch.cuda.is_available()}, Device: {torch.cuda.get_device_name(0)}')"
```

---

## 7. Setup YOLO Weights

YOLO model weights được lưu tại `backend/models/yolo_weights/`. Dự án sử dụng **5 model groups** đã được train từ SCB-Dataset:

```
backend/models/yolo_weights/
├── student_bow_turn/          # best.pt + best.onnx
├── student_bow_turn_discuss/  # best.pt + best.onnx
├── student_discuss/           # best.pt + best.onnx
├── student_hand_read_write/   # best.pt + best.onnx
└── teacher_behavior/          # best.pt + best.onnx
```

> [!IMPORTANT]
> Mỗi thư mục cần chứa file `best.pt` (PyTorch) và/hoặc `best.onnx` (ONNX). Nếu thiếu, hãy download từ Google Drive của nhóm hoặc train lại từ SCB dataset.

> [!NOTE]
> File `best.pt` bị liệt kê trong `.gitignore`. Bạn cần copy thủ công hoặc download riêng.

---

## 8. Khởi tạo dữ liệu & tài khoản

### Bước 8.1: Database tự động khởi tạo

Khi chạy Docker lần đầu, PostgreSQL tự động chạy:
- `backend/migrations/init.sql` → Tạo 21 bảng (schema)
- `backend/migrations/data.sql` → Seed data (behavior classes, weights, buildings, rooms...)

### Bước 8.2: Tạo tài khoản Admin

```powershell
# PowerShell
Invoke-RestMethod -Uri "http://localhost:8000/auth/init-admin" `
  -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body '{"username":"admin","password":"admin123","email":"admin@classroom.ai"}'
```

### Bước 8.3: Đăng nhập lấy Token

```powershell
$login = Invoke-RestMethod -Uri "http://localhost:8000/auth/login" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"username":"admin","password":"admin123"}'

$token = $login.access_token
Write-Host "Token: $token"
```

### Bước 8.4: Test API

```powershell
$headers = @{"Authorization" = "Bearer $token"}

# Lấy danh sách buildings
Invoke-RestMethod -Uri "http://localhost:8000/api/buildings" `
  -Method GET -Headers $headers
```

Hoặc mở trình duyệt tại http://localhost:8000/docs để test qua Swagger UI.

---

## 9. Chạy Attendance Camera Service

> Service nhận diện khuôn mặt qua camera, chạy **ngoài Docker** (cần truy cập webcam).

### Bước 9.1: Cài đặt dependencies

```powershell
cd embedded\attendance

# Tạo venv riêng (khuyến nghị)
python -m venv venv
.\venv\Scripts\activate

pip install -r requirements.txt
```

**Dependencies chính**: `deepface`, `opencv-python`, `flask`, `tf-keras`

### Bước 9.2: (Tùy chọn) Enroll khuôn mặt

```powershell
python enroll_faces.py
```

Ảnh khuôn mặt được lưu trong `embedded/attendance/face_db/`.

### Bước 9.3: Chạy service

```powershell
python attendance_service.py
```

### Bước 9.4: Kiểm tra endpoints

| Endpoint | Mô tả |
|----------|--------|
| http://localhost:5051/health | Health check |
| http://localhost:5051/status | Trạng thái camera |
| http://localhost:5051/video_feed | Live video stream |

Frontend truy cập qua backend proxy: `/api/attendance/stream/video_feed`

---

## 10. Chạy IoT Simulator

> Test MQTT mà **không cần phần cứng ESP32**.

### Bước 10.1: Chạy mock ESP32

```powershell
cd embedded\simulator

pip install paho-mqtt

python mock_esp32.py --broker localhost --port 1883
```

Script này giả lập ESP32 gửi dữ liệu sensor (temperature, humidity, light) lên MQTT broker.

### Bước 10.2: Xác nhận dữ liệu MQTT

Mở terminal mới:

```powershell
# Subscribe tất cả topic classroom
docker exec doai_mosquitto mosquitto_sub -t "classroom/#" -v
```

Bạn sẽ thấy dữ liệu sensor được publish liên tục.

### Bước 10.3: Test điều khiển thiết bị

```powershell
# Bật relay 1 (LED Zone 1)
docker exec doai_mosquitto mosquitto_pub -t "classroom/actuators/relay/1" -m "ON"

# Đổi mode sang TESTING
docker exec doai_mosquitto mosquitto_pub -t "classroom/mode" -m "TESTING"

# Trigger alert LED
docker exec doai_mosquitto mosquitto_pub -t "classroom/actuators/alert_led" -m "ALERT"
```

---

## 11. Setup phần cứng ESP32

> **Tùy chọn** — Chỉ cần nếu bạn có phần cứng thật.

### Linh kiện cần thiết

| Linh kiện | SL | Kết nối |
|-----------|----|----|
| ESP32 DevKit V1 | 1 | USB to PC |
| DHT20 (I2C) | 1 | SDA→GPIO21, SCL→GPIO22 |
| Light Sensor (LDR) | 1 | AO→GPIO34 |
| 4-Channel Relay Module | 1 | IN1→GPIO25, IN2→GPIO26, IN3→GPIO27, IN4→GPIO14 |
| 16x2 LCD I2C | 1 | SDA→GPIO21, SCL→GPIO22 |
| Alert LED | 1 | (+)→GPIO32 |

### Bước 11.1: Cài Arduino IDE

Download tại https://www.arduino.cc/en/software

### Bước 11.2: Thêm ESP32 Board

1. **File → Preferences** → Additional Board Manager URLs:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
2. **Tools → Board → Board Manager** → Tìm "ESP32" → Install

### Bước 11.3: Cài thư viện Arduino

| Library | Tác giả |
|---------|---------|
| PubSubClient | Nick O'Leary |
| DHT20 | RobTillaart |
| LiquidCrystal_I2C | Frank de Brabander |
| ArduinoJson | Benoit Blanchon |

### Bước 11.4: Cấu hình WiFi & MQTT

Sửa file `embedded/esp32_node/config.h`:

```cpp
#define WIFI_SSID     "TenWiFiCuaBan"
#define WIFI_PASSWORD "MatKhauWiFi"
#define MQTT_BROKER_IP "192.168.1.xxx"   // IP máy chạy Docker
```

> Tìm IP bằng lệnh `ipconfig` trên máy chạy Docker.

### Bước 11.5: Flash firmware

1. Cắm ESP32 qua USB
2. **Tools → Board**: "ESP32 Dev Module"
3. **Tools → Port**: Chọn COM port
4. **Upload Speed**: 921600
5. Nhấn **Upload**
6. Mở **Serial Monitor** (115200 baud) để xem log

---

## 12. Kiểm tra hệ thống

### Checklist tổng quát

| # | Kiểm tra | Lệnh / URL | Expected |
|---|----------|-------------|----------|
| 1 | Docker services | `docker compose ps` | Tất cả `running`/`healthy` |
| 2 | Backend API | http://localhost:8000/docs | Swagger UI hiển thị |
| 3 | Frontend | http://localhost:5173 | Giao diện React load |
| 4 | Database | http://localhost:5050 | pgAdmin login OK |
| 5 | MQTT Broker | `docker exec doai_mosquitto mosquitto_sub -t "classroom/#" -v` | Nhận messages |
| 6 | Auth | POST `/auth/init-admin` → POST `/auth/login` | Nhận JWT token |
| 7 | Buildings API | GET `/api/buildings` | Trả về danh sách |

### Chạy smoke tests

```powershell
# Test Phase 1-2 APIs
.\scripts\testing\smoke_phase12.ps1

# Test Phase 3 (AI/Grading)
.\scripts\testing\smoke_phase3.ps1

# Test Role-based access
.\scripts\testing\smoke_role_access.ps1

# Test Weights validation
.\scripts\testing\test_weights_validation.ps1
```

---

## 13. Các lệnh Docker hữu ích

```powershell
# ─── Lifecycle ──────────────────────────────────────
docker compose up -d              # Start all (background)
docker compose down               # Stop all
docker compose restart backend    # Restart 1 service
docker compose up -d --build      # Rebuild & start

# ─── Logs ───────────────────────────────────────────
docker compose logs backend -f    # Follow backend logs
docker compose logs frontend -f   # Follow frontend logs
docker compose logs mosquitto -f  # Follow MQTT logs

# ─── Database ──────────────────────────────────────
docker exec -it doai_postgres psql -U doai_user -d doai_classroom
# Trong psql: \dt (list tables), \q (quit)

# ─── Reset hoàn toàn ──────────────────────────────
docker compose down -v            # ⚠️ Xóa tất cả data volumes
docker compose up -d --build      # Build lại từ đầu

# ─── MQTT debug ────────────────────────────────────
docker exec doai_mosquitto mosquitto_sub -t "classroom/#" -v
docker exec doai_mosquitto mosquitto_pub -t "classroom/test" -m "hello"
```

---

## 14. Xử lý lỗi thường gặp

### Docker

| Lỗi | Nguyên nhân | Giải pháp |
|-----|-------------|-----------|
| Port already in use | Service khác đang dùng port | Tắt service đó hoặc đổi port trong `docker-compose.yml` |
| Backend unhealthy | DB chưa sẵn sàng | Chờ thêm hoặc `docker compose restart backend` |
| `npm install` lỗi trong container | Network timeout | `docker compose down` → `docker compose up -d --build` |
| Hết disk space | Docker images/volumes quá nhiều | `docker system prune -a` |

### Backend

| Lỗi | Giải pháp |
|-----|-----------|
| `ModuleNotFoundError` | Kiểm tra đã activate venv: `.\venv\Scripts\activate` |
| `psycopg2` lỗi | Cài `psycopg2-binary`: đã có trong requirements.txt |
| YOLO model not found | Kiểm tra `backend/models/yolo_weights/` có file `best.pt` |
| Database connection refused | Kiểm tra PostgreSQL đang chạy (`docker compose ps`) |

### Frontend

| Lỗi | Giải pháp |
|-----|-----------|
| `node_modules` lỗi | Xóa `node_modules` → `npm install` lại |
| API 404/502 | Kiểm tra backend đang chạy và proxy config trong `vite.config.ts` |
| TypeScript errors | `npm run build` để xem chi tiết lỗi |

### ESP32

| Lỗi | Giải pháp |
|-----|-----------|
| WiFi không kết nối | ESP32 chỉ hỗ trợ **2.4GHz** (không hỗ trợ 5GHz) |
| MQTT connection failed | Kiểm tra `MQTT_BROKER_IP` đúng IP máy Docker; port 1883 mở |
| LCD không hiển thị | Thử đổi địa chỉ I2C sang `0x3F` trong `config.h` |
| DHT20 đọc lỗi | Kiểm tra nối dây SDA/SCL; đảm bảo cấp nguồn 3.3V |

---

## 🗺️ Kiến trúc tổng quan

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Host (Laptop)                      │
│                                                             │
│  ┌────────────┐  ┌────────┐  ┌──────────────────────────┐  │
│  │ PostgreSQL │  │ Redis  │  │   Mosquitto MQTT Broker   │  │
│  │ :5432      │  │ :6379  │  │   :1883 (MQTT)           │  │
│  └─────┬──────┘  └────────┘  │   :9001 (WebSocket)      │  │
│        │                      └────────────┬─────────────┘  │
│  ┌─────┴──────┐              ┌─────────────┴────────────┐  │
│  │  FastAPI   │◄── REST ────►│     MQTT Gateway          │  │
│  │  Backend   │              │     (Python)               │  │
│  │  :8000     │              └─────────────┬────────────┘  │
│  └─────┬──────┘                            │               │
│        │                                    │               │
│  ┌─────┴──────┐                            │               │
│  │  React     │                            │               │
│  │  Frontend  │                   MQTT (WiFi)              │
│  │  :5173     │                            │               │
│  └────────────┘                            │               │
└────────────────────────────────────────────┼───────────────┘
                                             │
                              ┌──────────────┼──────────────┐
                              │  ESP32 Node  │  ESP32-CAM   │
                              │  (Sensors)   │  (Camera)    │
                              └──────────────┴──────────────┘
                                   Physical Classroom
```

---

> [!TIP]
> **Quy trình khuyến nghị cho người mới:**
> 1. Cài Docker Desktop
> 2. Clone repo → `copy .env.example .env`
> 3. `docker compose up -d --build`
> 4. Đợi 2-3 phút → mở http://localhost:5173
> 5. Tạo admin account → Login → Khám phá!
