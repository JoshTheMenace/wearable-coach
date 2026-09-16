# Use-case catalog

Source: https://usmc.hackathon-portal.maximus.com/api/events/mcu-nps-ai-learning-initiatives/use-cases/
Retrieved September 15, 2026.

| ID | Use case | Category |
|---|---|---|
| 244 | AI-Assisted Rubric Generator: Converting T&R Manual Standards into Measurable Performance Metrics | Performance Assessment |
| 194 | Browser Based Agent Governance | Operational Support |
| 240 | Browser-Native Threat Assessment and Defensive Wargaming | Wargaming |
| 246 | Command and Control: Decision Advantage | Operational Support |
| 204 | CUI Auto-Tagging and Classification Assistant | Operational Support |
| 248 | Curriculum Design and Management System | Operational Support |
| 180 | Learning Intelligence Dashboard (LID) | Performance Assessment |
| 220 | Low Resource Language Enablement for Enterprise AI | Personalized Learning |
| 195 | Multi-model Just-in-time Context and Role Aware AI Support Agents for web-based Ecosystems | Operational Support |
| 245 | PME Course Material Mastery Evaluation Agent | Performance Assessment |
| 247 | Project Course Cadence | Content Generation |
| 157 | Student Pilot Performance Analytics | Performance Assessment |
| 146 | Wargaming Learning Analysis Dashboard | Wargaming |
| 147 | AI Tutor | Personalized Learning |
| 148 | AI Instructional Design Assistant | Content Generation |
| 149 | AI Chat Activity Evaluator | Performance Assessment |
| 150 | AI Learning Support Assistant | Operational Support |
| 151 | Marine Corps Planning Process Instructional Content Modernization | Content Generation |
| 133 | Red Cell Doctrinal SME Agent | Wargaming |

## 244: AI-Assisted Rubric Generator: Converting T&R Manual Standards into Measurable Performance Metrics

Category: Performance Assessment

### Description

Infantry small units evaluate collective training performance against Training & Readiness (T&R) Manual (NAVMC 3500.44E) standards through a subjective, narrative process. The T&R Manual defines *what* a unit must do to be proficient, but not *how to measure* that proficiency in quantifiable, behaviorally anchored terms — and building those measurable rubrics today is slow and SME-intensive, task by task, by hand. This directly undercuts TECOM Campaign Plan 2025 LOE 1D's call for an enterprise learning architecture enabling "more rigorous assessments" linked to readiness and talent management, and is the exact kind of process LOE 4B's AI/LLM guidance is meant to accelerate. The purpose of this use case is to prototype a tool that uses AI to convert T&R task/standard language into structured, quantifiable rubrics — reducing the SME workload required to build objective performance assessment instruments and improve training plan development, decision-making, and force readiness reporting.

### Requirements

Derived from our thesis proposal's design constraints for a viable Tier 1 assessment framework:
- Rubric output must use **Behaviorally Anchored Rating Scale (BARS)** structure (distinct, observable behavioral anchors per performance tier — e.g., unsatisfactory / satisfactory / proficient), not vague descriptive language.
- Generated anchors must be **traceable to the source T&R standard** — no invented criteria not grounded in the actual task/standard text.
- The tool must **flag standards that are too ambiguous** to yield objective, measurable criteria, so a human evaluator knows where SME judgment is still required.
- Output must be in a **structured, reviewable format** (e.g., spreadsheet or JSON) that an SME can validate, edit, and eventually subject to inter-rater reliability testing (Cohen's Kappa / Krippendorff's alpha).
- Design must reflect the constraint that any resulting field tool **cannot increase administrative burden** on small unit leaders — outputs should be usable by a leader with a tablet during normal training, not require specialized data entry.

### Resources

