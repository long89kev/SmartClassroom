$ErrorActionPreference = 'Stop'
$base = 'http://localhost:8000'

# Ensure stack is up
& docker compose up -d postgres redis backend | Out-Null

# Wait for health
$maxWait = 30
$healthy = $false
for ($i = 0; $i -lt $maxWait; $i++) {
    try {
        Invoke-RestMethod -Uri "$base/health" -Method Get | Out-Null
        $healthy = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $healthy) {
    throw "Backend did not become healthy within $maxWait seconds"
}

# Step 1: init admin (idempotent)
try {
    Invoke-RestMethod -Uri "$base/auth/init-admin" -Method Post -ContentType 'application/json' -Body '{}' | Out-Null
    Write-Output 'INIT_ADMIN=CREATED'
} catch {
    Write-Output 'INIT_ADMIN=EXISTS_OR_SKIPPED'
}

# Step 2: login
$login = @{ username = 'admin'; password = 'admin123' } | ConvertTo-Json
$loginResp = Invoke-RestMethod -Uri "$base/auth/login" -Method Post -ContentType 'application/json' -Body $login
$token = $loginResp.access_token
if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Login failed: empty token'
}
Write-Output "LOGIN=OK TOKEN_LEN=$($token.Length)"

# Seed minimal records for smoke tests
$seedSql = @"
INSERT INTO buildings (name, location, code)
SELECT 'Building B1','Main Campus','B1'
WHERE NOT EXISTS (SELECT 1 FROM buildings WHERE code='B1');

INSERT INTO floors (building_id, floor_number, name)
SELECT b.id, 1, 'Floor 1'
FROM buildings b
WHERE b.code='B1'
AND NOT EXISTS (
  SELECT 1 FROM floors f WHERE f.building_id=b.id AND f.floor_number=1
);

INSERT INTO rooms (floor_id, room_code, name, capacity, devices)
SELECT f.id, 'B1-103', 'Room B1-103', 40, '{}'::jsonb
FROM floors f
JOIN buildings b ON b.id=f.building_id
WHERE b.code='B1' AND f.floor_number=1
AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.room_code='B1-103');

INSERT INTO subjects (name, code, description)
SELECT 'Mathematics 101','MATH101','Intro Math'
WHERE NOT EXISTS (SELECT 1 FROM subjects WHERE code='MATH101');

INSERT INTO teachers (name, email, department)
SELECT 'Dr. Alice','alice@university.local','Mathematics'
WHERE NOT EXISTS (SELECT 1 FROM teachers WHERE email='alice@university.local');

INSERT INTO students (name, student_id, email, class)
SELECT 'Student One','S001','s001@university.local','K66'
WHERE NOT EXISTS (SELECT 1 FROM students WHERE student_id='S001');
"@
$seedSql | docker compose exec -T postgres psql -U doai_user -d doai_classroom | Out-Null

$bid = (& docker compose exec -T postgres psql -U doai_user -d doai_classroom -t -A -c "select id from buildings where code='B1' limit 1;").Trim()
$fid = (& docker compose exec -T postgres psql -U doai_user -d doai_classroom -t -A -c "select f.id from floors f join buildings b on b.id=f.building_id where b.code='B1' and f.floor_number=1 limit 1;").Trim()
$rid = (& docker compose exec -T postgres psql -U doai_user -d doai_classroom -t -A -c "select id from rooms where room_code='B1-103' limit 1;").Trim()
$sid = (& docker compose exec -T postgres psql -U doai_user -d doai_classroom -t -A -c "select id from subjects where code='MATH101' limit 1;").Trim()
$tid = (& docker compose exec -T postgres psql -U doai_user -d doai_classroom -t -A -c "select id from teachers where email='alice@university.local' limit 1;").Trim()
$stuid = (& docker compose exec -T postgres psql -U doai_user -d doai_classroom -t -A -c "select id from students where student_id='S001' limit 1;").Trim()

$results = @()
function Add-Result($name, $ok, $detail) {
    $script:results += [pscustomobject]@{ test = $name; ok = $ok; detail = $detail }
}

try { $x = Invoke-RestMethod -Uri "$base/api/buildings" -Method Get; Add-Result 'GET /api/buildings' $true "count=$($x.Count)" } catch { Add-Result 'GET /api/buildings' $false $_.Exception.Message }
try { $x = Invoke-RestMethod -Uri "$base/api/buildings/$bid/floors" -Method Get; Add-Result 'GET /api/buildings/{id}/floors' $true "count=$($x.Count)" } catch { Add-Result 'GET /api/buildings/{id}/floors' $false $_.Exception.Message }
try { $x = Invoke-RestMethod -Uri "$base/api/buildings/$bid/floors/$fid/rooms" -Method Get; Add-Result 'GET /api/buildings/{id}/floors/{id}/rooms' $true "count=$($x.Count)" } catch { Add-Result 'GET /api/buildings/{id}/floors/{id}/rooms' $false $_.Exception.Message }

