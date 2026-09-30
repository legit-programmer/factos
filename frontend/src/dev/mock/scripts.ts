// Content for the mock backend: seeded knowledge bases and scripted answer pairs.
// Grounded text cites chunks with `[[key]]`; findings quote the ungrounded text exactly, and every
// evidence excerpt is a substring of its chunk, mirroring what the real verifier must satisfy.

import type { Locator } from '../../api/types'

export interface CorpusChunk {
  key: string
  text: string
  locator: Locator
}

export interface CorpusSource {
  title: string
  chunks: CorpusChunk[]
}

export interface ScriptFinding {
  quote: string
  verdict: 'contradicted' | 'unverifiable'
  reason_code: string
  reason: string
  correction?: string | null
  evidence?: { key: string; excerpt: string }[]
}

export interface Script {
  match: RegExp
  rag: string
  baseline: string
  findings: ScriptFinding[]
}

export const WEBB: CorpusSource[] = [
  {
    title: 'Webb mission facts.pdf',
    chunks: [
      {
        key: 'partners',
        locator: { page: 1 },
        text: 'Webb is an international collaboration between NASA, the European Space Agency (ESA) and the Canadian Space Agency (CSA).',
      },
      {
        key: 'launch',
        locator: { page: 2 },
        text: "Webb launched on 25 December 2021 aboard an Ariane 5 rocket from Europe's Spaceport in Kourou, French Guiana.",
      },
      {
        key: 'science',
        locator: { page: 3 },
        text: 'Science operations began in July 2022 after six months of commissioning.',
      },
    ],
  },
  {
    title: 'L2 orbit primer.pdf',
    chunks: [
      {
        key: 'arrival',
        locator: { page: 2 },
        text: 'On 24 January 2022, about a month after launch, Webb reached its operating position: a halo orbit around the Sun–Earth L2 point, roughly 1.5 million km from Earth.',
      },
      {
        key: 'geometry',
        locator: { page: 3 },
        text: 'L2 lies on the Sun–Earth line beyond Earth, so the Sun, Earth and Moon stay on one side of the telescope.',
      },
      {
        key: 'stationkeeping',
        locator: { page: 4 },
        text: 'The L2 point is unstable, so Webb fires its thrusters for small station-keeping manoeuvres about every three weeks.',
      },
    ],
  },
  {
    title: 'Webb optics overview.pdf',
    chunks: [
      {
        key: 'segments',
        locator: { page: 4 },
        text: 'The primary mirror is made of 18 hexagonal gold-coated beryllium segments.',
      },
      {
        key: 'sunshield',
        locator: { page: 7 },
        text: 'A five-layer sunshield about the size of a tennis court keeps the 6.5 m gold-coated beryllium primary mirror and instruments cold, below about 50 K.',
      },
    ],
  },
]

export const AI_ACT: CorpusSource[] = [
  {
    title: 'EU AI Act summary.pdf',
    chunks: [
      { key: 'entry', locator: { page: 1 }, text: 'The AI Act entered into force on 1 August 2024.' },
      {
        key: 'prohibitions',
        locator: { page: 3 },
        text: 'Prohibitions on unacceptable-risk AI practices apply from 2 February 2025.',
      },
      {
        key: 'gpai',
        locator: { page: 4 },
        text: 'Obligations for general-purpose AI models apply from 2 August 2025.',
      },
      {
        key: 'highrisk',
        locator: { page: 5 },
        text: 'Most remaining provisions, including high-risk rules for Annex III systems, apply from 2 August 2026.',
      },
    ],
  },
]

export const PRICING: CorpusSource[] = [
  {
    title: 'Pricing page brief.md',
    chunks: [
      {
        key: 'plans',
        locator: { heading: 'Plans', line_start: 3, line_end: 5 },
        text: 'Starter is $12 per seat per month billed annually; Team is $24 per seat per month.',
      },
      {
        key: 'trial',
        locator: { heading: 'Trial', line_start: 7, line_end: 8 },
        text: 'Every plan includes a 14-day free trial with no credit card required.',
      },
    ],
  },
]

