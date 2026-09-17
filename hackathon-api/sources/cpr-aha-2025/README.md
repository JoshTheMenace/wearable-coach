# CPR references for application seeding

Dataset #351 is Prolonged Casualty Care, not a dedicated CPR curriculum. Searching its book XML found incidental CPR mentions in chapter 206301 (Circulation / Shock), concerning other clinical procedures. No dedicated BLS/CPR lesson was found. All 79 chapters have been extracted to ../dataset-351-extracted/chapters.json with source archive member and chapter IDs, plain text and original HTML. Clinical content was not validated.

`sources.json` identifies the relevant external American Heart Association 2025 sources. It contains URLs and metadata, not the clinical source text. Direct downloads returned HTTP 403, so no PDFs were saved.

Use Adult Basic Life Support for clinical content and Resuscitation Education Science for training design. Choose adult lay-rescuer versus healthcare-professional scope explicitly. Keep pediatric material separate. Algorithms alone are not a complete course or an assessment rubric.

For the prototype, have a CPR instructor review the exercise and rubric. A feedback manikin provides measured compression performance; camera-only estimates should not be treated as validated measurements. AHA education guidance discusses feedback devices and limitations of AR for teaching CPR skills.
