import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const shortText = z.string().trim().min(1).max(800);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const texts = z.array(shortText).max(30);
const sourceSchema = z.object({
  id, title: shortText, url: z.url().max(1000).refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }), sections: texts, guideline_year: z.number().int().min(1900).max(2100).nullable(),
});
const observationSchema = z.object({
  kind: shortText, camera_can_support: shortText, camera_cannot_certify: texts,
  cadence: shortText, evidence_rules: texts, per_finding_fields: texts,
  status_values: texts, evidence_type_values: texts,
});
const datasetSchema = z.object({
  dataset_id: id, version: z.string().min(1).max(60), checked_date: z.iso.date(),
  title: shortText, clinical_review_status: shortText,
  scope: z.object({
    patient: shortText, learner: shortText, default_mode: z.literal('compression_only'),
    not_covered: texts, simulation_rules: texts, real_emergency_boundary: shortText,
  }),
  source_policy: z.object({ fact_kind: shortText, priority: shortText, reuse: shortText }),
  sources: z.array(sourceSchema).min(1).max(30),
  facts: z.array(z.object({
    id, source_id: id, applies_to: z.enum(['all', 'compression_only', 'trained_lay_with_breaths']),
    text: shortText,
    parameters: z.record(id, z.union([z.string().max(100), z.number().finite()]))
      .refine(value => Object.keys(value).length <= 20).optional(),
  })).min(1).max(200),
  observation_limits: observationSchema,
  practice_rubric: z.object({ criteria: z.array(z.object({ id, fact_ids: z.array(id).max(30) })).max(100) }),
  demo_scenario: z.object({ flow: z.array(z.object({ fact_ids: z.array(id).max(30).optional() })).max(100) }),
  agent_checks: z.object({ cases: z.array(z.object({ expected_fact_ids: z.array(id).max(30).optional() })).max(100) }),
}).superRefine((dataset, ctx) => {
  const sourceIds = new Set(dataset.sources.map(source => source.id));
  const factIds = new Set(dataset.facts.map(fact => fact.id));
  const references = [
    ...dataset.practice_rubric.criteria.flatMap(criterion => criterion.fact_ids),
    ...dataset.demo_scenario.flow.flatMap(phase => phase.fact_ids ?? []),
    ...dataset.agent_checks.cases.flatMap(check => check.expected_fact_ids ?? []),
  ];
  if (sourceIds.size !== dataset.sources.length || factIds.size !== dataset.facts.length ||
      dataset.facts.some(fact => !sourceIds.has(fact.source_id)) || references.some(ref => !factIds.has(ref))) {
    ctx.addIssue({ code: 'custom', message: 'Dataset IDs and source/fact references must be unique and valid.' });
  }
  const contextBytes = Buffer.byteLength(JSON.stringify({ scope: dataset.scope, sources: dataset.source_policy,
    limits: dataset.observation_limits, title: dataset.title, review: dataset.clinical_review_status }));
  if (contextBytes > 6_000 || dataset.facts.some(fact => Buffer.byteLength(JSON.stringify(fact)) +
      Buffer.byteLength(JSON.stringify(dataset.sources.find(source => source.id === fact.source_id) ?? null)) > 3_000)) {
    ctx.addIssue({ code: 'custom', message: 'Dataset context and individual references must fit the bounded lookup response.' });
  }
});

export const knowledgeQuerySchema = z.object({
  query: z.string().trim().min(1).max(1200), limit: z.number().int().min(1).max(5).default(3),
}).strict();
type Dataset = z.infer<typeof datasetSchema>;
type Fact = Dataset['facts'][number];
export type DatasetMetadata = {
  id: string; version: string; hash: string; title: string; checkedDate: string; clinicalReviewStatus: string;
};
export type KnowledgeStatus = {
  status: 'ready' | 'unavailable'; dataset: DatasetMetadata | null; factCount: number;
  indexedFactCount: number; mode: 'compression_only'; error?: string;
};
export type KnowledgeSearchResult = {
  status: 'found' | 'no_match' | 'out_of_scope' | 'unavailable';
  dataset: DatasetMetadata | null;
  scope: {
    patient: string; learner: string; mode: 'compression_only'; notCovered: string[];
    excludedFactIds: string[]; realEmergencyBoundary: string; simulationRules: string[];
  } | null;
  sourcePolicy: Dataset['source_policy'] | null;
  observationLimits: z.infer<typeof observationSchema> | null;
  results: {
    factId: string; text: string; parameters?: Fact['parameters'];
    source: { id: string; title: string; url: string; sections: string[]; guidelineYear: number | null };
  }[];
  limitations: string[];
};

