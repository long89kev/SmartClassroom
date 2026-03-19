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

    SELECT ARRAY_AGG(id ORDER BY student_id) INTO v_student_ids
    FROM students
    WHERE student_id LIKE 'MOCK-STU-%';

    -- Devices: FRONT/BACK axis + LEFT/RIGHT axis persisted in DB JSON.
    FOR v_room IN SELECT id, room_code FROM rooms ORDER BY room_code LIMIT 80 LOOP
        UPDATE rooms
        SET devices = jsonb_build_object(
            'device_list',
            jsonb_build_array(
                jsonb_build_object(
                    'device_id', REPLACE(v_room.room_code, ' ', '') || '-LI-01',
                    'device_type', 'LIGHT',
                    'location_front_back', 'FRONT',
                    'location_left_right', 'LEFT',
                    'location', 'FRONT_LEFT',
                    'status', 'ON',
                    'mqtt_topic', 'building/*/floor/*/room/' || v_room.room_code || '/device/' || REPLACE(v_room.room_code, ' ', '') || '-LI-01/state',
                    'power_consumption_watts', 20
                ),
                jsonb_build_object(
                    'device_id', REPLACE(v_room.room_code, ' ', '') || '-AC-02',
                    'device_type', 'AC',
                    'location_front_back', 'BACK',
                    'location_left_right', 'RIGHT',
                    'location', 'BACK_RIGHT',
                    'status', 'OFF',
                    'mqtt_topic', 'building/*/floor/*/room/' || v_room.room_code || '/device/' || REPLACE(v_room.room_code, ' ', '') || '-AC-02/state',
                    'power_consumption_watts', 40
                ),
                jsonb_build_object(
                    'device_id', REPLACE(v_room.room_code, ' ', '') || '-FA-03',
                    'device_type', 'FAN',
                    'location_front_back', 'FRONT',
                    'location_left_right', 'RIGHT',
                    'location', 'FRONT_RIGHT',
                    'status', 'ON',
                    'mqtt_topic', 'building/*/floor/*/room/' || v_room.room_code || '/device/' || REPLACE(v_room.room_code, ' ', '') || '-FA-03/state',
                    'power_consumption_watts', 60
                ),
                jsonb_build_object(
                    'device_id', REPLACE(v_room.room_code, ' ', '') || '-PR-04',
                    'device_type', 'PROJECTOR',
                    'location_front_back', 'BACK',
                    'location_left_right', 'LEFT',
                    'location', 'BACK_LEFT',
                    'status', 'OFF',
                    'mqtt_topic', 'building/*/floor/*/room/' || v_room.room_code || '/device/' || REPLACE(v_room.room_code, ' ', '') || '-PR-04/state',
                    'power_consumption_watts', 80
                ),
                jsonb_build_object(
                    'device_id', REPLACE(v_room.room_code, ' ', '') || '-CA-05',
                    'device_type', 'CAMERA',
                    'location_front_back', 'FRONT',
                    'location_left_right', 'LEFT',
                    'location', 'FRONT_LEFT',
                    'status', 'ON',
                    'mqtt_topic', 'building/*/floor/*/room/' || v_room.room_code || '/device/' || REPLACE(v_room.room_code, ' ', '') || '-CA-05/state',
                    'power_consumption_watts', 15
                )
            )
        )
        WHERE id = v_room.id;

        DELETE FROM device_states WHERE room_id = v_room.id;

        INSERT INTO device_states (id, room_id, device_id, device_type, status, manual_override, last_updated, updated_at)
        VALUES
            (uuid_generate_v4(), v_room.id, REPLACE(v_room.room_code, ' ', '') || '-LI-01', 'LIGHT', 'ON', FALSE, NOW(), NOW()),
            (uuid_generate_v4(), v_room.id, REPLACE(v_room.room_code, ' ', '') || '-AC-02', 'AC', 'OFF', FALSE, NOW(), NOW()),
            (uuid_generate_v4(), v_room.id, REPLACE(v_room.room_code, ' ', '') || '-FA-03', 'FAN', 'ON', FALSE, NOW(), NOW()),
            (uuid_generate_v4(), v_room.id, REPLACE(v_room.room_code, ' ', '') || '-PR-04', 'PROJECTOR', 'OFF', FALSE, NOW(), NOW()),
            (uuid_generate_v4(), v_room.id, REPLACE(v_room.room_code, ' ', '') || '-CA-05', 'CAMERA', 'ON', FALSE, NOW(), NOW());
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
END $$;
