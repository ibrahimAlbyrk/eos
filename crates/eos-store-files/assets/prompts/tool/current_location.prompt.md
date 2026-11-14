---
description: "MCP tool — current_location"
variables:
  - FIND_PLACES_TOOL
---

Where the user is right now, from their Mac: latitude, longitude, accuracy in meters and the area (district, city, country). Call it only when the user asks for something near them ("near me", "around here") and names no place — then pass the point to {{FIND_PLACES_TOOL}}. It works only while the user shares their location (Settings › General › Visual answers); when it's off the result says so — ask where they are instead of guessing. Don't echo the coordinates back in text.