- Infantry Training & Readiness Manual, NAVMC 3500.44E (2024) — source standards text
- TECOM Campaign Plan 2025, LOE 1D (Total Learning Architecture / Project Triumph) and LOE 4B (Leveraging Data and Artificial Intelligence)
- Smith, P. C., & Kendall, L. M. (1963). *Retranslation of expectations: An approach to the construction of unambiguous anchors for rating scales.* — foundational BARS methodology
- Holland et al. (2022) — applied BARS to simulated non-technical skills assessment; established realistic inter-rater reliability benchmarks (Krippendorff's alpha 0.49–0.74) for structured assessment in high-complexity environments
- Joint Marksmanship Assessment Package (JMAP) — ONR/TECOM precedent for data-driven individual lethality assessment, the closest existing analog to this use case
- NPS thesis proposal: *Quantifying Infantry Small Unit Training: A Data-Driven Framework for Objective Performance Measurement and Readiness Reporting in the USMC* (Hedrick & Leep, available from SME sponsors on request)

### Expected deliverables

- A working prototype demonstrating: T&R task/standard text in → structured, BARS-style draft rubric out, for a representative sample of infantry collective T&R tasks
- A simple review interface allowing an SME to inspect, edit, and approve/reject generated behavioral anchors
- Flagged output identifying standards lacking sufficient objective criteria for automated rubric generation


## 194: Browser Based Agent Governance

Category: Operational Support

### Description

Web based applications face governance challenges from 3rd party browser-based assistants. For example, a web-based application may require users to complete certain actions manually, or ensure that a human is accessing CUI, PII, or PHI and that any browser that either has an AI assistant built in (such as Perplexity Comet) or supports 3rd party browser extension / add-on (such as manus.im) can be prevented from actions that must be completed by a human and protected from 3rd party LLM access of sensitive information.

When a human provides authentication to an AI Assistant with browser control, action provenance, intent, and identity become vital aspects of protecting sensitive information. This has practical application to financial systems (to ensure sensitive financial actions are performed by a human), health and human capital information systems (to ensure PII and PHI is protected), and training and education systems (to ensure academic integrity).


## 240: Browser-Native Threat Assessment and Defensive Wargaming

Category: Wargaming

### Description

Operators in the space and missile defense domains need to detect, classify, and respond to trajectory-based threats faster than current tooling allows. Existing software requires desktop installations, months of training, and tens of thousands per seat annually. Outputs are black-box, making them difficult to defend in a briefing. There is no single tool that takes an analyst from raw trajectory data to a defensible threat assessment, scenario simulation, and scored defensive COA in one workflow. The use case is a unified trajectory-to-decision pipeline that runs in a browser, deploys to any network including air-gapped, and shows its reasoning at every step.


## 246: Command and Control: Decision Advantage

Category: Operational Support

### Description

Create a system in which proper decision-making is streamlined; it allows for exploration of whether the rationale of AI's input is or is not necessary within a specific situation. It guides an end-user to utilizing GenAI if it is applicable. Additionally, it tracks and develops an After-Action Report (AAR) at the conclusion of the individual task to provide a continuous feedback loop and encourage ongiong reflection.

### Requirements

- User experience: Can a first-time user understand the screen without explanation?
- Workflow design: Does each step logically prepare the user for the next?
- Scenario design: Can the problem be taught thorugh a short, realistic scenario?
- Assessment: How do we know the application improved the decision or reduced risk?

### Resources

- Marine Corps Doctrine Publications (nature of warfare and the appropriate use of AI)

### Expected deliverables

Deliverable: 
- Browser-based prototype that operationalizes decision-making advantage.

Capabilities:
- Commander/Leader Guidance
- AI Employment Gate
- AI System Registry 
- Decision Assurance Gate
- Human Decision Record
- Oversight/AAR Dashboard


## 204: CUI Auto-Tagging and Classification Assistant

Category: Operational Support

### Description

LLM-based tool that reads draft documents, briefings, or datasets and recommends CUI markings, classification levels, and handling caveats per DoDM 5200.01. Reduces the human bottleneck that currently slows down data sharing with industry and coalition partners. Direct complement to the Data Sanitization seeded use case. Sanitization is downstream. Correct marking upstream is where the problem starts.


## 248: Curriculum Design and Management System

Category: Operational Support

### Description

Curriculum Design and Management System is an AI-assisted workspace for Marine Corps formal schools to design, manage, and improve curriculum under the Systems Approach to Training and Education (SATE).
It brings curriculum requirements, learning analysis, objectives, lessons, assessments, instructional materials, source documents, and change history into one connected system. Staff can trace how a requirement or KSA connects to objectives, lessons, assessments, and Master Lesson File materials; identify gaps, duplication, and downstream impacts; and move proposed changes through assigned development, review, approval, publication, and follow-through.
AI supports semantic discovery, relationship suggestions, and grounded drafting from permitted sources. It does not make curriculum decisions or approvals. Human users retain responsibility for policy interpretation, change decisions, and official-record updates in MCTIMS.

### Requirements

- Maintain distinct, versioned curriculum building blocks, including requirements, tasks/METs, performance steps, KSAs, TLOs/ELOs, lessons, assessments, concept cards, and Master Lesson File materials.
- Make relationships among curriculum objects navigable, including requirement → KSA → objective → lesson → assessment → instructional material.
- Preserve immutable versions, source locators, ownership, rationale, and attributable decision history.
- Import and organize permitted curriculum records and supporting evidence from existing sources such as MCTIMS exports, lesson materials, meeting records, assessment data, and course feedback.
- Provide semantic search that helps users find related curriculum objects, repeated language, possible gaps, and potential downstream impacts. Suggested relationships remain visible for human confirmation; they are not automatically treated as authoritative.
- Support a change-package workflow that can coordinate revisions across multiple lessons, objectives, assessments, and materials.
- Separate participation, work ownership, review, approval, publication, official-system update, and closure as distinct recorded actions.
- Allow authorized schoolhouse users to configure local review paths, responsibilities, conditional routes, and closeout requirements.
- Provide role- and scope-based access to curriculum, evidence, files, model-assisted retrieval, exports, and workflow actions.
- Produce an approved-change handoff for MCTIMS staff and record the resulting official POI update separately from internal approval.
- Keep manual curriculum-management work usable when AI assistance is unavailable.

### Resources

[NAVMC 1553.1A, Marine Corps Instructional Systems Design/Systems Approach to Training and Education Handbook](https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/1044650/navmc-15531a/)

[NAVMC 1553.2A, Marine Corps Formal School Management Policy Guidance](https://www.marines.mil/Portals/1/Publications/NAVMC%201553.2A.pdf?ver=uSnDpz2KbftlhC8Fk0OzOA%3D%3D)

[NAVMC 3500.106A, Ground Training and Readiness Program Manual](http://www.marines.mil/Portals/1/Publications/NAVMC%203500.106A.pdf?ver=lXA7C1WsQPHCSgjJB_96AA%3d%3d)

### Expected deliverables

- A working proof of concept showing a connected curriculum workspace for a selected reference course.

- A navigable relationship view connecting curriculum requirements, KSAs, objectives, lessons, assessments, and instructional materials.

- Import of a permitted curriculum data set and associated instructional-material metadata.

- Semantic search that retrieves related curriculum content and presents possible connections for human review.

- A change-package workflow that demonstrates intake, assignment, revision development, review, approval, and follow-through.

- Versioned before-and-after views for proposed curriculum revisions, with rationale, source references, and decision history.

- Configurable role and workflow examples for contributors, reviewers, approvers, curriculum managers, and records staff.

- AI enabled change recommendations for curriculum components, material, and course structure.

- A short demonstration scenario and walkthrough showing how a schoolhouse identifies a curriculum concern, traces affected content, develops a change, obtains review, and records implementation.


## 180: Learning Intelligence Dashboard (LID)

Category: Performance Assessment

### Description

An AI-powered system that analyzes learning artifacts (discussion forums, assignments, training logs, after-action reviews) to produce structured competency evidence aligned with Marine Corps training standards. LID answers critical questions: To what extent is learning occurring? Are Marines demonstrating required competencies? Are instructors providing effective training?

Analyzes student forum discussions, written assignments, chat based student tutor sessions to assess critical thinking, demonstrated skills, professional military competencies, and cognitive depth through automated LLM integration with audit trails for transparency.

Applicable to: Professional Military Education (PME), formal MOS school training and education, unit-level training assessment, instructor evaluation, and competency-based progression tracking across MOS pipelines.


## 220: Low Resource Language Enablement for Enterprise AI

Category: Personalized Learning

### Description

Organizations expanding into regions with low-resource languages face a critical capability gap as commercial LLMs perform poorly due to limited training data. Teams will develop a solution architecture that enables large language models to perform at production quality in a designated low-resource language (e.g., Icelandic), supporting both everyday high-frequency tasks (drafting, summarization, translation) and specialized knowledge tasks (domain-specific Q&A, regulatory analysis) with measurable parity to English-language performance.


## 195: Multi-model Just-in-time Context and Role Aware AI Support Agents for web-based Ecosystems

Category: Operational Support

### Description

Complex web-based ecosystems with SSO to multiple applications that support enterprise level populations face training and support challenges. Users may have elevated privileges based on role in one application and not another or elevated privileges based on role in one part of one application such as within a course where they are an instructor but not another course where the individual is a student. Systems that support large user populations with complex, dynamic, role and context-based permission sets need context and role aware persona-based AI Assistants to users at scale in their environments with RAG for natural language query support.


## 245: PME Course Material Mastery Evaluation Agent

Category: Performance Assessment

### Description

This project would explore the use of an AI agent to assess (and possibly evaluate) how well individual students have “mastered” the course material presented in the EWSDEP 8670 Prerequisite course. The course is made up of 13 lessons. Currently, students read the lesson overview and reading material and then take a multiple-choice quiz. This project would expand upon the limited utility of the quizzes to gauge student knowledge of the courseware’s material through a discussion with an AI agent. The AI agent’s assessment would be grounded in a rubric derived from the Educational Objectives of the specific lessons. It is envisioned that the discussion could continue or be repeated until the given student has demonstrated an acceptable level of mastery (in accordance with the rubric).

### Requirements

A “packaged” (stand-alone) AI agent that must:
1. Assess student knowledge of each lesson’s material and the course material as a whole in accordance with the rubric/Educational Objectives.
2. Be imbedded in the current Learning Management System (LMS) (Moodle) or be able to be called to from the LMS from the larger Marine Corps eLearning Ecosystem (MCeLE) – to be seamless to the student.
3. Be easily updatable to reflect the most current lessons, readings, and Educational Objectives.
4. Be able to develop a rubric from the provided Educational Objectives (to be human-validated).
5. Provide feedback to the students on their levels of knowledge in relation to the rubric.
6. Coach and guide students to reach acceptable levels of knowledge mastery.
7. Record a score in accordance with the rubric (if eventually used for evaluation) to be passed to the LMS.
8. Be accessible from MCEN, .edu, and personal devices.

### Resources

1. 8670 Course Overview
2. Lesson Overview Cards (containing the Educational Objectives, Key Terms, and listed reading materials)
3. Lesson Reading Material
https://elearning.mcele.usmc.mil/moodle/course/view.php?id=8

### Expected deliverables

A downloadable AI agent accessible from MCEN, .edu, and personal devices that meets requirements.


## 247: Project Course Cadence

Category: Content Generation

### Description

Defense training pipelines lag behind rapid tactical evolution, yet conventional AI tools cannot simply summarize manuals into viable curricula without hallucinating procedures, obscuring pedagogical reasoning, and omitting critical front-end analysis. Project CADENCE turns course creation from an opaque prompt into an auditable, interactive ISD workflow. The system conducts a guided Job Task Analysis (JTA) to capture operational context, objectively evaluates source-material sufficiency to flag information gaps, generates Bloom’s-aligned educational objectives paired with valid criterion-referenced assessments, and scripts production-ready multimedia storyboards. Rather than relying on a single AI generation, CADENCE routes every draft through an inspectable three-pillar review board (Doctrinal SME, Multimedia/UX, and Editorial/Standards) that outputs a visible critique ledger. This replaces the "AI black box" with an evidence-based audit trail—collapsing curriculum development from months to minutes while preserving instructional integrity.

### Requirements

Functional Capabilities:

Interactive JTA & Objective Elicitation: Conversational front-end defining target duties, environmental conditions, and Bloom's-aligned learning objectives ().

Source Sufficiency Engine: Automated check evaluating whether provided doctrine contains adequate operational detail, explicitly flagging missing procedural or safety data before drafting.

Valid & Reliable Assessment Generator: Creates criterion-referenced evaluation instruments (hands-on Performance Evaluation Checklists / PECs and scenario-based questions with diagnostic distractor rationales).

Multimedia Scripting & Storyboarding: Generates two-column audio/video (AV) scripts and panel-by-panel storyboard outlines for e-learning and synthetic training.

Three-Pillar Critique Ledger: Visible, exportable audit trail showing distinct feedback and automated corrections from Doctrinal, Media, and Editorial perspectives.

Human-in-the-Loop Governance: Gated checkpoints allowing instructors to inspect artifacts, override critique recommendations, and authorize final compilation.

Technical Architecture (Sprint vs. Strategic 

Roadmap):

Hackathon Prototype (4-Day Sprint): Python-based multi-agent state graph (LangGraph) with a lightweight, containerized UI (Streamlit/Docker) for local execution and rapid live demonstration.

Strategic Roadmap (Production Defense Cloud): Designed to route inferences through the GenAI.mil API and deploy within DoD Impact Level 4/5 (IL-4/IL-5) secure enclaves handling Controlled Unclassified Information (CUI).

### Expected deliverables

Phase 1: JTA Working Model & Architecture (Days 1–2):

Interactive JTA front-end module.

Working Source-Sufficiency Evaluator identifying data completeness and flagging information gaps.

Multi-agent pipeline generating validated learning objective hierarchies (TLOs/ELOs).

Phase 2: Multimedia Drafting, Assessment & Critique Engine (Days 3–4):

Valid assessment item generator producing PEC rubrics and scenario-based questions with distractor rationales.

Two-column AV script and visual storyboard generator.

Multi-functional review board producing an inspectable critique ledger.

Containerized end-to-end web prototype.

Pitch Package & Demonstration:

Live Operational Demo: Ingesting a technical manual extract  interactive JTA  automated sufficiency check  live generation of lesson plan, assessment rubric, and storyboard  live demonstration of the multi-pillar critique board catching and correcting a doctrinal flaw.

Executive Pitch Deck (3-Minute Presentation): Demonstrating measurable operational time savings, elimination of the "AI black box," and alignment with future GenAI.mil enterprise deployment.


## 157: Student Pilot Performance Analytics

Category: Performance Assessment

### Description

To meet the demands of a rapidly changing global security environment, the Air Force has set a target of producing 1,500 pilots annually. To achieve this, training pipelines have been overhauled with innovations such as commercial flight school partnerships, separate rotary and fixed-wing tracks, streamlined syllabi, and competency-based progression. As these approaches are implemented, it is critical to evaluate their effectiveness in real time to ensure reforms are producing not just more pilots, but aviators of the highest quality, capable of meeting the mission in any environment.

The Graduate Training Integration Management System (GTIMS) captures every student grade book and instructor comment across sorties, simulators, and academics for both undergraduate and graduate programs—creating a rich but underused dataset. GTIMS is employed across Undergraduate Pilot Training (UPT), Undergraduate Navigator Training (UNT), ENJJPT, and follow-on graduate training, and is used by multiple major commands including AETC, ACC, AMC, and AFSOC.

This project begins with the helicopter training pipeline, which transitioned to a direct-to-helicopter, rotary-only program beginning in 2021. Multiple iterations of new syllabi have since been implemented, resulting in tThousands of grade books which also parallel the structure of fixed-wing training.

By analyzing this data, the project aims to provide performance insights that highlight areas requiring additional attention early, track and assess the effects of breaks in training on performance outcomes and evaluate the impact of syllabus changes. These insights will allow instructors to tailor remediation, commanders to monitor training health, and syllabus developers to refine course design, among other uses. Starting with helicopters but designed to scale across all flying training programs, this project leverages GTIMS to deliver actionable analytics that help create and sustain the most effective training for the Air Force's next generation of aviators.


## 146: Wargaming Learning Analysis Dashboard

Category: Wargaming

### Description

Build an AI-assisted dashboard that analyzes wargame artifacts and surfaces learning insights tied to decision-making and educational outcomes.

### Requirements

## Hackathon Scope
Develop a working prototype achievable during the hackathon.

### Minimum Viable Prototype
- Analyze a sample set of AARs, facilitator notes, or decision logs.
- Identify learning themes and decision patterns using AI.
- Display findings in a dashboard or report.
- Map observations to a simple competency framework.

### Optional Enhancements
- Cohort comparisons.
- Trend analysis.
- Curriculum recommendations.

### Resources

Datasets: Synthetic wargame data, facilitator notes, AARs.
References: PME competency frameworks, xAPI standards.

### Expected deliverables

Working prototype; presentation link; demo link; repository link (if applicable); architecture diagram; tools used; transition vision.

### Evaluation criteria

Standard hackathon rubric plus emphasis on actionable insights, clarity of visualization, and mission relevance.

Skills: learning analytics, data visualization, wargaming analysis, llm


## 147: AI Tutor

Category: Personalized Learning

### Description

Build a conversational AI tutor that uses approved educational content to provide source-cited learning support.

### Requirements

## Hackathon Scope
Prototype only; enterprise LMS integration is optional.

### Minimum Viable Prototype
- Implement RAG against provided content.
- Answer learner questions.
- Display source citations.
- Generate study guides and quizzes.

### Optional Enhancements
- Personalized recommendations.
- Adaptive remediation.
- Learning analytics.

### Resources

Datasets: Course materials, doctrine, PME content.
References: RAG architectures and learning analytics standards.

### Expected deliverables

Tutor prototype; live demo; presentation; architecture diagram; tools used; repository if applicable.

### Evaluation criteria

Standard rubric with emphasis on response quality, citations, learner usefulness, and ease of use.

Skills: rag, nlp, prompt engineering, chatbot development, adaptive learning, llm, natural language processing


## 148: AI Instructional Design Assistant

Category: Content Generation

### Description

Build an AI assistant that rapidly generates instructional content aligned to learning objectives.

### Requirements

## Hackathon Scope
Focus on one streamlined content creation workflow.

### Minimum Viable Prototype
- Generate assessments from lesson content.
- Generate discussion prompts.
- Generate one scenario-based exercise.
- Produce an instructor summary.

### Optional Enhancements
- H5P assets.
- Branching scenarios.
- Multimedia concepts.

### Resources

ADDIE, Bloom's Taxonomy, H5P, SCORM, instructional design references, course content.

### Expected deliverables

Working prototype; generated content examples; presentation; demo; tools used; architecture diagram.

### Evaluation criteria

Standard rubric with emphasis on instructional alignment, quality of generated content, and instructor usability.

Skills: instructional design, generative ai, assessment development, h5p, scorm, llm


## 149: AI Chat Activity Evaluator

Category: Performance Assessment

### Description

Build a prototype that analyzes AI-assisted learning conversations and surfaces evidence of learning and competency development.

### Requirements

## Hackathon Scope
Build a prototype learning analytics capability

### Minimum Viable Prototype
- Analyze chat transcripts.
- Classify interactions using Bloom's Taxonomy / Bloom's Digital Taxonomy.
- Generate competency and skill indicators.
- Create a dashboard with insights and recommendations.

### Optional Enhancements
- Growth timelines.
- Portfolio generation.
- Recommended roles and positions.

### Resources

Bloom's Taxonomy, Bloom's Digital Taxonomy, competency frameworks, synthetic chat datasets, xAPI standards, explainable AI references.

### Expected deliverables

Analytics prototype; dashboard; demo dataset; presentation; demo; tools used; architecture diagram.

### Evaluation criteria

Standard rubric with emphasis on explainability, educational validity, and dashboard effectiveness.

Skills: learning analytics, competency modeling, nlp, bloom taxonomy, dashboard development, explainable ai


## 150: AI Learning Support Assistant

Category: Operational Support

### Description

Build an AI-powered assistant that helps users navigate learning systems, policies, and support workflows.

### Requirements

## Hackathon Scope
Prototype an enterprise learning system support assistant

### Minimum Viable Prototype
- Answer policy questions.
- Retrieve information from documentation.
- Recommend courses.
- Provide troubleshooting guidance.
- Generate draft support tickets.

### Optional Enhancements
- Escalation workflows.
- Accessibility reviews.
- Support analytics.

### Resources

LMS documentation, policy references, help desk knowledge articles, accessibility guidance.

### Expected deliverables

Support assistant prototype; demo scenarios; presentation; demo; tools used; architecture diagram.

### Evaluation criteria

Standard rubric with emphasis on retrieval quality, user experience, and workflow effectiveness.

Skills: rag, knowledge management, help desk, workflow automation, chatbot, llm


## 151: Marine Corps Planning Process Instructional Content Modernization

Category: Content Generation

### Description

Build an AI-enhanced learning experience that helps Marines learn and practice the Marine Corps Planning Process to support asynchronous learning and professional military education.

### Requirements

## Hackathon Scope
Focus on a single MCPP learning experience.

### Minimum Viable Prototype
- Deliver one MCPP lesson.
- Support one planning scenario.
- Provide AI coaching.
- Deliver learner feedback.

### Optional Enhancements
- Branching scenarios.
- Group planning.
- Competency assessment.

### Resources

MCPP doctrine, PME resources, tactical decision games, operational planning case studies.

### Expected deliverables

Learning prototype; coaching demo; planning scenario; presentation; demo; tools used; architecture diagram.

### Evaluation criteria

Standard rubric with emphasis on educational effectiveness, coaching quality, and planning relevance.

Skills: mcpp, scenario based learning, rag, llm, instructional design, coaching agent


## 133: Red Cell Doctrinal SME Agent

Category: Wargaming

### Description

Develop an agentic system to participate in wargaming as the red cell (or any other speciality planning cell where human subject matter experts are of limited availability) that acts in accordance with that entities actual doctrine and TTPs.

### Requirements

Solutions presented must also come with initial benchmarking and testing against that doctrine set to provide initial verification and validation.