const unavailable = 'Knowledge dataset could not be loaded or validated.';
const simulationRules = new Set([
  'Never practice chest compressions on a healthy volunteer.',
  'Use a non-shocking AED trainer in the demo.',
  'Simulate emergency calls; do not actually dial 911 for practice.',
]);
const limitations = [
  'User-supplied reference facts for adult, lay-rescuer, compression-only manikin practice; not a validated curriculum or certification assessment.',
  'This application has not clinically reviewed or independently verified these facts. Clinical review status and source claims are supplied by the dataset.',
  'Reference facts are not evidence that the learner performed a step. Prototype rules, practice rubrics and synthetic scenarios are not searched as clinical facts.',
];
const stopwords = new Set('a an and are as at be been but by can could do does for from give how i if in is it me my of on or our please should tell than that the their them then there these they this to us use was we what when where which who why will with would you your cpr training practice adult manikin'.split(' '));
const tokens = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .match(/[a-z0-9]+/g)?.filter(word => !stopwords.has(word)).map(word => word.length > 4 ? word.replace(/s$/, '') : word) ?? [];
// Query vocabulary belongs to individual reference facts, never the authored assessment rubric.
const aliases: Record<string, string> = {
  recognize: 'recognition gasping gasp breathing breath unresponsive unconscious collapse agonal',
  pulse: 'pulse palpation check heartbeat lay', activate: 'activate activation emergency call phone response alone lone',
  hands_only: 'hands only compression only without breaths no breaths skip breaths untrained unwilling',
  hand_location: 'hand hands placement location heel sternum center chest overlap',
  depth: 'depth deep far distance centimeter centimeters cm inch inches',
  rate: 'rate fast speed pace rhythm rhythmic frequency tempo metronome cadence',
  recoil: 'recoil release releasing relax rebound leaning lean chest return',
  scene: 'scene safety safe responsive responsiveness check assessment protect protection',
  help: 'help call phone emergency 911 ambulance obtain fetch aed delegate',
  position: 'position posture kneel knees shoulders elbows straight surface floor firm flat face up',
  interruptions: 'interruptions pause pauses interruption stop seconds',
  aed_setup: 'aed setup pads pad placement place attach electrode defibrillator dry expose cable',
  aed_clear: 'aed clear nobody touches touching contact analysis shock safety stand back',
  aed_resume: 'aed resume restart after shock no shock decision continue',
  continue: 'continue stop stopping end duration exhaustion unsafe signs life responder ems',
  relief: 'relief rotate rotation alternate switch swap tired compressors minute minutes',
  feedback: 'feedback sensor manikin measurement measured quality grading grade evaluate assessment accurate reliable',
  retention: 'retention booster refresh refresher spacing spaced learning repeat later',
  ar_evidence: 'ar augmented reality glasses evidence validated prototype',
};
const excludedScope = /\b(infants?|bab(?:y|ies)|child(?:ren)?|kids?|pediatric|paediatric|newborn|neonat\w*|toddlers?|teen\w*|adolescen\w*|dogs?|cats?|pets?|drown\w*|trauma\w*|combat|gunshot|bleeding|opioid\w*|overdos\w*|naloxone|pregnan\w*|chok\w*|airway\s+(?:device|management)|intubat\w*|advanced\s+airway\w*|drug\w*|medication\w*|epinephrine|healthcare\s+professional|professional\s+(?:bls|pulse)|acls)\b/i;
const childAge = /\b(?:[0-9]|1[0-7]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[-\s]+(?:years?[-\s]+old|months?[-\s]+old)\b/i;
const breathsRequest = /\b(breaths?|ventilat\w*|mouth\s+to\s+mouth|30\s*[:/]\s*2|rescue\s+breath\w*|trained_lay_with_breaths)\b/i;
const explicitBreathsRequest = /\b(rescue\s+breaths?|ventilat\w*|mouth[-\s]+to[-\s]+mouth|30\s*[:/]\s*2|trained_lay_with_breaths|(?:give|giving|deliver|delivering|perform|performing|provide|providing|teach)\s+(?:(?:a|the|two|[0-9]+)\s+)?breaths?|how\s+many\s+breaths?)\b/i;
const handsOnlyQuestion = /\b(compression[-\s]only|hands[-\s]only|without\s+(?:giving\s+)?breaths?|no\s+breaths?|skip\s+breaths?|omit\w*\s+breaths?)\b/i;
const realEmergency = /\b(this\s+is\s+real|not\s+a\s+drill|real\s+emergency|(?:someone|person|patient|friend|partner|wife|husband|mom|dad)\s+(?:has\s+)?collapsed\s+(?:right\s+)?now)\b/i;
const breathingRecognition = /\b(gasp\w*|(?:normal|abnormal|absent|agonal)\s+breaths?|breathing\s+(?:normal|check)|check\s+(?:the\s+)?breathing|(?:breaths?\s+(?:are|is)\s+(?:not\s+)?normal))\b/i;

export function createKnowledgeBase(path = fileURLToPath(new URL('../../hackathon-api/seed-data/cpr-training-seed.json', import.meta.url))) {
  let dataset: Dataset | undefined;
  let metadata: DatasetMetadata | null = null;
  try {
    if (statSync(path).size > 256 * 1024) throw new Error('Dataset too large');
    const raw = readFileSync(path, 'utf8');
    dataset = datasetSchema.parse(JSON.parse(raw));
    metadata = {
      id: dataset.dataset_id, version: dataset.version, hash: createHash('sha256').update(raw).digest('hex'),
      title: dataset.title, checkedDate: dataset.checked_date, clinicalReviewStatus: dataset.clinical_review_status,
    };
  } catch { /* Loading failure is reported by both public methods, never a startup exception. */ }
  const facts = dataset?.facts.filter(fact => fact.applies_to !== 'trained_lay_with_breaths') ?? [];
  const documents = facts.map(fact => tokens(`${fact.id} ${aliases[fact.id] ?? ''} ${fact.text} ${JSON.stringify(fact.parameters ?? {})}`));
  const frequency = new Map<string, number>();
  for (const document of documents) for (const token of new Set(document)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / (documents.length || 1);

  return {
    lessonSeed() {
      if (!dataset) return null;
      return { dataset: metadata, scope: 'Adult lay-rescuer compression-only manikin practice',
        facts: facts.map(fact => ({ id: fact.id, text: fact.text, parameters: fact.parameters, source: dataset.sources.find(source => source.id === fact.source_id)! })),
        observationLimits: dataset.observation_limits, emergencyBoundary: dataset.scope.real_emergency_boundary };
    },
    status(): KnowledgeStatus {
      return { status: dataset ? 'ready' : 'unavailable', dataset: metadata, factCount: dataset?.facts.length ?? 0,
        indexedFactCount: facts.length, mode: 'compression_only', ...(!dataset && { error: unavailable }) };
    },
    search(input: { query: string; limit?: number }): KnowledgeSearchResult {
      const { query, limit } = knowledgeQuerySchema.parse(input);
      const result: KnowledgeSearchResult = {
        status: 'unavailable', dataset: metadata,
        scope: dataset ? {
          patient: dataset.scope.patient, learner: dataset.scope.learner, mode: 'compression_only', notCovered: dataset.scope.not_covered,
          excludedFactIds: dataset.facts.filter(fact => fact.applies_to === 'trained_lay_with_breaths').map(fact => fact.id),
          realEmergencyBoundary: dataset.scope.real_emergency_boundary,
          simulationRules: dataset.scope.simulation_rules.filter(rule => simulationRules.has(rule)),
        } : null,
        sourcePolicy: dataset?.source_policy ?? null, observationLimits: dataset?.observation_limits ?? null,
        results: [], limitations: [...limitations],
      };
      const finish = (): KnowledgeSearchResult => Buffer.byteLength(JSON.stringify(result)) <= 10_000 ? result : {
        status: 'unavailable', dataset: null, scope: null, sourcePolicy: null, observationLimits: null,
        results: [], limitations: ['Knowledge response exceeds the supported size. No partial reference facts were returned.'],
      };
      if (!dataset) { result.limitations.push(unavailable); return finish(); }
      if (realEmergency.test(query)) {
        result.status = 'out_of_scope';
        result.limitations.push(dataset.scope.real_emergency_boundary);
        return finish();
      }
      if (excludedScope.test(query) || childAge.test(query)) {
        result.status = 'out_of_scope';
        result.limitations.push('This query includes a patient group, circumstance or protocol outside this adult lay-rescuer practice module. No facts were returned.');
        return finish();
      }
      if (explicitBreathsRequest.test(query) ||
          (breathsRequest.test(query) && (!handsOnlyQuestion.test(query) && !breathingRecognition.test(query) || /\b(ratio|duration|volume|technique)\b/i.test(query)))) {
        result.status = 'out_of_scope';
        result.limitations.push('Rescue-breath instruction is not enabled in compression-only mode. The trained-lay-rescuer breaths fact is excluded from retrieval.');
        return finish();
      }
      const queryTokens = [...new Set(tokens(query))];
      const ranked = facts.map((fact, index) => {
        const document = documents[index];
        const score = queryTokens.reduce((sum, token) => {
          const count = document.filter(word => word === token).length;
          if (!count) return sum;
          const rarity = Math.log(1 + (documents.length - (frequency.get(token) ?? 0) + 0.5) / ((frequency.get(token) ?? 0) + 0.5));
          return sum + rarity * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * document.length / averageLength));
        }, 0) + tokens(fact.id).filter(token => queryTokens.includes(token)).length * 3;
        return { fact, score, index };
      }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit);
      for (const { fact } of ranked) {
        const source = dataset.sources.find(source => source.id === fact.source_id)!;
        result.results.push({ factId: fact.id, text: fact.text, ...(fact.parameters && { parameters: fact.parameters }), source: {
          id: source.id, title: source.title, url: source.url, sections: source.sections, guidelineYear: source.guideline_year,
        } });
      }
      result.status = result.results.length ? 'found' : 'no_match';
      if (!result.results.length) result.limitations.push('No supporting reference matched this query; do not invent a grounded answer.');
      return finish();
    },
  };
}
