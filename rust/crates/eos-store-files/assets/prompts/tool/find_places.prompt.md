---
description: "MCP tool — find_places"
variables:
  - CURRENT_LOCATION_TOOL
  - PRESENT_TOOL
---

Find real places near a point, from OpenStreetMap: name, coordinates, address, opening hours, cuisine and website where the map knows them, nearest first. Give a `query` ("ramen", "bike repair") or a `category` ("restaurant", "cafe", "pharmacy"), and `near` — a place name or address (`{text}`) or `{lat, lon}`. Leave `near` out to search around the user — only when they asked for something near them; it needs location sharing, like {{CURRENT_LOCATION_TOOL}}. `radiusM` (meters, default 1500) widens or narrows the search; `limit` caps the count (default 12).

Returns a line saying what was found, then JSON with Place entities ready for {{PRESENT_TOOL}}'s `data`, the attribution and a ready `source` entry. Keep each place's `id`, `geo`, `hours` and `site` as returned, and put that `source` in `data.sources`. OpenStreetMap has no ratings, prices or reviews: take those from a source you read, cited with `source`, or leave them out.
