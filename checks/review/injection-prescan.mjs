// review.injection-prescan — deterministic pre-scan outside any LLM (Standard §7 item 23; FE §9.9; CORE-REV-03).
// Flags text aimed at the reviewer or an agent in added lines of changed files that are neither control files nor
// declared prompt assets (those are protected by code owner approval instead, item 25).
import { parseUnifiedDiff } from '../../lib/diff.mjs';
import { matchesAny } from '../../lib/glob.mjs';
import { checkResult } from '../../lib/result.mjs';

// Zero-width, word-joiner, BOM and bidirectional control characters.
const HIDDEN = /[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]/;
const INSTRUCTION = [
  /\bignore (?:all |any )?(?:the )?(?:previous|prior|above) (?:instructions|rules|prompts?)\b/i,
  /\b(?:ai|llm|automated) (?:reviewer|review|agent|assistant)\b\s*[:,-]/i,
  /\bpre-?approved\b/i,
  /\breport (?:no|zero) (?:issues|findings|problems)\b/i,
  /\bdo not (?:flag|report|mention) (?:this|these|any)\b/i,
  /\byou are now (?:a|an|the)\b/i,
  /\b(?:system|developer) prompt\b/i,
];
const ROLE_MARKER = /<\|im_(?:start|end)\|>|\[\/?INST\]|^\s*#{2,}\s*(?:System|Assistant|Human)\s*:|<\/?system>|^\s*(?:Human|Assistant)\s*:/;

export function injectionHits(diffText, exemptGlobs) {
  const hits = [];
  for (const file of parseUnifiedDiff(diffText)) {
    if (!file.newPath || matchesAny(file.newPath, exemptGlobs)) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== '+') continue;
        const loc = `${file.path}:${line.newLine}`;
        if (HIDDEN.test(line.text)) {
          const cp = line.text.match(HIDDEN)[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
          hits.push({ location: loc, message: `Hidden or bidirectional control character U+${cp}` });
        }
        const phrase = INSTRUCTION.find((re) => re.test(line.text));
        if (phrase) hits.push({ location: loc, message: `Text addressed to a reviewer or agent: "${line.text.trim().slice(0, 120)}"` });
        if (ROLE_MARKER.test(line.text)) hits.push({ location: loc, message: `Chat role marker: "${line.text.trim().slice(0, 120)}"` });
      }
    }
  }
  return hits;
}

export function injectionPrescanCheck(def, diffText, exemptGlobs) {
  const hits = injectionHits(diffText, exemptGlobs);
  return checkResult(def, {
    status: hits.length && def.enforcement === 'blocking' ? 'FAIL' : 'PASS',
    reason: hits.length ? `${hits.length} injection signal(s): a security finding only a human can dismiss` : undefined,
    findings: hits.map((h) => ({ source: 'security-review', ruleId: def.checkId, severity: 'BLOCKER', location: h.location, message: h.message, state: 'open' })),
  });
}
