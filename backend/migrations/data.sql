-- ============================================================================
-- SMART AI-IOT CLASSROOM SYSTEM - MEANINGFUL DEMO DATA
-- ============================================================================
-- Run with:
--   psql -U doai_user -d doai_classroom -f backend/migrations/data.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Keep group-level polling defaults available for admin settings.
INSERT INTO refresh_interval_settings (id, scope_type, scope_id, mode, interval_ms, updated_by, created_at, updated_at)
VALUES
    (uuid_generate_v4(), 'GROUP', 'A', 'NORMAL', 3000, NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'GROUP', 'A', 'TESTING', 1000, NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'GROUP', 'B', 'NORMAL', 3000, NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'GROUP', 'B', 'TESTING', 1000, NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'GROUP', 'C', 'NORMAL', 3000, NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'GROUP', 'C', 'TESTING', 1000, NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'GROUP', 'LABS', 'NORMAL', 3000, NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'GROUP', 'LABS', 'TESTING', 1000, NULL, NOW(), NOW())
ON CONFLICT (scope_type, scope_id, mode) DO UPDATE SET
    interval_ms = EXCLUDED.interval_ms,
    updated_at = NOW();

-- Ensure attendance KPI defaults exist for dashboard analytics.
INSERT INTO attendance_board_thresholds (
    id,
    scope_type,
    scope_id,
    min_attendance_rate,
    max_late_rate,
    max_absent_rate,
    note,
    updated_by,
    created_at,
    updated_at
)
VALUES
    (uuid_generate_v4(), 'SCHOOL', 'GLOBAL', 85.00, 10.00, 15.00, 'School-wide baseline for all classrooms', NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'BUILDING', 'A', 88.00, 8.00, 12.00, 'Theory classrooms in block A require stable attendance', NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'BUILDING', 'B', 86.00, 9.00, 14.00, 'General lecture rooms in block B', NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'BUILDING', 'C', 84.00, 10.00, 15.00, 'Smaller classrooms in block C', NULL, NOW(), NOW()),
    (uuid_generate_v4(), 'BUILDING', 'LABS', 90.00, 6.00, 10.00, 'Lab attendance is stricter because of hands-on activities', NULL, NOW(), NOW())
ON CONFLICT (scope_type, scope_id) DO UPDATE SET
    min_attendance_rate = EXCLUDED.min_attendance_rate,
    max_late_rate = EXCLUDED.max_late_rate,
    max_absent_rate = EXCLUDED.max_absent_rate,
    note = EXCLUDED.note,
    updated_at = NOW();

-- Schema guard for older databases that may miss teachers.user_id.
ALTER TABLE teachers
ADD COLUMN IF NOT EXISTS user_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'teachers_user_id_fkey'
    ) THEN
        ALTER TABLE teachers
        ADD CONSTRAINT teachers_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;

END $$;


CREATE UNIQUE INDEX IF NOT EXISTS idx_teachers_user_id_unique
ON teachers (user_id)
WHERE user_id IS NOT NULL;

-- Stable demo accounts used by frontend and smoke tests.
INSERT INTO users (id, username, email, password_hash, role, is_active) VALUES
('550e8400-e29b-41d4-a716-446655440001'::UUID, 'instructor_demo', 'le.minh.hoang@smartcampus.local', '$2b$12$EJS8Y5nGPwWhGhG/Wh9vgeu0oBPBSnq7xRvqgh5ubYst5xA4uz7JS', 'INSTRUCTOR', TRUE),
('550e8400-e29b-41d4-a716-446655440004'::UUID, 'admin_demo', 'sysadmin@smartcampus.local', '$2b$12$EJS8Y5nGPwWhGhG/Wh9vgeu0oBPBSnq7xRvqgh5ubYst5xA4uz7JS', 'ACADEMIC_MANAGER', TRUE),
('550e8400-e29b-41d4-a716-446655440005'::UUID, 'facility_demo', 'facility.ops@smartcampus.local', '$2b$12$EJS8Y5nGPwWhGhG/Wh9vgeu0oBPBSnq7xRvqgh5ubYst5xA4uz7JS', 'FACILITY_STAFF', TRUE),
('550e8400-e29b-41d4-a716-446655440007'::UUID, 'student_demo', '22110001@student.smartcampus.local', '$2b$12$EJS8Y5nGPwWhGhG/Wh9vgeu0oBPBSnq7xRvqgh5ubYst5xA4uz7JS', 'STUDENT', TRUE)
ON CONFLICT (username) DO UPDATE SET
    email = EXCLUDED.email,
    password_hash = EXCLUDED.password_hash,
    role = EXCLUDED.role,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

INSERT INTO role_mode_access (role, can_switch_to_testing, can_switch_to_learning, can_view_reports)
VALUES
    ('INSTRUCTOR', TRUE, TRUE, TRUE),
    ('ACADEMIC_MANAGER', TRUE, TRUE, TRUE),
    ('FACILITY_STAFF', FALSE, TRUE, FALSE),
    ('STUDENT', FALSE, FALSE, TRUE)
ON CONFLICT (role) DO UPDATE SET
    can_switch_to_testing = EXCLUDED.can_switch_to_testing,
    can_switch_to_learning = EXCLUDED.can_switch_to_learning,
    can_view_reports = EXCLUDED.can_view_reports,
    updated_at = NOW();

DO $$
DECLARE
    v_instructor_user_id CONSTANT UUID := '550e8400-e29b-41d4-a716-446655440001'::UUID;
    v_admin_user_id CONSTANT UUID := '550e8400-e29b-41d4-a716-446655440004'::UUID;
    v_facility_user_id CONSTANT UUID := '550e8400-e29b-41d4-a716-446655440005'::UUID;
    v_student_user_id CONSTANT UUID := '550e8400-e29b-41d4-a716-446655440007'::UUID;

    v_current_day INT := EXTRACT(ISODOW FROM NOW())::INT - 1;

    v_building_name TEXT;
    v_building_code TEXT;
    v_room_code TEXT;
    v_building_id UUID;
    v_floor_id UUID;

    v_lecturer_teacher_id UUID;
    v_proctor_teacher_id UUID;
    v_ai_subject_id UUID;
    v_iot_subject_id UUID;
    v_test_subject_id UUID;

    v_ai_room_id UUID;
    v_iot_lab_room_id UUID;
    v_test_room_id UUID;
    v_lecturer_spare_room_id UUID;
    v_board_floor_id UUID;
    v_facility_floor_id UUID;
    v_ai_building_id UUID;
    v_iot_building_id UUID;
    v_test_building_id UUID;

    v_all_student_codes TEXT[] := ARRAY[
        '22110001', '22110005', '22110008', '22110012', '22110016', '22110021', '22110025', '22110029',
        '22110033', '22110037', '22110041', '22110045', '22110046', '22110047', '22110048', '22110049',
        '22110050', '22110051', '22110052', '22110053', '22110054', '22110055', '22110056', '22110057',
        '22110058', '22110059', '22110060', '22110061', '22110062', '22110063', '22110064', '22110065'
    ];
    v_ai_student_codes TEXT[] := ARRAY[
        '22110001', '22110005', '22110008', '22110012', '22110016', '22110021', '22110025', '22110029',
        '22110050', '22110051', '22110052', '22110053'
    ];
    v_iot_student_codes TEXT[] := ARRAY[
        '22110016', '22110021', '22110025', '22110029', '22110033', '22110037', '22110041', '22110045',
        '22110054', '22110055', '22110056', '22110057'
    ];
    v_test_student_codes TEXT[] := ARRAY[
        '22110001', '22110005', '22110008', '22110012', '22110016', '22110021', '22110025', '22110029',
        '22110058', '22110059', '22110060', '22110061'
    ];

    v_all_student_ids UUID[];
    v_ai_student_ids UUID[];
    v_iot_student_ids UUID[];
    v_test_student_ids UUID[];
    v_demo_teacher_ids UUID[];
    v_demo_subject_ids UUID[];
    v_history_date DATE;
    v_history_session_id UUID;
    v_history_subject_id UUID;
    v_history_teacher_id UUID;
    v_history_room_id UUID;
    v_day_offset INT;
    v_session_offset INT;
    v_random_student_id UUID;
    v_present_student_ids UUID[];
    v_late_student_ids UUID[];
    v_absent_student_ids UUID[];
    v_all_possible_subject_ids UUID[];
    v_all_possible_teacher_ids UUID[];
    v_all_possible_room_ids UUID[];

    v_timetable_ai_theory UUID;
    v_timetable_iot_lab UUID;
    v_timetable_ai_review UUID;
    v_timetable_test_exam UUID;

    v_session_ai_active UUID;
    v_session_iot_active UUID;
    v_session_test_active UUID;
    v_session_ai_completed UUID;
    v_session_iot_completed UUID;
    v_session_test_completed UUID;

    v_lab_building_names TEXT[] := ARRAY[
        'Science and Technology Incubators',
        'Research Center for Technology and Industrial Equipment (RECTIE)',
        'National Key Lab for Digital Control and System Engineering (DCSELAB)',
        'National Key Lab for Polymer and Composite Materials',
        'Research and Application Center for Construction Technology (REACTEC)',
        'Industrial Maintenance Training Center',
        'Business Research and Training Center',
        'Polymer Research Center',
        'Center for Developing Information Technology and Geographic Information System (Ditagis)',
        'Refinery and Petrochemical Technology Research Center (RPTC)'
    ];

    v_idx INT;
    v_room RECORD;
