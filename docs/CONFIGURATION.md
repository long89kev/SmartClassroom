# Smart AI-IoT Classroom System - Configuration Files

## Performance Weights (Learning Mode)

Default global performance weights for behavior grading:

```json
{
  "student_behaviors": {
    "hand-raising": 10.0,
    "reading": 8.0,
    "writing": 9.0,
    "bow-head": -3.0,
    "talking": 5.0,
    "standing": 3.0,
    "answering": 15.0,
    "on-stage-interaction": 12.0,
    "discussing": 12.0,
    "yawning": -5.0,
    "clapping": 4.0,
    "leaning-on-desk": -2.0,
    "using-phone": -20.0,
    "using-computer": -15.0
  },
  "teacher_behaviors": {
    "guiding": 10.0,
    "blackboard-writing": 12.0,
    "on-stage-interaction": 8.0,
    "blackboard": 6.0
  }
}
```

## Risk Weights (Testing Mode - Cheat Detection)

Default parameters for risk scoring equation:

```json
{
  "alpha_head_turn": 0.3,
  "beta_talk": 0.5,
  "gamma_device_use": 0.8,
  "alert_threshold": 50.0,
  "risk_levels": {
    "CRITICAL": {"min": 75, "max": 100},
    "HIGH": {"min": 50, "max": 74},
    "MEDIUM": {"min": 25, "max": 49},
    "LOW": {"min": 0, "max": 24}
  }
}
```

### Risk Equation
```
Risk = α * (head_turn_count) + β * (talk_count) + γ * (device_duration_seconds)

If Risk > τ (threshold: 50.0), trigger alert
```

## IoT Auto-Rules Examples

### Rule 1: Occupancy-Based (Turn ON when students present)
```json
{
  "rule_name": "Lights ON when occupied",
  "condition_type": "OCCUPANCY",
  "condition_params": {
    "min_occupancy": 1,
    "duration_minutes": 2
  },
  "actions": [
    {"device_type": "LIGHT", "action": "ON"},
    {"device_type": "PROJECTOR", "action": "ON"}
  ]
}
```

### Rule 2: Timetable-Based (Turn ON before scheduled class)
```json
{
  "rule_name": "Lights ON before class",
  "condition_type": "TIMETABLE",
  "condition_params": {
    "minutes_before": 5
  },
  "actions": [
    {"device_type": "LIGHT", "action": "ON"},
    {"device_type": "AC", "action": "ON"},
    {"device_type": "PROJECTOR", "action": "ON"}
  ]
}
```

### Rule 3: Zero Occupancy (Turn OFF all devices)
```json
{
  "rule_name": "Lights OFF when empty",
  "condition_type": "ZERO_OCCUPANCY",
  "condition_params": {
    "idle_minutes": 30
  },
  "actions": [
    {"device_type": "LIGHT", "action": "OFF"},
    {"device_type": "AC", "action": "OFF"},
    {"device_type": "PROJECTOR", "action": "OFF"},
    {"device_type": "FAN", "action": "OFF"}
  ]
}
```

## Device Inventory (Room JSONB Schema)

Example room device configuration stored in `rooms.devices` JSONB column:

```json
{
  "device_list": [
    {
      "device_id": "light_001",
      "device_type": "LIGHT",
      "location": "ceiling_front",
      "status": "ON",
      "mqtt_topic": "building/B1/floor/1/room/B1-103/device/light_001/state",
      "power_consumption_watts": 50
    },
    {
      "device_id": "ac_001",
      "device_type": "AC",
      "location": "corner_right",
      "status": "OFF",
      "mqtt_topic": "building/B1/floor/1/room/B1-103/device/ac_001/state",
      "power_consumption_watts": 800
    },
    {
      "device_id": "fan_001",
      "device_type": "FAN",
      "location": "corner_left",
      "status": "OFF",
      "mqtt_topic": "building/B1/floor/1/room/B1-103/device/fan_001/state",
      "power_consumption_watts": 100
    },
    {
      "device_id": "projector_001",
      "device_type": "PROJECTOR",
      "location": "ceiling_rear",
      "status": "OFF",
      "mqtt_topic": "building/B1/floor/1/room/B1-103/device/projector_001/state",
      "power_consumption_watts": 300
    }
  ]
}
```
