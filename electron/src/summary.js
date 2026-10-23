// "What did the agent just do?": a one-line summary of an agent's last reply, read from its session log.
// Same rules as the macOS app (AgentLogs.swift); see docs/v1.5-features.md.
const { tailRecords } = require('./agents');

const MAX = 90;

/** Markdown reply → its first sentence, plain text, at most 90 characters. Empty if there's nothing to say. */
function summarize(text) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '');
  let lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  // Headings are labels ("## Summary"); skip them when there's anything else.
  const body = lines.filter((l) => !/^#{1,6}\s/.test(l));
  if (body.length) lines = body;
  lines = lines.map((l) => l.replace(/^(#{1,6}|>+)\s*/, '').replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  // A line break ends a sentence unless the line leads into the next one ("Here's what I did:").
  let s = lines.map((l, i) => (i < lines.length - 1 && !/[.!?:,;]$/.test(l) ? `${l}.` : l)).join(' ');
  if (!s) return '';
  const m = /^(.+?[.!?])(?=\s|$)/.exec(s);
  if (m) s = m[1];
  if (s.length > MAX) s = `${s.slice(0, MAX - 1).replace(/\s+\S*$/, '').replace(/[\s,;:]+$/, '') || s.slice(0, MAX - 1)}…`;
  return s;
}

/** The text of the newest assistant reply in a Claude Code transcript or a Codex rollout log. */
function lastAssistantText(file, isCodex) {
  if (!file) return '';
  const records = tailRecords(file, 512 * 1024);
  if (isCodex) {
    for (const r of records) {
      const p = r.payload || {};
      if (r.type === 'event_msg' && p.type === 'agent_message' && p.message) return String(p.message);
      if (r.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
        const text = (p.content || []).filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
        if (text.trim()) return text;
      }
    }
    return '';
  }
  // Claude Code writes each content block of a reply as its own record, sharing the message id.
  let id = null;
  const parts = [];
  for (const r of records) {
    if (r.type !== 'assistant' || !r.message) continue;
    const text = (Array.isArray(r.message.content) ? r.message.content : [])
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    if (id === null) {
      if (!text.trim()) continue;
      id = r.message.id || null;
      parts.push(text);
      if (!id) break;
    } else if (r.message.id === id) {
      if (text.trim()) parts.push(text);
    } else break;
  }
  return parts.reverse().join('\n');
}

/** Summary of a session's last reply, or ''. */
function sessionSummary(session) {
  try { return summarize(lastAssistantText(session.logPath, session.isCodex)); } catch (_) { return ''; }
}

module.exports = { summarize, lastAssistantText, sessionSummary };
