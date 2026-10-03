export const HEAD = '34e2577c6e082ad82a7318e22512ca10e6b69e0e';
export const SOURCE_SHA = '71a3d3620bee065356d69058ad860de0c6e43d8d9786f263f9d914dc10abfedc';
export const SCENARIOS = [
  'default', 'queue', 'resume-false', 'resume-true', 'same-id-same-body',
  'same-id-conflict', 'admission-response-loss', 'create-loss-before', 'create-loss-after',
] as const;
export type Scenario = typeof SCENARIOS[number];
export type Selection = { generation: 'v1' | 'v2'; version: string; scenario: Scenario };
export function selection(generation: string, version: string, scenario: string): Selection {
  const pins = generation === 'v1' ? ['1.16.0', '1.18.34'] : generation === 'v2' ? ['2.0.0', '2.0.21'] : [];
  if (!pins.includes(version) || !SCENARIOS.includes(scenario as Scenario)) throw new Error('explicit exact pin and scenario required');
  return { generation: generation as Selection['generation'], version, scenario: scenario as Scenario };
}
export function promptBody(s: Selection, callerID: string, marker: string) {
  if (s.generation === 'v1') {
    if (['queue', 'resume-false', 'resume-true'].includes(s.scenario)) return null;
    return { messageID: callerID, model: { providerID: 'test-model', modelID: 'q0-catalog' }, parts: [{ type: 'text', text: marker }] };
  }
  return { id: callerID, text: marker,
    ...(s.scenario === 'queue' ? { delivery: 'queue' } : {}),
    ...(s.scenario === 'resume-false' ? { resume: false } : {}),
    ...(s.scenario === 'resume-true' ? { resume: true } : {}),
  };
}
export const REMAINING = [
  'cancellation-before-delivery', 'delayed/late provider admission after stop',
  'midtool interruption', 'foreign steering/batch', 'compaction/multistep/child',
  'finite accepted causal proof algorithm', 'independent native execution of every selected pin/scenario',
];
export function object(v: any) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('malformed object');
  return v;
}