try {
    $body = @{ device_id = 'light_001'; device_type = 'LIGHT'; location = 'ceiling_front'; power_consumption_watts = 50 } | ConvertTo-Json
    Invoke-RestMethod -Uri "$base/api/rooms/$rid/devices" -Method Post -ContentType 'application/json' -Body $body | Out-Null
    Add-Result 'POST /api/rooms/{id}/devices' $true 'created'
} catch {
    if ($_.Exception.Message -like '*400*') {
        Add-Result 'POST /api/rooms/{id}/devices' $true 'already exists'
    } else {
        Add-Result 'POST /api/rooms/{id}/devices' $false $_.Exception.Message
    }
}

try { $x = Invoke-RestMethod -Uri "$base/api/rooms/$rid/devices" -Method Get; Add-Result 'GET /api/rooms/{id}/devices' $true "count=$($x.device_count)" } catch { Add-Result 'GET /api/rooms/{id}/devices' $false $_.Exception.Message }

try {
    $body = @{ action = 'ON'; duration_minutes = 10 } | ConvertTo-Json
    $x = Invoke-RestMethod -Uri "$base/api/devices/light_001/toggle?room_id=$rid" -Method Post -ContentType 'application/json' -Body $body
    Add-Result 'POST /api/devices/{id}/toggle' $true "status=$($x.status)"
} catch { Add-Result 'POST /api/devices/{id}/toggle' $false $_.Exception.Message }

$sessionId = ''
try {
    $body = @{ room_id = $rid; teacher_id = $tid; subject_id = $sid; students_present = @($stuid) } | ConvertTo-Json
    $x = Invoke-RestMethod -Uri "$base/api/sessions" -Method Post -ContentType 'application/json' -Body $body
    $sessionId = $x.id
    Add-Result 'POST /api/sessions' $true "session_id=$sessionId"
} catch { Add-Result 'POST /api/sessions' $false $_.Exception.Message }

if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
    try { $body = @{ mode = 'TESTING' } | ConvertTo-Json; Invoke-RestMethod -Uri "$base/api/sessions/$sessionId/mode" -Method Put -ContentType 'application/json' -Body $body | Out-Null; Add-Result 'PUT /api/sessions/{id}/mode' $true 'TESTING' } catch { Add-Result 'PUT /api/sessions/{id}/mode' $false $_.Exception.Message }
    try { $body = @{ actor_id = $stuid; actor_type = 'STUDENT'; behavior_class = 'talking'; count = 2; duration_seconds = 5; yolo_confidence = 0.91 } | ConvertTo-Json; Invoke-RestMethod -Uri "$base/api/sessions/$sessionId/behavior" -Method Post -ContentType 'application/json' -Body $body | Out-Null; Add-Result 'POST /api/sessions/{id}/behavior' $true 'ingested' } catch { Add-Result 'POST /api/sessions/{id}/behavior' $false $_.Exception.Message }
    try { $x = Invoke-RestMethod -Uri "$base/api/sessions/$sessionId/analytics" -Method Get; Add-Result 'GET /api/sessions/{id}/analytics' $true "mode=$($x.mode),risk_alerts=$($x.risk_alerts_count)" } catch { Add-Result 'GET /api/sessions/{id}/analytics' $false $_.Exception.Message }
    try { $body = @{ session_id = $sessionId; student_id = $stuid; risk_score = 60; triggered_behaviors = @{ head_turns = 3; talk_events = 2; phone_duration = 10 } } | ConvertTo-Json -Depth 6; Invoke-RestMethod -Uri "$base/api/incidents" -Method Post -ContentType 'application/json' -Body $body | Out-Null; Add-Result 'POST /api/incidents' $true 'created' } catch { Add-Result 'POST /api/incidents' $false $_.Exception.Message }
    try { $x = Invoke-RestMethod -Uri "$base/api/rooms/$rid/incidents" -Method Get; Add-Result 'GET /api/rooms/{id}/incidents' $true "count=$($x.Count)" } catch { Add-Result 'GET /api/rooms/{id}/incidents' $false $_.Exception.Message }
    try { Invoke-RestMethod -Uri "$base/api/sessions/$sessionId/end" -Method Post | Out-Null; Add-Result 'POST /api/sessions/{id}/end' $true 'completed' } catch { Add-Result 'POST /api/sessions/{id}/end' $false $_.Exception.Message }
}

try {
    $body = @{ rule_name = 'Occupancy Rule Smoke'; room_id = $rid; condition_type = 'OCCUPANCY'; condition_params = @{ min_occupancy = 1; duration_minutes = 2 }; actions = @(@{ device_type = 'LIGHT'; action = 'ON' }); priority = 1 } | ConvertTo-Json -Depth 6
    Invoke-RestMethod -Uri "$base/api/rules" -Method Post -ContentType 'application/json' -Body $body | Out-Null
    Add-Result 'POST /api/rules' $true 'created'
} catch { Add-Result 'POST /api/rules' $false $_.Exception.Message }

try { $x = Invoke-RestMethod -Uri "$base/api/rules?room_id=$rid" -Method Get; Add-Result 'GET /api/rules?room_id' $true "count=$($x.Count)" } catch { Add-Result 'GET /api/rules?room_id' $false $_.Exception.Message }

Write-Output 'SMOKE_RESULTS_BEGIN'
$results | Format-Table -AutoSize | Out-String -Width 500
Write-Output 'SMOKE_RESULTS_END'

$failed = @($results | Where-Object { -not $_.ok }).Count
Write-Output "SMOKE_FAILED=$failed"
if ($failed -gt 0) { exit 2 }
