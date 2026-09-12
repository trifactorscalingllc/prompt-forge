'use strict';
// What the prompt is FOR. Independent of which account runs the engine: a Claude subscription can
// polish a prompt for GPT-5. Each family has a style guide beside this file, read per call so an
// edit to a guide is live without a reload.
const fs = require('node:fs');
const path = require('node:path');

const TARGETS = [
  { id: 'fable-5.1', label: 'Claude Fable 5.1', family: 'claude', blurb: 'XML-tagged sections, literal instructions, examples in tags. Outcomes and limits, not step lists.' },
  { id: 'opus-5', label: 'Claude Opus 5', family: 'claude', blurb: 'XML-tagged like Fable. Opus follows detail closely, so quantities and formats are spelled out.' },
  { id: 'sonnet-5', label: 'Claude Sonnet 5', family: 'claude', blurb: 'XML-tagged sections with short literal lines and a precise output-format block.' },
  { id: 'haiku-4.5', label: 'Claude Haiku 4.5', family: 'claude', blurb: 'XML-tagged sections kept short; simple explicit lines, nuance trimmed.' },
  { id: 'gemini-pro', label: 'Gemini Pro', family: 'gemini', blurb: 'A framing paragraph, markdown headings, numbered rules, an explicit output schema, fenced examples.' },
  { id: 'gemini-flash', label: 'Gemini Flash', family: 'gemini', blurb: 'Same layout as Pro, tighter: fewer, sharper rules and one clear example.' },
  { id: 'gpt-5', label: 'GPT-5', family: 'gpt', blurb: 'Developer-message layout: markdown headings, numbered testable rules, success criteria, exact output spec.' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', family: 'gpt', blurb: 'Same layout as GPT-5 with shorter sections and one worked example.' },
];
const FAMILIES = ['claude', 'gemini', 'gpt'];

// Polish renames the sections, and the next merge then reads a document whose headings no longer
// match the canonical list. That round trip is the normal loop, so the mapping cannot be left for
// the engine to infer -- it is written down once, here, and both prompts are given it.
// Every value must be the heading exactly as the family's style guide tells polish to write it.
const SECTION_NAMES = {
  claude: { Goal: '<goal>', Context: '<context>', Requirements: '<requirements>', Constraints: '<constraints>', 'Output format': '<output_format>', Examples: '<examples>', 'Open questions': '<open_questions>' },
  gemini: { Goal: '## Goal', Context: '## Context', Requirements: '## Requirements', Constraints: '## Constraints', 'Output format': '## Output format', Examples: '## Examples', 'Open questions': '## Open questions' },
  gpt: { Goal: '# Task', Context: '# Context', Requirements: '# Requirements', Constraints: '# Constraints', 'Output format': '# Output format', Examples: '# Examples', 'Open questions': '# Open questions' },
};

/** [{ canonical, name }] for a family: what each canonical section is called once polished. */
function sectionsFor(family) {
  const map = SECTION_NAMES[FAMILIES.includes(family) ? family : 'claude'];
  return Object.entries(map).map(([canonical, name]) => ({ canonical, name }));
}
const DEFAULT_TARGET = 'fable-5.1';

const find = (id) => TARGETS.find((t) => t.id === id) || null;

function familyOf(id, fallback = 'claude') {
  const t = find(id);
  if (t) return t.family;
  return FAMILIES.includes(fallback) ? fallback : 'claude';
}

function labelOf(id) {
  const t = find(id);
  return t ? t.label : String(id || '');
}

/** {id, label, family} for a known or custom id. */
function resolve(id, family) {
  const t = find(id);
  if (t) return { ...t };
  return { id: String(id || ''), label: String(id || ''), family: familyOf(id, family) };
}

function styleGuide(family) {
  const f = FAMILIES.includes(family) ? family : 'claude';
  return fs.readFileSync(path.join(__dirname, `${f}.md`), 'utf8');
}

module.exports = { TARGETS, FAMILIES, DEFAULT_TARGET, SECTION_NAMES, familyOf, labelOf, resolve, sectionsFor, styleGuide };