BEGIN
    -- ------------------------------------------------------------------------
    -- 1. Campus structure
    -- ------------------------------------------------------------------------
    FOR v_idx IN 1..5 LOOP
        v_building_code := 'A' || v_idx;

        INSERT INTO buildings (id, name, location, code, created_at, updated_at)
        VALUES (uuid_generate_v4(), v_building_code, 'Campus Zone A', v_building_code, NOW(), NOW())
        ON CONFLICT (name) DO UPDATE SET
            location = EXCLUDED.location,
            code = EXCLUDED.code,
            updated_at = NOW();

        SELECT id INTO v_building_id FROM buildings WHERE name = v_building_code;

        FOR v_room IN
            SELECT format('%s-%s%s', v_building_code, floor_num, LPAD(room_num::TEXT, 2, '0')) AS code, floor_num AS fnum
            FROM generate_series(1, 3) AS floor_num
            CROSS JOIN generate_series(1, 15) AS room_num
        LOOP
            INSERT INTO floors (id, building_id, floor_number, name, created_at, updated_at)
            VALUES (
                uuid_generate_v4(),
                v_building_id,
                v_room.fnum,
                'Floor ' || v_room.fnum::TEXT,
                NOW(),
                NOW()
            )
            ON CONFLICT (building_id, floor_number) DO UPDATE SET
                name = EXCLUDED.name,
                updated_at = NOW();

            SELECT id INTO v_floor_id
            FROM floors
            WHERE building_id = v_building_id
              AND floor_number = v_room.fnum;

            INSERT INTO rooms (id, floor_id, room_code, name, capacity, devices, created_at, updated_at)
            VALUES (
                uuid_generate_v4(),
                v_floor_id,
                v_room.code,
                replace(v_room.code, '-', ' '),
                30,
                '{"device_list": []}'::jsonb,
                NOW(),
                NOW()
            )
            ON CONFLICT (room_code) DO UPDATE SET
                floor_id = EXCLUDED.floor_id,
                name = EXCLUDED.name,
                capacity = EXCLUDED.capacity,
                updated_at = NOW();
        END LOOP;
    END LOOP;

    FOR v_idx IN 1..11 LOOP
        v_building_code := 'B' || v_idx;

        INSERT INTO buildings (id, name, location, code, created_at, updated_at)
        VALUES (uuid_generate_v4(), v_building_code, 'Campus Zone B', v_building_code, NOW(), NOW())
        ON CONFLICT (name) DO UPDATE SET
            location = EXCLUDED.location,
            code = EXCLUDED.code,
            updated_at = NOW();

        SELECT id INTO v_building_id FROM buildings WHERE name = v_building_code;

        FOR v_room IN
            SELECT format('%s-%s%s', v_building_code, floor_num, LPAD(room_num::TEXT, 2, '0')) AS code, floor_num AS fnum
            FROM generate_series(1, 6) AS floor_num
            CROSS JOIN generate_series(1, 5) AS room_num
        LOOP
            INSERT INTO floors (id, building_id, floor_number, name, created_at, updated_at)
            VALUES (
                uuid_generate_v4(),
                v_building_id,
                v_room.fnum,
                'Floor ' || v_room.fnum::TEXT,
                NOW(),
                NOW()
            )
            ON CONFLICT (building_id, floor_number) DO UPDATE SET
                name = EXCLUDED.name,
                updated_at = NOW();

            SELECT id INTO v_floor_id
            FROM floors
            WHERE building_id = v_building_id
              AND floor_number = v_room.fnum;

            INSERT INTO rooms (id, floor_id, room_code, name, capacity, devices, created_at, updated_at)
            VALUES (
                uuid_generate_v4(),
                v_floor_id,
                v_room.code,
                replace(v_room.code, '-', ' '),
                35,
                '{"device_list": []}'::jsonb,
                NOW(),
                NOW()
            )
            ON CONFLICT (room_code) DO UPDATE SET
                floor_id = EXCLUDED.floor_id,
                name = EXCLUDED.name,
                capacity = EXCLUDED.capacity,
                updated_at = NOW();
        END LOOP;
    END LOOP;

    FOREACH v_building_code IN ARRAY ARRAY['C4', 'C5', 'C6'] LOOP
        INSERT INTO buildings (id, name, location, code, created_at, updated_at)
        VALUES (uuid_generate_v4(), v_building_code, 'Campus Zone C', v_building_code, NOW(), NOW())
        ON CONFLICT (name) DO UPDATE SET
            location = EXCLUDED.location,
            code = EXCLUDED.code,
            updated_at = NOW();

        SELECT id INTO v_building_id FROM buildings WHERE name = v_building_code;

        FOR v_room IN
            SELECT format('%s-%s%s', v_building_code, floor_num, LPAD(room_num::TEXT, 2, '0')) AS code, floor_num AS fnum
            FROM generate_series(1, 2) AS floor_num
            CROSS JOIN generate_series(1, 5) AS room_num
        LOOP
            INSERT INTO floors (id, building_id, floor_number, name, created_at, updated_at)
            VALUES (
                uuid_generate_v4(),
                v_building_id,
                v_room.fnum,
                'Floor ' || v_room.fnum::TEXT,
                NOW(),
                NOW()
            )
            ON CONFLICT (building_id, floor_number) DO UPDATE SET
                name = EXCLUDED.name,
                updated_at = NOW();

            SELECT id INTO v_floor_id
            FROM floors
            WHERE building_id = v_building_id
              AND floor_number = v_room.fnum;

            INSERT INTO rooms (id, floor_id, room_code, name, capacity, devices, created_at, updated_at)
            VALUES (
                uuid_generate_v4(),
                v_floor_id,
                v_room.code,
                replace(v_room.code, '-', ' '),
                28,
                '{"device_list": []}'::jsonb,
                NOW(),
                NOW()
            )
            ON CONFLICT (room_code) DO UPDATE SET
                floor_id = EXCLUDED.floor_id,
                name = EXCLUDED.name,
                capacity = EXCLUDED.capacity,
                updated_at = NOW();
        END LOOP;
    END LOOP;

    FOR v_idx IN 1..array_length(v_lab_building_names, 1) LOOP
        v_building_name := v_lab_building_names[v_idx];
        v_building_code := 'LAB' || v_idx;

        INSERT INTO buildings (id, name, location, code, created_at, updated_at)
        VALUES (uuid_generate_v4(), v_building_name, 'Research Campus', v_building_code, NOW(), NOW())
        ON CONFLICT (name) DO UPDATE SET
            location = EXCLUDED.location,
            code = EXCLUDED.code,
            updated_at = NOW();

        SELECT id INTO v_building_id FROM buildings WHERE name = v_building_name;

        FOR v_room IN
            SELECT format('%s-%s%s', v_building_code, floor_num, LPAD(room_num::TEXT, 2, '0')) AS code, floor_num AS fnum
            FROM generate_series(1, 2) AS floor_num
            CROSS JOIN generate_series(1, 5) AS room_num
        LOOP
            INSERT INTO floors (id, building_id, floor_number, name, created_at, updated_at)
            VALUES (
                uuid_generate_v4(),
                v_building_id,
                v_room.fnum,
                'Floor ' || v_room.fnum::TEXT,
                NOW(),
                NOW()
            )
            ON CONFLICT (building_id, floor_number) DO UPDATE SET
                name = EXCLUDED.name,
                updated_at = NOW();

            SELECT id INTO v_floor_id
            FROM floors
            WHERE building_id = v_building_id
              AND floor_number = v_room.fnum;

            INSERT INTO rooms (id, floor_id, room_code, name, capacity, devices, created_at, updated_at)
            VALUES (
                uuid_generate_v4(),
                v_floor_id,
                v_room.code,
                replace(v_room.code, '-', ' '),
                25,
                '{"device_list": []}'::jsonb,
                NOW(),
                NOW()
            )
            ON CONFLICT (room_code) DO UPDATE SET
                floor_id = EXCLUDED.floor_id,
                name = EXCLUDED.name,
                capacity = EXCLUDED.capacity,
                updated_at = NOW();
        END LOOP;
    END LOOP;

    -- ------------------------------------------------------------------------
    -- 2. Clean up old placeholder data from previous demo versions
    -- ------------------------------------------------------------------------
    DELETE FROM attendance_events
    WHERE session_id IN (
        SELECT cs.id
        FROM class_sessions cs
        LEFT JOIN subjects s ON s.id = cs.subject_id
        LEFT JOIN teachers t ON t.id = cs.teacher_id
        WHERE s.code = 'MOCK101'
           OR t.email = 'mock.teacher@campus.local'
    );

    DELETE FROM attendance_session_configs
    WHERE session_id IN (
        SELECT cs.id
        FROM class_sessions cs
        LEFT JOIN subjects s ON s.id = cs.subject_id
        LEFT JOIN teachers t ON t.id = cs.teacher_id
        WHERE s.code = 'MOCK101'
           OR t.email = 'mock.teacher@campus.local'
    );

    DELETE FROM class_sessions
    WHERE id IN (
        SELECT cs.id
        FROM class_sessions cs
        LEFT JOIN subjects s ON s.id = cs.subject_id
        LEFT JOIN teachers t ON t.id = cs.teacher_id
        WHERE s.code = 'MOCK101'
           OR t.email = 'mock.teacher@campus.local'
    );

    DELETE FROM timetable
    WHERE subject_id IN (SELECT id FROM subjects WHERE code = 'MOCK101')
       OR teacher_id IN (SELECT id FROM teachers WHERE email = 'mock.teacher@campus.local');

    DELETE FROM enrollments
    WHERE subject_id IN (SELECT id FROM subjects WHERE code = 'MOCK101')
       OR student_id IN (SELECT id FROM students WHERE student_id LIKE 'MOCK-STU-%');

    DELETE FROM attendance_face_templates
    WHERE student_id IN (SELECT id FROM students WHERE student_id LIKE 'MOCK-STU-%');

    DELETE FROM students WHERE student_id LIKE 'MOCK-STU-%';
    DELETE FROM subjects WHERE code = 'MOCK101';
    DELETE FROM teachers WHERE email = 'mock.teacher@campus.local';

    -- ------------------------------------------------------------------------
    -- 3. Meaningful teacher, subject, and student profiles
    -- ------------------------------------------------------------------------
    UPDATE teachers
    SET user_id = NULL
    WHERE user_id = v_instructor_user_id
      AND email NOT IN ('le.minh.hoang@smartcampus.local', 'tran.quoc.tuan@smartcampus.local');

    UPDATE students
    SET user_id = NULL
    WHERE user_id = v_student_user_id
      AND student_id <> '22110001';

    INSERT INTO teachers (id, name, email, user_id, phone, department, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), 'Le Minh Hoang', 'le.minh.hoang@smartcampus.local', v_instructor_user_id, '0908000001', 'School of Computer Science and Engineering', NOW(), NOW()),
        (uuid_generate_v4(), 'Tran Quoc Tuan', 'tran.quoc.tuan@smartcampus.local', NULL, '0908000002', 'Academic Testing Center', NOW(), NOW()),
        (uuid_generate_v4(), 'Nguyen Van An', 'an.nguyen@smartcampus.local', NULL, '0908000003', 'Information Technology', NOW(), NOW()),
        (uuid_generate_v4(), 'Pham Minh Duc', 'duc.pham@smartcampus.local', NULL, '0908000004', 'Electronics and Telecommunications', NOW(), NOW())
    ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        user_id = EXCLUDED.user_id,
        phone = EXCLUDED.phone,
        department = EXCLUDED.department,
        updated_at = NOW();

    SELECT id INTO v_lecturer_teacher_id FROM teachers WHERE email = 'le.minh.hoang@smartcampus.local';
    SELECT id INTO v_proctor_teacher_id FROM teachers WHERE email = 'tran.quoc.tuan@smartcampus.local';

    INSERT INTO subjects (id, name, code, description, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), 'Computer Vision Applications', 'AI3307', 'Applied computer vision for smart classroom analytics and camera-based understanding.', NOW(), NOW()),
        (uuid_generate_v4(), 'Internet of Things Systems', 'EE2305', 'Sensor integration, MQTT workflows, and classroom automation fundamentals.', NOW(), NOW()),
        (uuid_generate_v4(), 'Software Testing and Quality Assurance', 'SE3315', 'Quality assurance, exam supervision flow, and evidence-based incident review.', NOW(), NOW()),
        (uuid_generate_v4(), 'Deep Learning Frameworks', 'AI4401', 'Advanced neural networks and framework-level optimization.', NOW(), NOW()),
        (uuid_generate_v4(), 'Embedded Linux Systems', 'EE4402', 'Kernel optimization and peripheral drivers for embedded devices.', NOW(), NOW()),
        (uuid_generate_v4(), 'Cloud Native Architectures', 'SE4403', 'Kubernetes, serverless, and distributed system design.', NOW(), NOW()),
        (uuid_generate_v4(), 'Cybersecurity Defense', 'IT4404', 'Network security and penetration testing methodologies.', NOW(), NOW()),
        (uuid_generate_v4(), 'Natural Language Processing', 'AI4405', 'Transformer models and semantic understanding.', NOW(), NOW())
    ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        updated_at = NOW();

    SELECT id INTO v_ai_subject_id FROM subjects WHERE code = 'AI3307';
    SELECT id INTO v_iot_subject_id FROM subjects WHERE code = 'EE2305';
    SELECT id INTO v_test_subject_id FROM subjects WHERE code = 'SE3315';

    INSERT INTO students (id, name, student_id, email, user_id, class, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), 'Nguyen Gia Bao', '22110001', '22110001@student.smartcampus.local', v_student_user_id, 'SE-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Tran Minh Khoa', '22110005', '22110005@student.smartcampus.local', NULL, 'SE-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Le Quoc Anh', '22110008', '22110008@student.smartcampus.local', NULL, 'SE-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Pham Thu Trang', '22110012', '22110012@student.smartcampus.local', NULL, 'SE-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Vo Thanh Dat', '22110016', '22110016@student.smartcampus.local', NULL, 'SE-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Nguyen Hoang Mai', '22110021', '22110021@student.smartcampus.local', NULL, 'AI-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Bui Khanh Linh', '22110025', '22110025@student.smartcampus.local', NULL, 'AI-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Do Duc Huy', '22110029', '22110029@student.smartcampus.local', NULL, 'AI-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Phan Thu Uyen', '22110033', '22110033@student.smartcampus.local', NULL, 'EE-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Trinh Gia Han', '22110037', '22110037@student.smartcampus.local', NULL, 'EE-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Dang Tuan Kiet', '22110041', '22110041@student.smartcampus.local', NULL, 'EE-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Hoang Bao Chau', '22110045', '22110045@student.smartcampus.local', NULL, 'EE-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Nguyen Van Phuc', '22110046', '22110046@student.smartcampus.local', NULL, 'IT-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Le Thi Thu', '22110047', '22110047@student.smartcampus.local', NULL, 'IT-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Tran Quang Khai', '22110048', '22110048@student.smartcampus.local', NULL, 'IT-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Pham My Linh', '22110049', '22110049@student.smartcampus.local', NULL, 'IT-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Bui Minh Quan', '22110050', '22110050@student.smartcampus.local', NULL, 'AI-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Hoang Nhat Minh', '22110051', '22110051@student.smartcampus.local', NULL, 'AI-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Vu Thanh Tung', '22110052', '22110052@student.smartcampus.local', NULL, 'AI-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Nguyen Ngoc Anh', '22110053', '22110053@student.smartcampus.local', NULL, 'AI-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Do Tuan Anh', '22110054', '22110054@student.smartcampus.local', NULL, 'EE-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Pham Gia Bao', '22110055', '22110055@student.smartcampus.local', NULL, 'EE-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Le Anh Tuan', '22110056', '22110056@student.smartcampus.local', NULL, 'EE-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Tran Thu Ha', '22110057', '22110057@student.smartcampus.local', NULL, 'EE-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Nguyen Hoang Long', '22110058', '22110058@student.smartcampus.local', NULL, 'SE-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Phan Thanh Hai', '22110059', '22110059@student.smartcampus.local', NULL, 'SE-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Dang Minh Khoi', '22110060', '22110060@student.smartcampus.local', NULL, 'SE-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Trinh Thu Huong', '22110061', '22110061@student.smartcampus.local', NULL, 'SE-2023', NOW(), NOW()),
        (uuid_generate_v4(), 'Bui Xuan Truong', '22110062', '22110062@student.smartcampus.local', NULL, 'IT-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Nguyen My Duyen', '22110063', '22110063@student.smartcampus.local', NULL, 'IT-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Pham Quoc Cuong', '22110064', '22110064@student.smartcampus.local', NULL, 'IT-2022', NOW(), NOW()),
        (uuid_generate_v4(), 'Le Minh Duc', '22110065', '22110065@student.smartcampus.local', NULL, 'IT-2022', NOW(), NOW())
    ON CONFLICT (student_id) DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        user_id = EXCLUDED.user_id,
        class = EXCLUDED.class,
        updated_at = NOW();

    SELECT ARRAY_AGG(id ORDER BY student_id) INTO v_all_student_ids
    FROM students
    WHERE student_id = ANY(v_all_student_codes);

    SELECT ARRAY_AGG(id ORDER BY student_id) INTO v_ai_student_ids
    FROM students
    WHERE student_id = ANY(v_ai_student_codes);

    SELECT ARRAY_AGG(id ORDER BY student_id) INTO v_iot_student_ids
    FROM students
    WHERE student_id = ANY(v_iot_student_codes);

    SELECT ARRAY_AGG(id ORDER BY student_id) INTO v_test_student_ids
    FROM students
    WHERE student_id = ANY(v_test_student_codes);

    DELETE FROM enrollments
    WHERE subject_id IN (v_ai_subject_id, v_iot_subject_id, v_test_subject_id);

    INSERT INTO enrollments (id, student_id, subject_id, enrollment_date)
    SELECT uuid_generate_v4(), s.id, v_ai_subject_id, NOW() - INTERVAL '60 days'
    FROM students s
    WHERE s.student_id = ANY(v_ai_student_codes);

    INSERT INTO enrollments (id, student_id, subject_id, enrollment_date)
    SELECT uuid_generate_v4(), s.id, v_iot_subject_id, NOW() - INTERVAL '45 days'
    FROM students s
    WHERE s.student_id = ANY(v_iot_student_codes);

    INSERT INTO enrollments (id, student_id, subject_id, enrollment_date)
    SELECT uuid_generate_v4(), s.id, v_test_subject_id, NOW() - INTERVAL '30 days'
    FROM students s
    WHERE s.student_id = ANY(v_test_student_codes);

    DELETE FROM attendance_face_templates
    WHERE student_id = ANY(v_all_student_ids);

    INSERT INTO attendance_face_templates (id, student_id, embedding, quality_score, is_active, created_at, updated_at)
    SELECT
        uuid_generate_v4(),
        ranked.id,
        jsonb_build_array(
            ROUND((0.110000 + ranked.rn * 0.010000)::numeric, 6),
            ROUND((0.220000 + ranked.rn * 0.008000)::numeric, 6),
            ROUND((0.330000 + ranked.rn * 0.007000)::numeric, 6),
            ROUND((0.440000 + ranked.rn * 0.006000)::numeric, 6),
            ROUND((0.550000 + ranked.rn * 0.005000)::numeric, 6),
            ROUND((0.660000 + ranked.rn * 0.004000)::numeric, 6),
            ROUND((0.770000 + ranked.rn * 0.003000)::numeric, 6),
            ROUND((0.880000 + ranked.rn * 0.002000)::numeric, 6)
        ),
        ROUND((0.8500 + random() * 0.1400)::numeric, 4),
        TRUE,
        NOW(),
        NOW()
    FROM (
        SELECT s.id, ROW_NUMBER() OVER (ORDER BY s.student_id) AS rn
        FROM students s
        WHERE s.student_id = ANY(v_all_student_codes)
    ) AS ranked;

    -- Subject-specific attendance KPIs and learning weights.
    INSERT INTO attendance_board_thresholds (
        id,
        scope_type,
        scope_id,
        min_attendance_rate,
        max_late_rate,
        max_absent_rate,
        note,
        updated_by,
        created_at,
        updated_at
    )
    VALUES
        (uuid_generate_v4(), 'SUBJECT', 'AI3307', 88.00, 8.00, 12.00, 'Core AI theory class baseline', v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), 'SUBJECT', 'EE2305', 90.00, 6.00, 10.00, 'Hands-on IoT lab attendance threshold', v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), 'SUBJECT', 'SE3315', 95.00, 3.00, 5.00, 'Exam-oriented subject requires near-perfect punctuality', v_admin_user_id, NOW(), NOW())
    ON CONFLICT (scope_type, scope_id) DO UPDATE SET
        min_attendance_rate = EXCLUDED.min_attendance_rate,
        max_late_rate = EXCLUDED.max_late_rate,
        max_absent_rate = EXCLUDED.max_absent_rate,
        note = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW();

    DELETE FROM performance_weights
    WHERE subject_id IN (v_ai_subject_id, v_iot_subject_id);

    INSERT INTO performance_weights (id, subject_id, behavior_name, actor_type, weight, is_active, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_ai_subject_id, 'hand-raising', 'STUDENT', 12.0, TRUE, NOW(), NOW()),
        (uuid_generate_v4(), v_ai_subject_id, 'answering', 'STUDENT', 18.0, TRUE, NOW(), NOW()),
        (uuid_generate_v4(), v_iot_subject_id, 'using-computer', 'STUDENT', 10.0, TRUE, NOW(), NOW()),
        (uuid_generate_v4(), v_iot_subject_id, 'discussing', 'STUDENT', 8.0, TRUE, NOW(), NOW()),
        (uuid_generate_v4(), v_iot_subject_id, 'guiding', 'TEACHER', 11.0, TRUE, NOW(), NOW())
    ON CONFLICT (subject_id, behavior_name, actor_type) DO UPDATE SET
        weight = EXCLUDED.weight,
        is_active = EXCLUDED.is_active,
        updated_at = NOW();

    -- ------------------------------------------------------------------------
    -- 4. Room lookup, device inventory, occupancy, sensors, and rules
    -- ------------------------------------------------------------------------
    SELECT r.id, f.id, f.building_id INTO v_ai_room_id, v_board_floor_id, v_ai_building_id
    FROM rooms r
    JOIN floors f ON f.id = r.floor_id
    WHERE r.room_code = 'A1-203';

    SELECT r.id, f.building_id INTO v_iot_lab_room_id, v_iot_building_id
    FROM rooms r
    JOIN floors f ON f.id = r.floor_id
    WHERE r.room_code = 'LAB9-102';

    SELECT r.id, f.id, f.building_id INTO v_test_room_id, v_facility_floor_id, v_test_building_id
    FROM rooms r
    JOIN floors f ON f.id = r.floor_id
    WHERE r.room_code = 'B1-102';

    SELECT id INTO v_lecturer_spare_room_id
    FROM rooms
    WHERE room_code = 'A2-105';

    IF v_ai_room_id IS NULL OR v_iot_lab_room_id IS NULL OR v_test_room_id IS NULL THEN
        RAISE NOTICE 'Critical demo rooms are missing. Room-dependent seed skipped.';
        RETURN;
    END IF;

    FOR v_room IN
        SELECT r.id, r.room_code, SUBSTRING(r.room_code FROM '^[A-Z0-9]+') AS building_code
        FROM rooms r
        ORDER BY r.room_code
        LIMIT 80
    LOOP
        DELETE FROM room_devices WHERE room_id = v_room.id;

        DECLARE
            v_num_lights INT := 4;
            v_num_fans INT := 2;
            v_num_acs INT := 1;
            v_i INT;
        BEGIN
            IF v_room.building_code = 'A1' THEN
                v_num_lights := 4;
                v_num_fans := 4;
                v_num_acs := 2;
            ELSIF v_room.building_code = 'A2' THEN
                v_num_lights := 6;
                v_num_fans := 4;
                v_num_acs := 1;
            ELSIF v_room.building_code = 'B1' THEN
                v_num_lights := 4;
                v_num_fans := 2;
                v_num_acs := 2;
            END IF;

            FOR v_i IN 1..v_num_lights LOOP
                INSERT INTO room_devices (id, room_id, device_id, device_type, device_index, location_front_back, location_left_right, x_percent, y_percent, power_consumption_watts, is_active, source, created_at, updated_at)
                VALUES (uuid_generate_v4(), v_room.id, REPLACE(v_room.room_code, ' ', '') || '-LIGHT-0' || v_i, 'LIGHT', v_i, CASE WHEN v_i % 2 = 1 THEN 'FRONT' ELSE 'BACK' END, CASE WHEN v_i <= v_num_lights/2 THEN 'LEFT' ELSE 'RIGHT' END, 20 + (v_i * 10), 20, 48, TRUE, 'IMPORT', NOW(), NOW());
            END LOOP;

            FOR v_i IN 1..v_num_fans LOOP
                INSERT INTO room_devices (id, room_id, device_id, device_type, device_index, location_front_back, location_left_right, x_percent, y_percent, power_consumption_watts, is_active, source, created_at, updated_at)
                VALUES (uuid_generate_v4(), v_room.id, REPLACE(v_room.room_code, ' ', '') || '-FAN-0' || v_i, 'FAN', v_i, CASE WHEN v_i % 2 = 1 THEN 'FRONT' ELSE 'BACK' END, CASE WHEN v_i <= v_num_fans/2 THEN 'LEFT' ELSE 'RIGHT' END, 30 + (v_i * 10), 30, 120, TRUE, 'IMPORT', NOW(), NOW());
            END LOOP;

            FOR v_i IN 1..v_num_acs LOOP
                INSERT INTO room_devices (id, room_id, device_id, device_type, device_index, location_front_back, location_left_right, x_percent, y_percent, power_consumption_watts, is_active, source, created_at, updated_at)
                VALUES (uuid_generate_v4(), v_room.id, REPLACE(v_room.room_code, ' ', '') || '-AC-0' || v_i, 'AC', v_i, 'BACK', CASE WHEN v_i = 1 THEN 'RIGHT' ELSE 'LEFT' END, 80, 20 + (v_i * 10), 1500, TRUE, 'IMPORT', NOW(), NOW());
            END LOOP;
        END;

        UPDATE rooms
        SET devices = jsonb_build_object(
            'device_list',
            (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'device_id', rd.device_id,
                        'device_type', rd.device_type,
                        'device_index', rd.device_index,
                        'location_front_back', rd.location_front_back,
                        'location_left_right', rd.location_left_right,
                        'location', rd.location_front_back || '_' || rd.location_left_right,
                        'status', CASE
                            WHEN rd.device_type = 'AC' THEN 'OFF'
                            ELSE 'ON'
                        END,
                        'mqtt_topic', 'building/*/floor/*/room/' || v_room.room_code || '/device/' || rd.device_id || '/state',
                        'power_consumption_watts', rd.power_consumption_watts
                    )
                    ORDER BY rd.device_id
                )
                FROM room_devices rd
                WHERE rd.room_id = v_room.id
            )
        )
        WHERE id = v_room.id;

        DELETE FROM device_states WHERE room_id = v_room.id;

        INSERT INTO device_states (id, room_id, device_id, device_type, device_index, status, manual_override, last_updated, updated_at)
        SELECT
            uuid_generate_v4(),
            rd.room_id,
            rd.device_id,
            rd.device_type,
            rd.device_index,
            CASE
                WHEN rd.device_type = 'AC' THEN 'OFF'
                ELSE 'ON'
            END,
            FALSE,
            NOW(),
            NOW()
        FROM room_devices rd
        WHERE rd.room_id = v_room.id;
    END LOOP;

    INSERT INTO room_device_thresholds (id, room_id, device_type_code, min_value, max_value, target_value, enabled, updated_by, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_ai_room_id, 'LIGHT', 250, 650, 420, TRUE, v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), v_ai_room_id, 'AC', 22, 27, 24, TRUE, v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), v_iot_lab_room_id, 'LIGHT', 300, 700, 500, TRUE, v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), v_iot_lab_room_id, 'AC', 21, 26, 23, TRUE, v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), v_test_room_id, 'LIGHT', 350, 750, 520, TRUE, v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), v_test_room_id, 'AC', 21, 25, 22.5, TRUE, v_admin_user_id, NOW(), NOW())
    ON CONFLICT (room_id, device_type_code) DO UPDATE SET
        min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value,
        target_value = EXCLUDED.target_value,
        enabled = EXCLUDED.enabled,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW();

    INSERT INTO room_occupancy (id, room_id, occupancy_count, is_occupied, last_detected, updated_at)
    VALUES
        (uuid_generate_v4(), v_ai_room_id, 27, TRUE, NOW() - INTERVAL '1 minute', NOW()),
        (uuid_generate_v4(), v_iot_lab_room_id, 18, TRUE, NOW() - INTERVAL '2 minutes', NOW()),
        (uuid_generate_v4(), v_test_room_id, 31, TRUE, NOW() - INTERVAL '1 minute', NOW()),
        (uuid_generate_v4(), v_lecturer_spare_room_id, 0, FALSE, NOW() - INTERVAL '45 minutes', NOW())
    ON CONFLICT (room_id) DO UPDATE SET
        occupancy_count = EXCLUDED.occupancy_count,
        is_occupied = EXCLUDED.is_occupied,
        last_detected = EXCLUDED.last_detected,
        updated_at = NOW();

    DELETE FROM room_sensor_readings
    WHERE room_id IN (v_ai_room_id, v_iot_lab_room_id, v_test_room_id, v_lecturer_spare_room_id);

    INSERT INTO room_sensor_readings (id, room_id, sensor_key, value, unit, source_topic, captured_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_ai_room_id, 'TEMPERATURE', 24.4, 'C', 'building/A1/floor/2/room/A1-203/sensor/temperature', NOW() - INTERVAL '30 seconds', NOW()),
        (uuid_generate_v4(), v_ai_room_id, 'HUMIDITY', 61.0, '%', 'building/A1/floor/2/room/A1-203/sensor/humidity', NOW() - INTERVAL '30 seconds', NOW()),
        (uuid_generate_v4(), v_ai_room_id, 'CO2', 780.0, 'PPM', 'building/A1/floor/2/room/A1-203/sensor/co2', NOW() - INTERVAL '30 seconds', NOW()),
        (uuid_generate_v4(), v_iot_lab_room_id, 'TEMPERATURE', 23.1, 'C', 'building/LAB9/floor/1/room/LAB9-102/sensor/temperature', NOW() - INTERVAL '45 seconds', NOW()),
        (uuid_generate_v4(), v_iot_lab_room_id, 'HUMIDITY', 57.0, '%', 'building/LAB9/floor/1/room/LAB9-102/sensor/humidity', NOW() - INTERVAL '45 seconds', NOW()),
        (uuid_generate_v4(), v_iot_lab_room_id, 'NOISE', 47.0, 'DB', 'building/LAB9/floor/1/room/LAB9-102/sensor/noise', NOW() - INTERVAL '45 seconds', NOW()),
        (uuid_generate_v4(), v_test_room_id, 'TEMPERATURE', 22.7, 'C', 'building/B1/floor/1/room/B1-102/sensor/temperature', NOW() - INTERVAL '20 seconds', NOW()),
        (uuid_generate_v4(), v_test_room_id, 'LIGHT', 515.0, 'LUX', 'building/B1/floor/1/room/B1-102/sensor/light', NOW() - INTERVAL '20 seconds', NOW()),
        (uuid_generate_v4(), v_test_room_id, 'CO2', 690.0, 'PPM', 'building/B1/floor/1/room/B1-102/sensor/co2', NOW() - INTERVAL '20 seconds', NOW()),
        (uuid_generate_v4(), v_lecturer_spare_room_id, 'TEMPERATURE', 29.2, 'C', 'building/A2/floor/1/room/A2-105/sensor/temperature', NOW() - INTERVAL '15 minutes', NOW()),
        (uuid_generate_v4(), v_lecturer_spare_room_id, 'LIGHT', 80.0, 'LUX', 'building/A2/floor/1/room/A2-105/sensor/light', NOW() - INTERVAL '15 minutes', NOW());

    DELETE FROM iot_rules
    WHERE rule_name IN (
        'Global occupied-room startup',
        'Block A pre-class cooling',
        'Exam room lighting lock',
        'IoT lab idle shutdown'
    );

    INSERT INTO iot_rules (
        id,
        rule_name,
        scope_type,
        building_id,
        room_id,
        condition_type,
        condition_params,
        actions,
        is_active,
        priority,
        created_at,
        updated_at,
        last_triggered
    ) VALUES
        (
            uuid_generate_v4(),
            'Global occupied-room startup',
            'GLOBAL',
            NULL,
            NULL,
            'OCCUPANCY',
            '{"min_occupancy": 1, "duration_minutes": 2}'::jsonb,
            '[{"device_type": "LIGHT", "action": "ON"}, {"device_type": "CAMERA", "action": "ON"}]'::jsonb,
            TRUE,
            10,
            NOW(),
            NOW(),
            NOW() - INTERVAL '12 minutes'
        ),
        (
            uuid_generate_v4(),
            'Block A pre-class cooling',
            'BUILDING',
            v_ai_building_id,
            NULL,
            'TIMETABLE',
            '{"minutes_before": 10}'::jsonb,
            '[{"device_type": "AC", "action": "ON"}, {"device_type": "LIGHT", "action": "ON"}]'::jsonb,
            TRUE,
            7,
            NOW(),
            NOW(),
            NOW() - INTERVAL '20 minutes'
        ),
        (
            uuid_generate_v4(),
            'Exam room lighting lock',
            'ROOM',
            NULL,
            v_test_room_id,
            'TIME_BASED',
            '{"from": "07:00", "to": "18:00"}'::jsonb,
            '[{"device_type": "LIGHT", "action": "ON"}, {"device_type": "CAMERA", "action": "ON"}]'::jsonb,
            TRUE,
            9,
            NOW(),
            NOW(),
            NOW() - INTERVAL '6 minutes'
        ),
        (
            uuid_generate_v4(),
            'IoT lab idle shutdown',
            'ROOM',
            NULL,
            v_iot_lab_room_id,
            'ZERO_OCCUPANCY',
            '{"idle_minutes": 20}'::jsonb,
            '[{"device_type": "LIGHT", "action": "OFF"}, {"device_type": "AC", "action": "OFF"}, {"device_type": "FAN", "action": "OFF"}]'::jsonb,
            TRUE,
            5,
            NOW(),
            NOW(),
            NOW() - INTERVAL '3 hours'
        );

    -- ------------------------------------------------------------------------
    -- 5. Demo room assignments, block scope, and timetable
    -- ------------------------------------------------------------------------
    DELETE FROM user_room_assignments
    WHERE user_id IN (v_instructor_user_id, v_instructor_user_id);

    DELETE FROM user_block_assignments
    WHERE user_id IN (v_admin_user_id, v_facility_user_id);

    INSERT INTO user_room_assignments (id, user_id, room_id, can_view, can_control, assigned_by, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_instructor_user_id, v_ai_room_id, TRUE, TRUE, v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), v_instructor_user_id, v_iot_lab_room_id, TRUE, TRUE, v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), v_instructor_user_id, v_lecturer_spare_room_id, TRUE, TRUE, v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), v_instructor_user_id, v_test_room_id, TRUE, TRUE, v_admin_user_id, NOW(), NOW());

    INSERT INTO user_block_assignments (id, user_id, floor_id, can_view, can_control, assigned_by, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_admin_user_id, v_board_floor_id, TRUE, FALSE, v_admin_user_id, NOW(), NOW()),
        (uuid_generate_v4(), v_facility_user_id, v_facility_floor_id, TRUE, TRUE, v_admin_user_id, NOW(), NOW());

    DELETE FROM timetable
    WHERE teacher_id IN (v_lecturer_teacher_id, v_proctor_teacher_id);

    INSERT INTO timetable (id, subject_id, teacher_id, room_id, day_of_week, start_time, end_time, expected_students, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_ai_subject_id, v_lecturer_teacher_id, v_ai_room_id, v_current_day, '08:00', '09:50', 40, NOW(), NOW())
    RETURNING id INTO v_timetable_ai_theory;

    INSERT INTO timetable (id, subject_id, teacher_id, room_id, day_of_week, start_time, end_time, expected_students, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_iot_subject_id, v_lecturer_teacher_id, v_iot_lab_room_id, v_current_day, '13:00', '14:50', 24, NOW(), NOW())
    RETURNING id INTO v_timetable_iot_lab;

    INSERT INTO timetable (id, subject_id, teacher_id, room_id, day_of_week, start_time, end_time, expected_students, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_ai_subject_id, v_lecturer_teacher_id, v_lecturer_spare_room_id, v_current_day, '15:00', '16:50', 35, NOW(), NOW())
    RETURNING id INTO v_timetable_ai_review;

    INSERT INTO timetable (id, subject_id, teacher_id, room_id, day_of_week, start_time, end_time, expected_students, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_test_subject_id, v_proctor_teacher_id, v_test_room_id, v_current_day, '09:00', '10:30', 32, NOW(), NOW())
    RETURNING id INTO v_timetable_test_exam;

    -- ------------------------------------------------------------------------
    -- 6. Recreate deterministic sessions and analytics
    -- ------------------------------------------------------------------------
    v_demo_teacher_ids := ARRAY[v_lecturer_teacher_id, v_proctor_teacher_id];
    v_demo_subject_ids := ARRAY[v_ai_subject_id, v_iot_subject_id, v_test_subject_id];

    DELETE FROM attendance_events
    WHERE session_id IN (
        SELECT id
        FROM class_sessions
        WHERE teacher_id = ANY(v_demo_teacher_ids)
          AND subject_id = ANY(v_demo_subject_ids)
    );

    DELETE FROM attendance_session_configs
    WHERE session_id IN (
        SELECT id
        FROM class_sessions
        WHERE teacher_id = ANY(v_demo_teacher_ids)
          AND subject_id = ANY(v_demo_subject_ids)
    );

    DELETE FROM class_sessions
    WHERE teacher_id = ANY(v_demo_teacher_ids)
      AND subject_id = ANY(v_demo_subject_ids);

    INSERT INTO class_sessions (
        id,
        room_id,
        teacher_id,
        subject_id,
        timetable_id,
        mode,
        start_time,
        end_time,
        students_present,
        final_performance_score,
        final_risk_score,
        status,
        created_at,
        updated_at
    )
    VALUES (
        uuid_generate_v4(),
        v_ai_room_id,
        v_lecturer_teacher_id,
        v_ai_subject_id,
        v_timetable_ai_theory,
        'NORMAL',
        NOW() - INTERVAL '35 minutes',
        NULL,
        to_jsonb(ARRAY[
            v_ai_student_ids[1], v_ai_student_ids[2], v_ai_student_ids[3], v_ai_student_ids[4],
            v_ai_student_ids[5], v_ai_student_ids[6], v_ai_student_ids[7]
        ]),
        NULL,
        NULL,
        'ACTIVE',
        NOW(),
        NOW()
    )
    RETURNING id INTO v_session_ai_active;

    INSERT INTO class_sessions (
        id,
        room_id,
        teacher_id,
        subject_id,
        timetable_id,
        mode,
        start_time,
        end_time,
        students_present,
        final_performance_score,
        final_risk_score,
        status,
        created_at,
        updated_at
    )
    VALUES (
        uuid_generate_v4(),
        v_iot_lab_room_id,
        v_lecturer_teacher_id,
        v_iot_subject_id,
        v_timetable_iot_lab,
        'NORMAL',
        NOW() - INTERVAL '95 minutes',
        NULL,
        to_jsonb(ARRAY[
            v_iot_student_ids[1], v_iot_student_ids[2], v_iot_student_ids[3], v_iot_student_ids[4],
            v_iot_student_ids[6], v_iot_student_ids[8]
        ]),
        NULL,
        NULL,
        'ACTIVE',
        NOW(),
        NOW()
    )
    RETURNING id INTO v_session_iot_active;

    INSERT INTO class_sessions (
        id,
        room_id,
        teacher_id,
        subject_id,
        timetable_id,
        mode,
        start_time,
        end_time,
        students_present,
        final_performance_score,
        final_risk_score,
        status,
        created_at,
        updated_at
    )
    VALUES (
        uuid_generate_v4(),
        v_test_room_id,
        v_proctor_teacher_id,
        v_test_subject_id,
        v_timetable_test_exam,
        'TESTING',
        NOW() - INTERVAL '18 minutes',
        NULL,
        to_jsonb(ARRAY[
            v_test_student_ids[1], v_test_student_ids[2], v_test_student_ids[3],
            v_test_student_ids[5], v_test_student_ids[6], v_test_student_ids[7], v_test_student_ids[8]
        ]),
        NULL,
        0.74,
        'ACTIVE',
        NOW(),
        NOW()
    )
    RETURNING id INTO v_session_test_active;

    INSERT INTO class_sessions (
        id,
        room_id,
        teacher_id,
        subject_id,
        mode,
        start_time,
        end_time,
        students_present,
        final_performance_score,
        final_risk_score,
        status,
        created_at,
        updated_at
    )
    VALUES (
        uuid_generate_v4(),
        v_ai_room_id,
        v_lecturer_teacher_id,
        v_ai_subject_id,
        'NORMAL',
        NOW() - INTERVAL '2 days 2 hours',
        NOW() - INTERVAL '2 days 20 minutes',
        to_jsonb(ARRAY[
            v_ai_student_ids[1], v_ai_student_ids[2], v_ai_student_ids[3],
            v_ai_student_ids[5], v_ai_student_ids[6], v_ai_student_ids[7]
        ]),
        84.6,
        NULL,
        'COMPLETED',
        NOW(),
        NOW()
    )
    RETURNING id INTO v_session_ai_completed;

    INSERT INTO class_sessions (
        id,
        room_id,
        teacher_id,
        subject_id,
        mode,
        start_time,
        end_time,
        students_present,
        final_performance_score,
        final_risk_score,
        status,
        created_at,
        updated_at
    )
    VALUES (
        uuid_generate_v4(),
        v_iot_lab_room_id,
        v_lecturer_teacher_id,
        v_iot_subject_id,
        'NORMAL',
        NOW() - INTERVAL '5 days 4 hours',
        NOW() - INTERVAL '5 days 2 hours 20 minutes',
        to_jsonb(ARRAY[
            v_iot_student_ids[1], v_iot_student_ids[2], v_iot_student_ids[3], v_iot_student_ids[4],
            v_iot_student_ids[5], v_iot_student_ids[6], v_iot_student_ids[8]
        ]),
        86.1,
        NULL,
        'COMPLETED',
        NOW(),
        NOW()
    )
    RETURNING id INTO v_session_iot_completed;

    INSERT INTO class_sessions (
        id,
        room_id,
        teacher_id,
        subject_id,
        mode,
        start_time,
        end_time,
        students_present,
        final_performance_score,
        final_risk_score,
        status,
        created_at,
        updated_at
    )
    VALUES (
        uuid_generate_v4(),
        v_test_room_id,
        v_proctor_teacher_id,
        v_test_subject_id,
        'TESTING',
        NOW() - INTERVAL '7 days 90 minutes',
        NOW() - INTERVAL '7 days 5 minutes',
        to_jsonb(ARRAY[
            v_test_student_ids[2], v_test_student_ids[3], v_test_student_ids[4],
            v_test_student_ids[5], v_test_student_ids[7], v_test_student_ids[8]
        ]),
        NULL,
        0.58,
        'COMPLETED',
        NOW(),
        NOW()
    )
    RETURNING id INTO v_session_test_completed;

    INSERT INTO attendance_session_configs (id, session_id, grace_minutes, min_confidence, auto_checkin_enabled, created_at, updated_at)
    VALUES
        (uuid_generate_v4(), v_session_ai_active, 10, 0.78, TRUE, NOW(), NOW()),
        (uuid_generate_v4(), v_session_iot_active, 8, 0.80, TRUE, NOW(), NOW()),
        (uuid_generate_v4(), v_session_test_active, 5, 0.82, TRUE, NOW(), NOW()),
        (uuid_generate_v4(), v_session_ai_completed, 10, 0.78, TRUE, NOW(), NOW()),
        (uuid_generate_v4(), v_session_iot_completed, 8, 0.80, TRUE, NOW(), NOW()),
        (uuid_generate_v4(), v_session_test_completed, 5, 0.82, TRUE, NOW(), NOW());

    INSERT INTO behavior_logs (
        id, session_id, actor_id, actor_type, behavior_class, count, duration_seconds, detected_at, yolo_confidence, created_at
    ) VALUES
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[1], 'STUDENT', 'hand-raising', 2, 18, NOW() - INTERVAL '12 minutes', 0.94, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[1], 'STUDENT', 'answering', 1, 25, NOW() - INTERVAL '9 minutes', 0.92, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[2], 'STUDENT', 'writing', 4, 210, NOW() - INTERVAL '15 minutes', 0.91, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[3], 'STUDENT', 'reading', 3, 170, NOW() - INTERVAL '11 minutes', 0.89, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[4], 'STUDENT', 'discussing', 2, 96, NOW() - INTERVAL '6 minutes', 0.86, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_lecturer_teacher_id, 'TEACHER', 'guiding', 5, 420, NOW() - INTERVAL '14 minutes', 0.93, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_lecturer_teacher_id, 'TEACHER', 'blackboard-writing', 4, 360, NOW() - INTERVAL '7 minutes', 0.90, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[1], 'STUDENT', 'using-computer', 4, 540, NOW() - INTERVAL '40 minutes', 0.93, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[2], 'STUDENT', 'discussing', 2, 88, NOW() - INTERVAL '28 minutes', 0.87, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[3], 'STUDENT', 'writing', 3, 165, NOW() - INTERVAL '31 minutes', 0.88, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[4], 'STUDENT', 'using-computer', 5, 610, NOW() - INTERVAL '22 minutes', 0.94, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_lecturer_teacher_id, 'TEACHER', 'guiding', 4, 300, NOW() - INTERVAL '36 minutes', 0.91, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_lecturer_teacher_id, 'TEACHER', 'on-stage-interaction', 3, 180, NOW() - INTERVAL '17 minutes', 0.89, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[2], 'STUDENT', 'talking', 1, 18, NOW() - INTERVAL '10 minutes', 0.83, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[3], 'STUDENT', 'bow-head', 3, 74, NOW() - INTERVAL '8 minutes', 0.81, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[7], 'STUDENT', 'using-phone', 1, 42, NOW() - INTERVAL '5 minutes', 0.92, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_proctor_teacher_id, 'TEACHER', 'guiding', 2, 120, NOW() - INTERVAL '6 minutes', 0.88, NOW()),
        (uuid_generate_v4(), v_session_ai_completed, v_ai_student_ids[1], 'STUDENT', 'writing', 3, 190, NOW() - INTERVAL '2 days 70 minutes', 0.90, NOW()),
        (uuid_generate_v4(), v_session_ai_completed, v_ai_student_ids[2], 'STUDENT', 'answering', 1, 20, NOW() - INTERVAL '2 days 55 minutes', 0.91, NOW()),
        (uuid_generate_v4(), v_session_ai_completed, v_lecturer_teacher_id, 'TEACHER', 'blackboard', 4, 280, NOW() - INTERVAL '2 days 50 minutes', 0.87, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[1], 'STUDENT', 'using-computer', 4, 600, NOW() - INTERVAL '5 days 160 minutes', 0.92, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[4], 'STUDENT', 'discussing', 2, 90, NOW() - INTERVAL '5 days 130 minutes', 0.85, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_lecturer_teacher_id, 'TEACHER', 'guiding', 3, 240, NOW() - INTERVAL '5 days 145 minutes', 0.90, NOW());

    INSERT INTO performance_aggregates (id, session_id, actor_id, actor_type, total_score, behavior_breakdown, calculated_at)
    VALUES
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[1], 'STUDENT', 82.0, '{"hand-raising": 2, "answering": 1}'::jsonb, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[2], 'STUDENT', 76.0, '{"writing": 4}'::jsonb, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_lecturer_teacher_id, 'TEACHER', 88.5, '{"guiding": 5, "blackboard-writing": 4}'::jsonb, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[1], 'STUDENT', 85.0, '{"using-computer": 4}'::jsonb, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[4], 'STUDENT', 87.0, '{"using-computer": 5}'::jsonb, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_lecturer_teacher_id, 'TEACHER', 84.0, '{"guiding": 4, "on-stage-interaction": 3}'::jsonb, NOW()),
        (uuid_generate_v4(), v_session_ai_completed, v_ai_student_ids[2], 'STUDENT', 79.0, '{"answering": 1}'::jsonb, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[1], 'STUDENT', 83.0, '{"using-computer": 4}'::jsonb, NOW())
    ON CONFLICT (session_id, actor_id) DO UPDATE SET
        total_score = EXCLUDED.total_score,
        behavior_breakdown = EXCLUDED.behavior_breakdown,
        calculated_at = EXCLUDED.calculated_at;

    INSERT INTO risk_incidents (
        id,
        session_id,
        student_id,
        risk_score,
        risk_level,
        triggered_behaviors,
        flagged_at,
        reviewed,
        reviewer_id,
        reviewer_notes,
        reviewed_at,
        created_at
    ) VALUES
        (
            uuid_generate_v4(),
            v_session_test_active,
            v_test_student_ids[3],
            0.82,
            'CRITICAL',
            '{"head-turning": 4, "talking": 2}'::jsonb,
            NOW() - INTERVAL '7 minutes',
            FALSE,
            NULL,
            NULL,
            NULL,
            NOW()
        ),
        (
            uuid_generate_v4(),
            v_session_test_active,
            v_test_student_ids[7],
            0.68,
            'HIGH',
            '{"phone-usage": 1, "head-turning": 2}'::jsonb,
            NOW() - INTERVAL '4 minutes',
            FALSE,
            NULL,
            NULL,
            NULL,
            NOW()
        ),
        (
            uuid_generate_v4(),
            v_session_test_completed,
            v_test_student_ids[4],
            0.58,
            'MEDIUM',
            '{"talking": 2, "head-turning": 2}'::jsonb,
            NOW() - INTERVAL '7 days 45 minutes',
            TRUE,
            v_proctor_teacher_id,
            'Student was warned once; no evidence of coordinated cheating after review.',
            NOW() - INTERVAL '7 days 10 minutes',
            NOW()
        );

    -- Attendance events: AI3307 active.
    INSERT INTO attendance_events (id, session_id, student_id, source, face_confidence, is_recognized, occurred_at, metadata, created_by_user_id, created_at)
    VALUES
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[1], 'DOOR_CAMERA_GATEWAY', 0.97, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_active) + INTERVAL '4 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[2], 'DOOR_CAMERA_GATEWAY', 0.94, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_active) + INTERVAL '5 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[3], 'DOOR_CAMERA_GATEWAY', 0.93, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_active) + INTERVAL '7 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[4], 'DOOR_CAMERA_GATEWAY', 0.90, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_active) + INTERVAL '14 minutes', '{"arrival_type": "late", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[5], 'DOOR_CAMERA_GATEWAY', 0.96, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_active) + INTERVAL '3 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[6], 'DOOR_CAMERA_GATEWAY', 0.91, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_active) + INTERVAL '8 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[7], 'DOOR_CAMERA_GATEWAY', 0.88, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_active) + INTERVAL '9 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_active, v_ai_student_ids[8], 'DOOR_CAMERA_GATEWAY', 0.62, FALSE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_active) + INTERVAL '6 minutes', '{"arrival_type": "below_threshold", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW());

    -- Attendance events: IoT lab active.
    INSERT INTO attendance_events (id, session_id, student_id, source, face_confidence, is_recognized, occurred_at, metadata, created_by_user_id, created_at)
    VALUES
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[1], 'DOOR_CAMERA_GATEWAY', 0.95, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_active) + INTERVAL '3 minutes', '{"arrival_type": "present", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[2], 'DOOR_CAMERA_GATEWAY', 0.86, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_active) + INTERVAL '11 minutes', '{"arrival_type": "late", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[3], 'DOOR_CAMERA_GATEWAY', 0.92, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_active) + INTERVAL '5 minutes', '{"arrival_type": "present", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[4], 'DOOR_CAMERA_GATEWAY', 0.94, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_active) + INTERVAL '6 minutes', '{"arrival_type": "present", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[6], 'DOOR_CAMERA_GATEWAY', 0.93, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_active) + INTERVAL '4 minutes', '{"arrival_type": "present", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[7], 'DOOR_CAMERA_GATEWAY', 0.58, FALSE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_active) + INTERVAL '2 minutes', '{"arrival_type": "below_threshold", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_active, v_iot_student_ids[8], 'DOOR_CAMERA_GATEWAY', 0.84, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_active) + INTERVAL '9 minutes', '{"arrival_type": "late", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW());

    -- Attendance events: Testing active.
    INSERT INTO attendance_events (id, session_id, student_id, source, face_confidence, is_recognized, occurred_at, metadata, created_by_user_id, created_at)
    VALUES
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[1], 'DOOR_CAMERA_GATEWAY', 0.95, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_active) + INTERVAL '2 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[2], 'DOOR_CAMERA_GATEWAY', 0.93, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_active) + INTERVAL '4 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[3], 'DOOR_CAMERA_GATEWAY', 0.91, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_active) + INTERVAL '9 minutes', '{"arrival_type": "late", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[5], 'DOOR_CAMERA_GATEWAY', 0.94, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_active) + INTERVAL '3 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[6], 'DOOR_CAMERA_GATEWAY', 0.92, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_active) + INTERVAL '4 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[7], 'DOOR_CAMERA_GATEWAY', 0.63, FALSE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_active) + INTERVAL '2 minutes', '{"arrival_type": "below_threshold", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_active, v_test_student_ids[8], 'DOOR_CAMERA_GATEWAY', 0.89, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_active) + INTERVAL '5 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW());

    -- Attendance events: AI3307 completed.
    INSERT INTO attendance_events (id, session_id, student_id, source, face_confidence, is_recognized, occurred_at, metadata, created_by_user_id, created_at)
    VALUES
        (uuid_generate_v4(), v_session_ai_completed, v_ai_student_ids[1], 'DOOR_CAMERA_GATEWAY', 0.94, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_completed) + INTERVAL '15 minutes', '{"arrival_type": "late", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_completed, v_ai_student_ids[2], 'DOOR_CAMERA_GATEWAY', 0.93, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_completed) + INTERVAL '4 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_completed, v_ai_student_ids[3], 'DOOR_CAMERA_GATEWAY', 0.91, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_completed) + INTERVAL '6 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_completed, v_ai_student_ids[5], 'DOOR_CAMERA_GATEWAY', 0.90, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_completed) + INTERVAL '8 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_completed, v_ai_student_ids[6], 'DOOR_CAMERA_GATEWAY', 0.88, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_completed) + INTERVAL '11 minutes', '{"arrival_type": "late", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_ai_completed, v_ai_student_ids[7], 'DOOR_CAMERA_GATEWAY', 0.92, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_ai_completed) + INTERVAL '7 minutes', '{"arrival_type": "present", "camera_id": "door-cam-a1"}'::jsonb, NULL, NOW());

    -- Attendance events: IoT lab completed.
    INSERT INTO attendance_events (id, session_id, student_id, source, face_confidence, is_recognized, occurred_at, metadata, created_by_user_id, created_at)
    VALUES
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[1], 'DOOR_CAMERA_GATEWAY', 0.96, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_completed) + INTERVAL '3 minutes', '{"arrival_type": "present", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[2], 'DOOR_CAMERA_GATEWAY', 0.91, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_completed) + INTERVAL '5 minutes', '{"arrival_type": "present", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[3], 'DOOR_CAMERA_GATEWAY', 0.88, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_completed) + INTERVAL '13 minutes', '{"arrival_type": "late", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[4], 'DOOR_CAMERA_GATEWAY', 0.94, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_completed) + INTERVAL '4 minutes', '{"arrival_type": "present", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[5], 'DOOR_CAMERA_GATEWAY', 0.90, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_completed) + INTERVAL '6 minutes', '{"arrival_type": "present", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[6], 'DOOR_CAMERA_GATEWAY', 0.89, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_completed) + INTERVAL '7 minutes', '{"arrival_type": "present", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_iot_completed, v_iot_student_ids[8], 'DOOR_CAMERA_GATEWAY', 0.85, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_iot_completed) + INTERVAL '10 minutes', '{"arrival_type": "late", "camera_id": "door-cam-lab9"}'::jsonb, NULL, NOW());

    -- Attendance events: Testing completed.
    INSERT INTO attendance_events (id, session_id, student_id, source, face_confidence, is_recognized, occurred_at, metadata, created_by_user_id, created_at)
    VALUES
        (uuid_generate_v4(), v_session_test_completed, v_test_student_ids[2], 'DOOR_CAMERA_GATEWAY', 0.94, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_completed) + INTERVAL '2 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_completed, v_test_student_ids[3], 'DOOR_CAMERA_GATEWAY', 0.90, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_completed) + INTERVAL '7 minutes', '{"arrival_type": "late", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_completed, v_test_student_ids[4], 'DOOR_CAMERA_GATEWAY', 0.92, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_completed) + INTERVAL '4 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_completed, v_test_student_ids[5], 'DOOR_CAMERA_GATEWAY', 0.95, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_completed) + INTERVAL '3 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_completed, v_test_student_ids[7], 'DOOR_CAMERA_GATEWAY', 0.93, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_completed) + INTERVAL '2 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW()),
        (uuid_generate_v4(), v_session_test_completed, v_test_student_ids[8], 'DOOR_CAMERA_GATEWAY', 0.88, TRUE, (SELECT start_time FROM class_sessions WHERE id = v_session_test_completed) + INTERVAL '5 minutes', '{"arrival_type": "present", "camera_id": "door-cam-b1"}'::jsonb, NULL, NOW());

    DELETE FROM attendance_dashboard_exports
    WHERE requested_by = v_admin_user_id;

    INSERT INTO attendance_dashboard_exports (
        id,
        requested_by,
        export_format,
        filter_payload,
        row_count,
        generated_at,
        status
    ) VALUES (
        uuid_generate_v4(),
        v_admin_user_id,
        'CSV',
        jsonb_build_object(
            'scope', 'A',
            'subject_codes', ARRAY['AI3307', 'EE2305', 'SE3315'],
            'window_days', 7
        ),
        18,
        NOW() - INTERVAL '40 minutes',
        'SUCCESS'
    );

    -- Demo invariant: lecturer_demo must always own at least one active session in scope.
    IF NOT EXISTS (
        SELECT 1
        FROM class_sessions cs
        WHERE cs.status = 'ACTIVE'
          AND cs.teacher_id = v_lecturer_teacher_id
          AND cs.room_id IN (
              SELECT room_id
              FROM user_room_assignments
              WHERE user_id = v_instructor_user_id
          )
    ) THEN
        INSERT INTO class_sessions (
            id,
            room_id,
            teacher_id,
            subject_id,
            timetable_id,
            mode,
            start_time,
            students_present,
            status,
            created_at,
            updated_at
        )
        VALUES (
            uuid_generate_v4(),
            v_ai_room_id,
            v_lecturer_teacher_id,
            v_ai_subject_id,
            v_timetable_ai_theory,
            'NORMAL',
            NOW() - INTERVAL '5 minutes',
            to_jsonb(ARRAY[v_ai_student_ids[1], v_ai_student_ids[2], v_ai_student_ids[3]]),
            'ACTIVE',
            NOW(),
            NOW()
        );
    END IF;


    -- Injecting additional active sessions across multiple buildings
    INSERT INTO class_sessions (
        id, room_id, teacher_id, subject_id, mode, start_time, students_present, status, created_at, updated_at
    )
    SELECT
        uuid_generate_v4(),
        r.id,
        v_lecturer_teacher_id,
        v_ai_subject_id,
        'NORMAL',
        NOW() - (random() * interval '45 minutes'),
        '[]'::jsonb,
        'ACTIVE',
        NOW(),
        NOW()
    FROM rooms r
    WHERE r.room_code IN ('A1-102', 'A2-204', 'A2-301', 'B1-205', 'B2-101', 'C1-103', 'LAB1-101')
    ON CONFLICT DO NOTHING;

    -- ------------------------------------------------------------------------
    -- 7. Generate Historical Data (Past 30 Days)
    -- ------------------------------------------------------------------------
    SELECT ARRAY_AGG(id) INTO v_all_possible_subject_ids FROM subjects;
    SELECT ARRAY_AGG(id) INTO v_all_possible_teacher_ids FROM teachers;
    SELECT ARRAY_AGG(id) INTO v_all_possible_room_ids FROM rooms WHERE room_code LIKE 'A1-%' OR room_code LIKE 'B1-%' OR room_code LIKE 'LAB%';

    FOR v_day_offset IN 1..30 LOOP
        v_history_date := CURRENT_DATE - v_day_offset;
        
        -- Create 4-6 sessions per day
        FOR v_session_offset IN 1..((RANDOM() * 2 + 4)::INT) LOOP
            v_history_session_id := uuid_generate_v4();
            v_history_subject_id := v_all_possible_subject_ids[1 + floor(random() * array_length(v_all_possible_subject_ids, 1))];
            v_history_teacher_id := v_all_possible_teacher_ids[1 + floor(random() * array_length(v_all_possible_teacher_ids, 1))];
            v_history_room_id := v_all_possible_room_ids[1 + floor(random() * array_length(v_all_possible_room_ids, 1))];
            
            -- Insert session
            INSERT INTO class_sessions (
                id, room_id, teacher_id, subject_id, mode, start_time, end_time, status, created_at, updated_at
            ) VALUES (
                v_history_session_id, v_history_room_id, v_history_teacher_id, v_history_subject_id,
                CASE WHEN RANDOM() > 0.8 THEN 'TESTING' ELSE 'NORMAL' END,
                v_history_date + (INTERVAL '1 hour' * (8 + v_session_offset * 1.5)),
                v_history_date + (INTERVAL '1 hour' * (8 + v_session_offset * 1.5 + 1.5)),
                'COMPLETED',
                v_history_date, v_history_date
            );

            v_present_student_ids := '{}';
            v_late_student_ids := '{}';
            v_absent_student_ids := '{}';
            
            -- Deterministic student set for each subject to make charts cleaner
            FOR v_idx IN 1..array_length(v_all_student_ids, 1) LOOP
                v_random_student_id := v_all_student_ids[v_idx];
                
                -- Simulate attendance with some randomness but weighted towards presence
                IF RANDOM() < 0.75 THEN
                    v_present_student_ids := v_present_student_ids || v_random_student_id;
                    INSERT INTO attendance_events (id, session_id, student_id, source, face_confidence, is_recognized, occurred_at, created_at)
                    VALUES (uuid_generate_v4(), v_history_session_id, v_random_student_id, 'DOOR_CAMERA', 0.88 + RANDOM() * 0.11, TRUE, v_history_date + (INTERVAL '1 hour' * (8 + v_session_offset * 1.5)) + (INTERVAL '1 minute' * (RANDOM() * 5)::INT), v_history_date);
                ELSIF RANDOM() < 0.4 THEN
                    v_late_student_ids := v_late_student_ids || v_random_student_id;
                    INSERT INTO attendance_events (id, session_id, student_id, source, face_confidence, is_recognized, occurred_at, created_at)
                    VALUES (uuid_generate_v4(), v_history_session_id, v_random_student_id, 'DOOR_CAMERA', 0.85 + RANDOM() * 0.12, TRUE, v_history_date + (INTERVAL '1 hour' * (8 + v_session_offset * 1.5)) + (INTERVAL '1 minute' * (10 + RANDOM() * 20)::INT), v_history_date);
                ELSE
                    v_absent_student_ids := v_absent_student_ids || v_random_student_id;
                END IF;
            END LOOP;

            -- Update session with students_present
            UPDATE class_sessions SET students_present = to_jsonb(v_present_student_ids || v_late_student_ids) WHERE id = v_history_session_id;

            -- Performance and Risk for some students
            IF (SELECT mode FROM class_sessions WHERE id = v_history_session_id) = 'NORMAL' THEN
                INSERT INTO performance_aggregates (id, session_id, actor_id, actor_type, total_score, calculated_at)
                SELECT uuid_generate_v4(), v_history_session_id, s_id, 'STUDENT', 65 + RANDOM() * 30, v_history_date
                FROM UNNEST(v_present_student_ids || v_late_student_ids) s_id
                WHERE RANDOM() > 0.2;
            ELSE
                INSERT INTO risk_incidents (id, session_id, student_id, risk_score, risk_level, triggered_behaviors, flagged_at, reviewed, created_at)
                SELECT uuid_generate_v4(), v_history_session_id, s_id, RANDOM() * 0.9, 
                       CASE WHEN RANDOM() > 0.7 THEN 'HIGH' ELSE 'MEDIUM' END,
                       '{"head-turning": 2}'::jsonb, v_history_date + INTERVAL '30 minutes', TRUE, v_history_date
                FROM UNNEST(v_present_student_ids || v_late_student_ids) s_id
                WHERE RANDOM() > 0.85;
            END IF;
        END LOOP;
    END LOOP;

END $$;


