-- Mock runtime data generator for Smart Classroom
-- Run with:
--   psql -U doai_user -d doai_classroom -f backend/migrations/data.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$
DECLARE
    v_teacher_id UUID;
    v_subject_id UUID;
    v_session_id UUID;
    v_room RECORD;
    v_idx INT := 0;
    v_student_ids UUID[];
    v_score NUMERIC;
BEGIN
    -- Teacher + subject
    INSERT INTO teachers (id, name, email, phone, department)
    VALUES (uuid_generate_v4(), 'Mock Teacher', 'mock.teacher@campus.local', '000-111-222', 'Engineering')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, department = EXCLUDED.department;

    SELECT id INTO v_teacher_id FROM teachers WHERE email = 'mock.teacher@campus.local' LIMIT 1;

    INSERT INTO subjects (id, name, code, description)
    VALUES (uuid_generate_v4(), 'Mock Smart Classroom', 'MOCK101', 'Seeded runtime demo subject')
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

    SELECT id INTO v_subject_id FROM subjects WHERE code = 'MOCK101' LIMIT 1;

    -- Students
    FOR v_idx IN 1..12 LOOP
        INSERT INTO students (id, name, student_id, email, class)
        VALUES (
            uuid_generate_v4(),
            'Mock Student ' || v_idx,
            'MOCK-STU-' || LPAD(v_idx::TEXT, 3, '0'),
            'mock.student' || v_idx || '@campus.local',
            'SE-2026'
        )
        ON CONFLICT (student_id) DO NOTHING;
    END LOOP;

    -- Ensure all mock students are enrolled in mock subject for attendance reports.
    INSERT INTO enrollments (id, student_id, subject_id, enrollment_date)
    SELECT uuid_generate_v4(), s.id, v_subject_id, NOW()
    FROM students s
    WHERE s.student_id LIKE 'MOCK-STU-%'
    ON CONFLICT (student_id, subject_id) DO NOTHING;

    SELECT ARRAY_AGG(id ORDER BY student_id) INTO v_student_ids
    FROM students
    WHERE student_id LIKE 'MOCK-STU-%';

    -- Devices: write source-of-truth into room_devices, then sync rooms.devices and device_states.
    FOR v_room IN SELECT id, room_code FROM rooms ORDER BY room_code LIMIT 80 LOOP
        DELETE FROM room_devices WHERE room_id = v_room.id;

        INSERT INTO room_devices (
            id,
            room_id,
            device_id,
            device_type,
            location_front_back,
            location_left_right,
            power_consumption_watts,
            is_active,
            source,
            created_at,
            updated_at
        ) VALUES
            (
                uuid_generate_v4(),
                v_room.id,
                REPLACE(v_room.room_code, ' ', '') || '-LI-01',
                'LIGHT',
                'FRONT',
                'LEFT',
                20,
                TRUE,
                'IMPORT',
                NOW(),
                NOW()
            ),
            (
                uuid_generate_v4(),
                v_room.id,
                REPLACE(v_room.room_code, ' ', '') || '-AC-02',
                'AC',
                'BACK',
                'RIGHT',
                40,
                TRUE,
                'IMPORT',
                NOW(),
                NOW()
            ),
            (
                uuid_generate_v4(),
                v_room.id,
                REPLACE(v_room.room_code, ' ', '') || '-FA-03',
                'FAN',
                'FRONT',
                'RIGHT',
                60,
                TRUE,
                'IMPORT',
                NOW(),
                NOW()
            ),
            (
                uuid_generate_v4(),
                v_room.id,
                REPLACE(v_room.room_code, ' ', '') || '-CA-05',
                'CAMERA',
                'FRONT',
                'LEFT',
                15,
                TRUE,
                'IMPORT',
                NOW(),
                NOW()
            );

        UPDATE rooms
        SET devices = jsonb_build_object(
            'device_list',
            COALESCE(
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'device_id', rd.device_id,
                            'device_type', rd.device_type,
                            'location_front_back', rd.location_front_back,
                            'location_left_right', rd.location_left_right,
                            'location', rd.location_front_back || '_' || rd.location_left_right,
                            'status', CASE
                                WHEN rd.device_type IN ('LIGHT', 'FAN', 'CAMERA') THEN 'ON'
                                ELSE 'OFF'
                            END,
                            'mqtt_topic', 'building/*/floor/*/room/' || v_room.room_code || '/device/' || rd.device_id || '/state',
                            'power_consumption_watts', rd.power_consumption_watts
                        )
                        ORDER BY rd.device_id
                    )
                    FROM room_devices rd
                    WHERE rd.room_id = v_room.id AND rd.is_active = TRUE
                ),
                '[]'::jsonb
            )
        )
        WHERE id = v_room.id;

        DELETE FROM device_states WHERE room_id = v_room.id;

        INSERT INTO device_states (id, room_id, device_id, device_type, status, manual_override, last_updated, updated_at)
        SELECT
            uuid_generate_v4(),
            rd.room_id,
            rd.device_id,
            rd.device_type,
            CASE
                WHEN rd.device_type IN ('LIGHT', 'FAN', 'CAMERA') THEN 'ON'
                ELSE 'OFF'
            END,
            FALSE,
            NOW(),
            NOW()
        FROM room_devices rd
        WHERE rd.room_id = v_room.id AND rd.is_active = TRUE;
    END LOOP;

    -- Recreate active mock sessions for consistent dashboards
    DELETE FROM risk_incidents
    WHERE session_id IN (
        SELECT id FROM class_sessions
        WHERE teacher_id = v_teacher_id AND subject_id = v_subject_id AND status = 'ACTIVE'
    );

    DELETE FROM behavior_logs
    WHERE session_id IN (
        SELECT id FROM class_sessions
        WHERE teacher_id = v_teacher_id AND subject_id = v_subject_id AND status = 'ACTIVE'
    );

    DELETE FROM class_sessions
    WHERE teacher_id = v_teacher_id AND subject_id = v_subject_id AND status = 'ACTIVE';

    v_idx := 0;
    FOR v_room IN SELECT id, room_code FROM rooms ORDER BY room_code LIMIT 16 LOOP
        v_idx := v_idx + 1;

        INSERT INTO class_sessions (
            id, room_id, teacher_id, subject_id, mode, start_time,
            students_present, status, created_at, updated_at
        )
        VALUES (
            uuid_generate_v4(),
            v_room.id,
            v_teacher_id,
            v_subject_id,
            CASE WHEN MOD(v_idx, 2) = 1 THEN 'TESTING' ELSE 'NORMAL' END,
            NOW() - ((5 + v_idx) || ' minutes')::INTERVAL,
            to_json(v_student_ids[1:8]),
            'ACTIVE',
            NOW(),
            NOW()
        )
        RETURNING id INTO v_session_id;

        INSERT INTO behavior_logs (
            id, session_id, actor_id, actor_type, behavior_class, count, duration_seconds, detected_at, yolo_confidence, created_at
        ) VALUES
            (uuid_generate_v4(), v_session_id, v_student_ids[1], 'STUDENT', 'writing', 3, 15, NOW() - INTERVAL '4 minutes', 0.90, NOW()),
            (uuid_generate_v4(), v_session_id, v_student_ids[2], 'STUDENT', 'listening', 4, 20, NOW() - INTERVAL '3 minutes', 0.88, NOW()),
            (uuid_generate_v4(), v_session_id, v_student_ids[3], 'STUDENT', 'raising_hand', 2, 10, NOW() - INTERVAL '2 minutes', 0.92, NOW()),
            (uuid_generate_v4(), v_session_id, v_student_ids[4], 'STUDENT', 'reading', 5, 25, NOW() - INTERVAL '1 minutes', 0.87, NOW());

        IF MOD(v_idx, 2) = 1 THEN
            v_score := 0.84;
            INSERT INTO risk_incidents (
                id, session_id, student_id, risk_score, risk_level, triggered_behaviors,
                flagged_at, reviewed, created_at
            )
            VALUES (
                uuid_generate_v4(),
                v_session_id,
                v_student_ids[1],
                v_score,
                'CRITICAL',
                '{"head_turn": 2, "talking": 1}'::json,
                NOW() - INTERVAL '2 minutes',
                FALSE,
                NOW()
            );

            INSERT INTO risk_incidents (
                id, session_id, student_id, risk_score, risk_level, triggered_behaviors,
                flagged_at, reviewed, created_at
            )
            VALUES (
                uuid_generate_v4(),
                v_session_id,
                v_student_ids[2],
                0.71,
                'HIGH',
                '{"phone_use": 1}'::json,
                NOW() - INTERVAL '1 minutes',
                FALSE,
                NOW()
            );
        END IF;
    END LOOP;

    -- Create or refresh per-session attendance config for all active mock sessions.
    INSERT INTO attendance_session_configs (id, session_id, grace_minutes, min_confidence, auto_checkin_enabled, created_at, updated_at)
    SELECT
        gen_random_uuid(),
        cs.id,
        10,
        0.75,
        TRUE,
        NOW(),
        NOW()
    FROM class_sessions cs
    WHERE cs.teacher_id = v_teacher_id
      AND cs.subject_id = v_subject_id
      AND cs.status = 'ACTIVE'
    ON CONFLICT (session_id) DO UPDATE SET
      grace_minutes = EXCLUDED.grace_minutes,
      min_confidence = EXCLUDED.min_confidence,
      auto_checkin_enabled = EXCLUDED.auto_checkin_enabled,
      updated_at = NOW();

    -- Re-seed attendance templates for mock students to keep test data deterministic.
    DELETE FROM attendance_face_templates
    WHERE student_id IN (
        SELECT id FROM students WHERE student_id LIKE 'MOCK-STU-%'
    );

    INSERT INTO attendance_face_templates (id, student_id, embedding, quality_score, is_active, created_at, updated_at)
    SELECT
        gen_random_uuid(),
        s.id,
        jsonb_build_array(
            ROUND((random())::numeric, 6),
            ROUND((random())::numeric, 6),
            ROUND((random())::numeric, 6),
            ROUND((random())::numeric, 6),
            ROUND((random())::numeric, 6),
            ROUND((random())::numeric, 6),
            ROUND((random())::numeric, 6),
            ROUND((random())::numeric, 6)
        ),
        ROUND((0.85 + random() * 0.14)::numeric, 4),
        TRUE,
        NOW(),
        NOW()
    FROM students s
    WHERE s.student_id LIKE 'MOCK-STU-%';

    -- Re-seed attendance events so reports include PRESENT, LATE, and ABSENT outcomes.
    DELETE FROM attendance_events
    WHERE session_id IN (
        SELECT id FROM class_sessions
        WHERE teacher_id = v_teacher_id
          AND subject_id = v_subject_id
          AND status = 'ACTIVE'
    );

    INSERT INTO attendance_events (
        id,
        session_id,
        student_id,
        source,
        face_confidence,
        is_recognized,
        occurred_at,
        metadata,
        created_by_user_id,
        created_at
    )
    SELECT
        gen_random_uuid(),
        cs.id,
        v_student_ids[1],
        'MOCK_DOOR_CAMERA',
        0.93,
        TRUE,
        cs.start_time + INTERVAL '2 minutes',
        jsonb_build_object('seed', TRUE, 'arrival_type', 'early'),
        NULL,
        NOW()
    FROM class_sessions cs
    WHERE cs.teacher_id = v_teacher_id
      AND cs.subject_id = v_subject_id
      AND cs.status = 'ACTIVE';

    INSERT INTO attendance_events (
        id,
        session_id,
        student_id,
        source,
        face_confidence,
        is_recognized,
        occurred_at,
        metadata,
        created_by_user_id,
        created_at
    )
    SELECT
        gen_random_uuid(),
        cs.id,
        v_student_ids[2],
        'MOCK_DOOR_CAMERA',
        0.89,
        TRUE,
        cs.start_time + INTERVAL '15 minutes',
        jsonb_build_object('seed', TRUE, 'arrival_type', 'late'),
        NULL,
        NOW()
    FROM class_sessions cs
    WHERE cs.teacher_id = v_teacher_id
      AND cs.subject_id = v_subject_id
      AND cs.status = 'ACTIVE';

    INSERT INTO attendance_events (
        id,
        session_id,
        student_id,
        source,
        face_confidence,
        is_recognized,
        occurred_at,
        metadata,
        created_by_user_id,
        created_at
    )
    SELECT
        gen_random_uuid(),
        cs.id,
        v_student_ids[3],
        'MOCK_DOOR_CAMERA',
        0.40,
        FALSE,
        cs.start_time + INTERVAL '3 minutes',
        jsonb_build_object('seed', TRUE, 'arrival_type', 'below_threshold'),
        NULL,
        NOW()
    FROM class_sessions cs
    WHERE cs.teacher_id = v_teacher_id
      AND cs.subject_id = v_subject_id
      AND cs.status = 'ACTIVE';
