// Audit log commands: integrity verification and export (JSONL or Markdown).
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { AuditEntry, readAuditFrom, verifyAuditLog } from '../shared/auditLog';
import { auditLogPath } from '../shared/paths';

export function verifyAuditLogCommand(root: string): void {
  const r = verifyAuditLog(root);
  if (r.ok) {
    void vscode.window.showInformationMessage(`Audit log OK: ${r.entries} entries, hash chain intact.`);
  } else {
    void vscode.window.showErrorMessage(
      `Audit log integrity FAILED at line ${r.badLine}: ${r.problem}. ${r.entries} entries verified before the problem.`,
      { modal: true, detail: auditLogPath(root) },
    );
  }
}

export async function exportAuditLog(root: string): Promise<void> {
  const fmt = await vscode.window.showQuickPick(
    [
      { label: 'Markdown report', description: 'Human-readable summary for change tickets', value: 'md' },
      { label: 'JSON Lines (raw, verifiable)', description: 'Exact copy of the hash-chained log', value: 'jsonl' },
    ],
    { title: 'Export audit log' },
  );
  if (!fmt) return;
  const scope = await vscode.window.showQuickPick(
    [
      { label: 'This workspace only', value: 'ws' },
      { label: 'Everything', value: 'all' },
    ],
    { title: 'Which entries?' },
  );
  if (!scope) return;
  const target = await vscode.window.showSaveDialog({
    filters: fmt.value === 'md' ? { Markdown: ['md'] } : { 'JSON Lines': ['jsonl'] },
    defaultUri: vscode.Uri.file(`claude-audit-${new Date().toISOString().slice(0, 10)}.${fmt.value}`),
  });
  if (!target) return;

  const { entries } = readAuditFrom(root, 0);
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath.toLowerCase());
  const inWs = (e: AuditEntry) =>
    scope.value === 'all' ||
    [e.cwd, ...(e.files ?? [])].some((p) => p && folders.some((f) => p.toLowerCase().startsWith(f)));
  const selected = entries.filter(inWs);

  if (fmt.value === 'jsonl') {
    if (scope.value === 'all') fs.copyFileSync(auditLogPath(root), target.fsPath);
    else fs.writeFileSync(target.fsPath, selected.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } else {
    fs.writeFileSync(target.fsPath, toMarkdown(selected, verifyAuditLog(root)));
  }
  void vscode.window.showInformationMessage(`Exported ${selected.length} audit entries to ${target.fsPath}`);
}

function toMarkdown(entries: AuditEntry[], v: ReturnType<typeof verifyAuditLog>): string {
  const lines: string[] = [];
  lines.push('# Claude Code activity report', '');
  lines.push(`Generated: ${new Date().toISOString()}  `);
  lines.push(`Audit chain: ${v.ok ? `verified (${v.entries} entries)` : `**FAILED** at line ${v.badLine}: ${v.problem}`}  `);
  lines.push(`Entries in this report: ${entries.length}`, '');
  const bySession = new Map<string, AuditEntry[]>();
  for (const e of entries) {
    const k = e.session ?? (e.src === 'extension' ? 'reviewer actions' : 'unknown');
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(e);
  }
  for (const [session, list] of bySession) {
    lines.push(`## Session ${session}`, '');
    const files = new Set(list.flatMap((e) => (e.event === 'PostToolUse' && e.after !== undefined ? e.files ?? [] : [])));
    const blocked = list.filter((e) => e.decision);
    lines.push(`- Time: ${list[0].ts} → ${list[list.length - 1].ts}`);
    lines.push(`- Files modified: ${files.size}`);
    lines.push(`- Blocked / confirmed tool calls: ${blocked.length}`, '');
    lines.push('| # | Time | Event | Tool | Detail |', '|---|---|---|---|---|');
    for (const e of list) {
      let detail = '';
      if (e.prompt) detail = `prompt: ${e.prompt.slice(0, 200)}`;
      else if (e.decision) detail = `**${e.decision.toUpperCase()}**: ${e.reason ?? ''}`;
      else if (e.files?.length) detail = e.files.join(', ');
      else if (e.tool === 'Bash' || e.tool === 'PowerShell') detail = String((e.input as { command?: string })?.command ?? '').slice(0, 200);
      else if (e.detail) detail = JSON.stringify(e.detail).slice(0, 200);
      lines.push(`| ${e.seq} | ${e.ts} | ${e.event} | ${e.tool ?? ''} | ${detail.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
