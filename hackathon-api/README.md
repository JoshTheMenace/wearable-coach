# Hackathon API exploration

Retrieved September 15, 2026. Requests made during this exploration were GET requests.

## Access and event

- Base URL: https://usmc.hackathon-portal.maximus.com
- Authentication: `X-API-Key: <your key>`. The schema also documents `Authorization: Api-Key <your key>`.
- The provided key successfully authenticates. It is not stored in these files.
- Event: **MCU-NPS AI Learning Initiatives**, ID **5**, slug **`mcu-nps-ai-learning-initiatives`**.
- Registration: confirmed; API identifies the caller as a participant and reports `can_manage: false`.
- Event description identifies the hackathon as September 15–18, 2026. The API's broader `start_date` is August 31, so do not treat that as the in-person kickoff date.
- Event timezone: `America/New_York`; API timestamps use UTC.
- The schema describes personal keys and read-only event-scoped keys. Successful reads and returned participant permissions do not establish this particular key's write scope; no writes were tested.

## Endpoint guide

| GET endpoint | Returns | Verification |
|---|---|---|
| `/api/registration/my-events/` | Your registrations | Verified |
| `/api/schema/` | OpenAPI 3 schema; API version 2.8.0 | Verified |
| `/api/schema/swagger/` | Swagger UI; requires authentication in this deployment | Verified |
| `/api/events/by-slug/mcu-nps-ai-learning-initiatives/` | Event details, rules, FAQ, permissions, judging window | Verified |
| `/api/events/mcu-nps-ai-learning-initiatives/use-cases/` | 19 use cases | Verified |
| `/api/use-cases/148/` | Individual use case; includes teams_using and creator | Verified |
| `/api/events/mcu-nps-ai-learning-initiatives/datasets/` | 30 visible datasets and resource records | Verified |
| `/api/events/datasets/358/` | Dataset detail; includes has_download and file metadata | Verified |
| `/api/events/datasets/{id}/download_file/` | Dataset file download | Documented; file download not tested |
| `/api/events/mcu-nps-ai-learning-initiatives/judging-criteria/` | 5 core criteria and 4 bonus criteria | Verified |
| `/api/events/mcu-nps-ai-learning-initiatives/schedule/` | 42 schedule entries, including MCU and NPS sessions | Verified |
| `/api/events/mcu-nps-ai-learning-initiatives/documents/` | No active document attachments returned | Verified |
| `/api/events/mcu-nps-ai-learning-initiatives/combined/` | Event, theme, sponsors, schedule, use cases, judging, datasets, prizes, stats, access | Documented; not tested |
| `/api/teams/my-team/?event_id=5` | Your team, membership, and submission eligibility | Documented; not tested |
| `/api/teams/{uuid}/use-cases/` | Use cases selected by a team | Documented; not tested |

## Request example

Set `HACKATHON_API_KEY` in your shell to the supplied value, then run:

```sh
curl --fail-with-body --silent --show-error \
  -H "X-API-Key: ${HACKATHON_API_KEY}" \
  "https://usmc.hackathon-portal.maximus.com/api/events/mcu-nps-ai-learning-initiatives/use-cases/"
```

The event use-case and dataset endpoints returned plain JSON arrays, without a pagination envelope. Use-case records include requirements, resources, deliverables, evaluation criteria, skills, and category; many optional fields are empty or null. Individual use-case detail adds team adoption information. Dataset listings contain metadata and source links; attached file bytes have a separate download endpoint.

## Judging

All criteria use a 0–10 score range. The five core weights sum to 100.

| Criterion | Weight | What judges assess |
|---|---:|---|
| Technical Innovation | 25% | Judges are looking for originality, feasibility, and technical depth. |
| Mission Impact | 30% | How well the solution aligns with defense priorities and real-world use cases. |
| Usability & Design | 20% | Clarity of the demo, ease of use, and potential for reuse or extension. |
| Security & Sustainability | 15% | Readiness for DoW testing, long-term viability, and maintainability. |
| Team Collaboration | 10% | Teamwork, presentation quality, and resilience under pressure. |

Bonus criteria: Reach the Enterprise, Sanctioned and Approved, Living on the Edge, Supercharge. Each has `bonus_multiplier: 0.05`; the final aggregation formula was not verified.

## Data caveats

- Event summary reports 32 datasets; the event dataset endpoint returns 30. Its documentation says the public view shows approved datasets and managers can see pending/needs-work datasets. Filtering may explain the difference, but this was not confirmed.
- Use case 244 requests NAVMC 3500.44E; dataset 352 is labeled NAVMC 3500.44D. Confirm the appropriate source revision before building that use case.
- Judging configuration starts September 17 at 19:00 UTC (3 p.m. EDT), while the schedule starts MCU semifinal presentations at 18:00 UTC (2 p.m. EDT). These may be different windows; consult the event schedule for presentation timing.
- The documents endpoint returned an empty list, but resources are present in the dataset catalog and use-case resource fields.

## Local reference files

- [Use-case catalog](use-cases.md): all 19 use cases, including full requirements and deliverables.
- [Dataset catalog](datasets.md): all 30 visible records, descriptions, and documented download routes.
- [OpenAPI schema](schema.json): complete machine-readable API documentation.
- Raw JSON snapshots: `event.json`, `use-cases.json`, `datasets.json`, `judging-criteria.json`, `schedule.json`, and `documents.json`.
- Sample detail responses: `use-case-148.json` and `dataset-358.json`.