END $$;

-- ============================================================================
-- PHASE 3: SEED USERS, ROLES, AND SCOPE ASSIGNMENTS
-- ============================================================================

-- Create seed users with different roles
INSERT INTO users (id, username, email, password_hash, role, is_active) VALUES
('550e8400-e29b-41d4-a716-446655440001'::UUID, 'lecturer_demo', 'lecturer@campus.local', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NQn7d3M0WPf2', 'LECTURER', TRUE),
('550e8400-e29b-41d4-a716-446655440002'::UUID, 'proctor_demo', 'proctor@campus.local', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NQn7d3M0WPf2', 'EXAM_PROCTOR', TRUE),
('550e8400-e29b-41d4-a716-446655440003'::UUID, 'board_demo', 'board@campus.local', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NQn7d3M0WPf2', 'ACADEMIC_BOARD', TRUE),
('550e8400-e29b-41d4-a716-446655440004'::UUID, 'admin_demo', 'admin@campus.local', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NQn7d3M0WPf2', 'SYSTEM_ADMIN', TRUE),
('550e8400-e29b-41d4-a716-446655440005'::UUID, 'facility_demo', 'facility@campus.local', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NQn7d3M0WPf2', 'FACILITY_STAFF', TRUE),
('550e8400-e29b-41d4-a716-446655440006'::UUID, 'cleaning_demo', 'cleaning@campus.local', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NQn7d3M0WPf2', 'CLEANING_STAFF', TRUE),
('550e8400-e29b-41d4-a716-446655440007'::UUID, 'student_demo', 'student@campus.local', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NQn7d3M0WPf2', 'STUDENT', TRUE)
ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role;

-- Link student demo user to first seeded mock student profile
UPDATE students
SET user_id = '550e8400-e29b-41d4-a716-446655440007'::UUID
WHERE student_id = 'MOCK-STU-001';

-- Assign LECTURER to first 5 classrooms
INSERT INTO user_room_assignments (user_id, room_id, can_view, can_control)
SELECT '550e8400-e29b-41d4-a716-446655440001'::UUID, r.id, TRUE, TRUE
FROM rooms r ORDER BY r.room_code LIMIT 5
ON CONFLICT (user_id, room_id) DO NOTHING;

-- Assign EXAM_PROCTOR to first 3 classrooms
INSERT INTO user_room_assignments (user_id, room_id, can_view, can_control)
SELECT '550e8400-e29b-41d4-a716-446655440002'::UUID, r.id, TRUE, TRUE
FROM rooms r ORDER BY r.room_code LIMIT 3
ON CONFLICT (user_id, room_id) DO NOTHING;

-- Assign ACADEMIC_BOARD to first floor
INSERT INTO user_block_assignments (user_id, floor_id, can_view, can_control)
SELECT '550e8400-e29b-41d4-a716-446655440003'::UUID, f.id, TRUE, FALSE
FROM floors f ORDER BY f.floor_number LIMIT 1
ON CONFLICT (user_id, floor_id) DO NOTHING;

-- Assign FACILITY_STAFF to first floor
INSERT INTO user_block_assignments (user_id, floor_id, can_view, can_control)
SELECT '550e8400-e29b-41d4-a716-446655440005'::UUID, f.id, TRUE, TRUE
FROM floors f ORDER BY f.floor_number LIMIT 1
ON CONFLICT (user_id, floor_id) DO NOTHING;
