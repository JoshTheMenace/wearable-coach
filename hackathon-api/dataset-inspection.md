# Dataset inspection for the wearable AI tutor

Inspected September 15, 2026. Screened all 30 catalog descriptions and downloaded ten additional dataset files: 351, 352, 354, 355, 357, 358, 363, 368, 373, and 377. PDF review was targeted to relevant sections, not a full validation of every page. Existing MCDP 7 (365) was reviewed previously. No portal selections or other writes were made.

## Recommended decision

For a first hardware demonstration, use **352** for a bounded map-reading/navigation preparation exercise, **354** for optional competency mapping, and **368** for evaluator development. Use **365** and **377** as instructional-design references. The tabletop activity is a part-task exercise, not completion of the full field navigation event.

With a qualified medical training SME, **351** is the strongest source for a richer adaptive scenario: a simulated prolonged-care resource inventory, changing requirements, reassessment, and handoff. Use a small approved segment of the course; the uploaded package does not establish clinical currency or validation.

## What the files actually contain

### 352 — Infantry Training and Readiness Manual

- 768-page PDF, NAVMC 3500.44D, dated May 7, 2020.
- Event `0300-PAT-1002`, printed page 8-16 / PDF page 285: Navigate with a Map and Compass. Contains conditions, standard, performance steps, references, and training-area requirements.
- A tabletop exercise can practice map orientation, explaining a marked route, and checking work while using voice and the camera. The actual event includes field travel and cannot be certified by a tabletop demo.
- Primary instructional reference for this event is TC 3-25.26, Map Reading and Land Navigation; the event record is not a full illustrated lesson.
- Earlier public revision supplied by the portal. Task criteria and prototype boundaries should be reviewed by an SME.

### 351 — Prolonged Casualty Care

- Moodle backup readable as a tar archive; no Moodle installation was needed to inspect the book XML.
- Three books: Blue Diamond PCC (67 chapters), Signature Management—Medical Considerations (8), and Tracking Fundamentals (4). The catalog's short description omits much of this structure.
- Main book includes practical stations, a quiz blueprint, an integrated 0–96-hour capstone, and a branching-case build specification.
- Chapter 206335, Logistics / Life Support — Practical Application & Reassessment: inventory resources, forecast depletion, respond to a changed situation, and revise the plan. Promising physical-prop exercise with a qualified instructor.
- Chapter 206342: longitudinal case design where the same simulated casualty changes over time; material supports an observe–reason–respond–reassess loop.
- Several practical sections are generic instructions to use a classroom model, rather than complete station scripts.
- Only two non-directory embedded file records in files.xml (pcc.png and Presentation1.jpg). Do not assume all suggested videos, clinical diagrams, or model assets are included.
- Requires qualified medical review and authored simulation state/rubrics; no clinical recommendations were validated in this review.

### 358 — 8670 EWS Prerequisite Coursebook

- 220-page PDF with 13 lessons and explicit educational objectives.
- Lesson 9, Operational Terms and Graphics, begins PDF page 158; reading begins page 159. Teaches symbol purpose/composition and related terminology. A bounded symbol-identification and explanation exercise could use printed cards and a physical map. This is a proposed exercise, not a supplied quiz.
- Lesson 10, Cognitive Bias, begins PDF page 179. Provides objectives and reading on cognitive systems, common biases, and causes; useful for an explain-your-reasoning scenario.
- The book states quizzes and assignments run in Moodle. Their existence in Moodle does not mean the actual question bank is in this PDF.
- Best match for official use case 245; also usable for 147. Glasses add more for physical map/card interaction than for verbal recall alone.

### 354 — USMC Competency Frameworks

- Four Moodle-import CSVs: Desired Leader Attributes (6 entries), CSCDEP outcomes (26), Joint Learning Areas (6), and five Marine competencies (5), excluding framework header rows.
- The five Marine competencies are Adaptability, Attentional Control, Metacognition, Problem solving, and Sensemaking.
- Framework scale includes Not yet competent / Competent. These are competency definitions, not validated camera scoring rubrics or percent-score formulas.
- More broadly relevant than the catalog's officer-PME wording initially suggested. Map specific observed evidence to selected outcomes; do not infer a general trait from a single exercise.

### 368 — Synthetic Wargame Summary Data

- Seven fictional evidence artifacts: six with structured simulation records and one narrative-only tabletop example.
- Records distinguish roles, timestamps, source locators, visibility, coverage gaps, observations, and interpretation.
- Evaluator keys for the six structured cases specify expected observations and prohibited claims. Examples distinguish poor process with a good outcome, reasonable process with a bad outcome, and missing capture from poor performance.
- Strong evaluator development material, even if the learner-facing exercise is unrelated to wargaming.
- Synthetic test fixtures, not validated human performance labels. Evaluator keys should remain outside learner-facing evidence and blind evaluation inputs.
- All nine manifest-listed file hashes verified.

### 373 — UFMCS Red Team Handbook v9

- 238-page PDF. Key Assumptions Check, printed pages 163–165 / PDF pages 177–179, provides a concrete method for exposing and challenging assumptions.
- Useful coaching structure for a noncombat planning exercise, such as a proposed supply handover with a changed constraint. The scenario itself must be authored.
- Strong reasoning content; relatively weak reason to wear glasses unless the learner interacts with a physical planning board.

### 377 — Simulation Training Guide

- 56-page PDF. Appendix C, especially C-2 through C-5 / PDF pages 46–49, gives practical planning, briefing, observation, debriefing, and documentation questions.
- Directly useful for designing baseline assessment, planned challenges, performance checklists, retries, AARs, and remediation.
- A guide to running the exercise, not a source of equipment procedures or a ready-to-run scenario.

### 357 — Planning Doctrine

- JSON contains two manuals: MCDP 5 (3 chapter records) and MCWP 5-10 (17 chapter records).
- Includes manual metadata, chapter overviews, section headings, paragraph identifiers, and paragraph text.
- Convenient retrieval structure for use case 151. Generated extraction and paragraph labels should be checked against original publications before presenting exact-source claims.
- Planning content rather than a hands-on equipment task or ready-to-run training simulation.

### 355 — Synthetic Student Discussions

- ZIP contains JSON and PDF. JSON metadata describes 62 posts across two discussions, ten students and one instructor; participant tiers are included.
- Useful for transcript-analysis development and dashboard demonstrations, with synthetic labels treated as fixture expectations rather than validated educational judgments.
- Less aligned than 368 with timestamped actions, incomplete observation, and evidence-based AARs.

### 363 — MCDP 4 Logistics

- 142-page PDF. The foreword explicitly explains that it provides broad ideas and examples rather than specific techniques or procedures.
- Useful background for logistics reasoning. Dataset 351 provides a more concrete resource-planning practical for an actual prototype.

## Remaining decisions

Choose the learner role and one task with an available instructor. Confirm the physical props and what the camera can actually resolve. Select explicit task criteria, author a short scenario and one variation, and separate source-backed rules from scenario-specific assumptions.