export const CELLS: CorpusSource[] = [
  {
    title: 'Cell biology notes.docx',
    chunks: [
      {
        key: 'atp',
        locator: { heading: 'Mitochondria', paragraph: 4 },
        text: "Mitochondria produce most of the cell's ATP through oxidative phosphorylation on the inner membrane.",
      },
      {
        key: 'mtdna',
        locator: { heading: 'Mitochondria', paragraph: 6 },
        text: 'Mitochondrial DNA is inherited almost exclusively from the mother.',
      },
    ],
  },
]

export const SCRIPTS: Script[] = [
  {
    match: /agenc|who built|built webb|partner/i,
    rag: 'Webb is an international collaboration between NASA, the European Space Agency and the Canadian Space Agency.[[partners]]',
    baseline:
      'Webb was built by NASA together with the European Space Agency and the Canadian Space Agency, with Northrop Grumman as prime contractor.',
    findings: [
      {
        quote: 'with Northrop Grumman as prime contractor',
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'The indexed documents name the partner agencies but not the contractors.',
      },
    ],
  },
  {
    match: /launch/i,
    rag:
      'Webb launched on 25 December 2021 aboard an Ariane 5 rocket from Europe’s Spaceport in Kourou, French Guiana.[[launch]] ' +
      'About a month later, on 24 January 2022, it reached its operating position: a halo orbit around the Sun–Earth L2 point, roughly 1.5 million km from Earth.[[arrival]] ' +
      'There, a five-layer sunshield about the size of a tennis court keeps its 6.5 m gold-coated beryllium mirror and instruments cold.[[sunshield]]',
    baseline:
      'The James Webb Space Telescope launched on October 18, 2021, aboard a SpaceX Falcon Heavy from Cape Canaveral. ' +
      'After a month-long cruise it settled into an orbit around the Earth–Moon L2 point, about 450,000 km away. ' +
      'Its 6.5-metre primary mirror is made of 18 gold-coated beryllium segments, and engineers rehearsed the full unfolding sequence more than 300 times before launch. ' +
      'Its first frame sent home was reportedly a test image of a nearby star field that was never published. ' +
      'Webb is easily one of the most remarkable machines ever built.',
    findings: [
      {
        quote: 'October 18, 2021, aboard a SpaceX Falcon Heavy from Cape Canaveral',
        verdict: 'contradicted',
        reason_code: 'direct_contradiction',
        reason: 'The mission facts give a different date, rocket and launch site.',
        correction: 'Launched 25 December 2021 on an Ariane 5 from Europe’s Spaceport in Kourou, French Guiana.',
        evidence: [
          {
            key: 'launch',
            excerpt: "Webb launched on 25 December 2021 aboard an Ariane 5 rocket from Europe's Spaceport in Kourou, French Guiana.",
          },
        ],
      },
      {
        quote: 'an orbit around the Earth–Moon L2 point, about 450,000 km away',
        verdict: 'contradicted',
        reason_code: 'direct_contradiction',
        reason: 'Webb orbits the Sun–Earth L2 point, not an Earth–Moon one, and it is much farther away.',
        correction: 'A halo orbit around the Sun–Earth L2 point, roughly 1.5 million km from Earth.',
        evidence: [
          { key: 'arrival', excerpt: 'a halo orbit around the Sun–Earth L2 point, roughly 1.5 million km from Earth' },
        ],
      },
      {
        quote: 'engineers rehearsed the full unfolding sequence more than 300 times before launch',
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'Your documents don’t say how many times deployment was rehearsed.',
      },
      {
        quote: 'Its first frame sent home was reportedly a test image of a nearby star field that was never published.',
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'Nothing indexed describes Webb’s first frame.',
      },
    ],
  },
  {
    match: /\bL2\b|how far/i,
    rag:
      'Webb operates in a halo orbit around the Sun–Earth L2 point, roughly 1.5 million km from Earth.[[arrival]] ' +
      'L2 lies on the Sun–Earth line beyond Earth, so the Sun, Earth and Moon stay on one side of the telescope.[[geometry]] ' +
      'Because the point is unstable, Webb makes small station-keeping manoeuvres about every three weeks.[[stationkeeping]]',
    baseline:
      'L2 is about 1.5 million kilometres from Earth, roughly four times farther than the Moon. ' +
      'Webb sits exactly at the L2 point, where the gravity of the Sun and Earth cancel out completely, so it needs no fuel to stay there.',
    findings: [
      {
        quote: 'roughly four times farther than the Moon',
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'The sources give the distance to L2 but never compare it with the Moon.',
      },
      {
        quote: 'Webb sits exactly at the L2 point',
        verdict: 'contradicted',
        reason_code: 'direct_contradiction',
        reason: 'Webb circles L2 in a halo orbit rather than sitting on the point.',
        correction: 'Webb travels in a halo orbit around L2.',
        evidence: [{ key: 'arrival', excerpt: 'a halo orbit around the Sun–Earth L2 point' }],
      },
      {
        quote: 'where the gravity of the Sun and Earth cancel out completely',
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'The indexed primer doesn’t describe the balance of forces at L2.',
      },
      {
        quote: 'so it needs no fuel to stay there',
        verdict: 'contradicted',
        reason_code: 'direct_contradiction',
        reason: 'The primer says L2 is unstable and Webb has to correct its orbit.',
        correction: 'Webb fires its thrusters for station-keeping about every three weeks.',
        evidence: [
          {
            key: 'stationkeeping',
            excerpt: 'Webb fires its thrusters for small station-keeping manoeuvres about every three weeks',
          },
        ],
      },
    ],
  },
  {
    match: /mirror|cold|sunshield|temperature/i,
    rag:
      'A five-layer sunshield about the size of a tennis court keeps the 6.5 m gold-coated beryllium primary mirror and instruments cold, below about 50 K.[[sunshield]] ' +
      'The mirror itself is made of 18 hexagonal gold-coated beryllium segments.[[segments]]',
    baseline:
      'Webb’s mirror is kept cold by a large sunshield and an onboard cryocooler that chills the whole telescope to around 7 K. ' +
      'The sunshield has five layers of Kapton, each thinner than a human hair, and it blocks sunlight so the mirror stays below 50 K.',
    findings: [
      {
        quote: 'an onboard cryocooler that chills the whole telescope to around 7 K',
        verdict: 'unverifiable',
        reason_code: 'insufficient_evidence',
        reason: 'The sources credit the sunshield with keeping the mirror below about 50 K and don’t mention a cryocooler.',
        correction: 'The sunshield keeps the mirror and instruments below about 50 K.',
      },
      {
        quote: 'each thinner than a human hair',
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'Layer thickness isn’t in your documents.',
      },
    ],
  },
  {
    match: /ai act|\beu\b/i,
    rag:
      'The AI Act entered into force on 1 August 2024.[[entry]] ' +
      'Prohibitions on unacceptable-risk practices have applied since 2 February 2025.[[prohibitions]] ' +
      'Obligations for general-purpose AI models followed on 2 August 2025.[[gpai]] ' +
      'Most remaining provisions, including high-risk rules for Annex III systems, apply from 2 August 2026.[[highrisk]]',
    baseline:
      'The EU AI Act entered into force in August 2024. Bans on prohibited practices started in February 2025, and rules for general-purpose AI models followed in August 2025. ' +
      'High-risk obligations apply from August 2027 for all systems. ' +
      'Fines can reach 7% of global turnover, and national regulators were all appointed by early 2025. ' +
      'Member states can also delay enforcement locally.',
    findings: [
      {
        quote: 'High-risk obligations apply from August 2027 for all systems.',
        verdict: 'contradicted',
        reason_code: 'direct_contradiction',
        reason: 'The summary dates most high-risk rules, including Annex III, to August 2026.',
        correction: 'Most high-risk rules, including those for Annex III systems, apply from 2 August 2026.',
        evidence: [
          {
            key: 'highrisk',
            excerpt: 'Most remaining provisions, including high-risk rules for Annex III systems, apply from 2 August 2026.',
          },
        ],
      },
      {
        quote: 'Fines can reach 7% of global turnover',
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'Penalties aren’t covered by the indexed summary.',
      },
      {
        quote: 'national regulators were all appointed by early 2025',
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'The summary doesn’t mention national regulators.',
      },
      {
        quote: 'Member states can also delay enforcement locally.',
        verdict: 'unverifiable',
        reason_code: 'outside_indexed_scope',
        reason: 'Nothing indexed addresses member-state discretion.',
      },
    ],
  },
  {
    match: /pric|plan|trial|copy/i,
    rag:
      'The brief prices Starter at $12 per seat per month billed annually and Team at $24 per seat per month.[[plans]] ' +
      'Every plan includes a 14-day free trial with no credit card required.[[trial]]',
    baseline:
      'The copy reads well: Starter at $12 per seat and Team at $24 per seat, each with a 14-day free trial. ' +
      'It is also worth mentioning that enterprise customers get a dedicated success manager.',
    findings: [
      {
        quote: 'enterprise customers get a dedicated success manager',
        verdict: 'unverifiable',
        reason_code: 'no_evidence_found',
        reason: 'The brief has no enterprise plan or success manager.',
      },
    ],
  },
  {
    match: /mitochond/i,
    rag:
      "Mitochondria produce most of the cell's ATP through oxidative phosphorylation on the inner membrane.[[atp]] " +
      'Their DNA is inherited almost exclusively from the mother.[[mtdna]]',
    baseline:
      'Mitochondria are the powerhouse of the cell, producing ATP on their outer membrane. ' +
      'They carry their own DNA, which is inherited equally from both parents.',
    findings: [
      {
        quote: 'producing ATP on their outer membrane',
        verdict: 'contradicted',
        reason_code: 'direct_contradiction',
        reason: 'The notes place ATP production on the inner membrane.',
        correction: 'ATP is made by oxidative phosphorylation on the inner membrane.',
        evidence: [{ key: 'atp', excerpt: 'oxidative phosphorylation on the inner membrane' }],
      },
      {
        quote: 'inherited equally from both parents',
        verdict: 'contradicted',
        reason_code: 'direct_contradiction',
        reason: 'The notes say mitochondrial DNA comes almost entirely from the mother.',
        correction: 'Mitochondrial DNA is inherited almost exclusively from the mother.',
        evidence: [{ key: 'mtdna', excerpt: 'Mitochondrial DNA is inherited almost exclusively from the mother.' }],
      },
    ],
  },
]

/** Seeded sessions for the demo account, in the style of the product screenshots. */
export const SEED = [
  {
    title: 'Mitochondria explainer',
    daysAgo: 9,
    corpus: CELLS,
    questions: ['Explain what mitochondria do and where their DNA comes from.'],
  },
  {
    title: 'Pricing page copy review',
    daysAgo: 3,
    corpus: PRICING,
    questions: ['Does this pricing copy match the brief?'],
  },
  {
    title: 'EU AI Act timelines',
    daysAgo: 1,
    corpus: AI_ACT,
    questions: ['When do the EU AI Act obligations take effect?'],
  },
  {
    title: 'Webb telescope launch',
    daysAgo: 0,
    corpus: WEBB,
    questions: [
      'Which space agencies built Webb?',
      'When and how did the James Webb Space Telescope launch, and where does it operate today?',
    ],
  },
]

export const DEMO_EMAIL = 'demo@example.com'
export const DEMO_PASSWORD = 'correct horse battery staple'
