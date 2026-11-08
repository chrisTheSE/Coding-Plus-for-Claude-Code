// Status bar pie icon showing how much of the model's context window the
// current Claude Code session in this workspace has used. Hover for details.
// Data source: the local session transcript (read-only, no network).
import * as vscode from 'vscode';
import { claudeConfigDir } from '../capture/hookInstaller';
import { ContextUsage, contextWindowFor, newestTranscript, projectDirsFor, readUsage } from '../shared/transcript';

const PIE = ['○', '◔', '◑', '◕', '●'];

/** Pie glyph for a fraction 0..1 (quarter steps, rounded). */
export function pieGlyph(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  return PIE[Math.round(f * 4)];
}

function bar(fraction: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const fmt = (n: number) => n.toLocaleString('en-US');

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export class ContextMeter implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('claudeReview.contextMeter', vscode.StatusBarAlignment.Right, 1000);
  private timer: NodeJS.Timeout | undefined;
  private lastKey = '';
  private last: ContextUsage | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.item.name = 'Claude Context Usage';
    this.item.command = 'claudeReview.refreshContextMeter';
    this.disposables.push(
      this.item,
      vscode.commands.registerCommand('claudeReview.refreshContextMeter', () => this.refresh(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeReview.contextMeter')) this.refresh(true);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh(true)),
    );
    this.refresh(true);
    this.timer = setInterval(() => this.refresh(false), 3000);
  }

  private config() {
    const c = vscode.workspace.getConfiguration('claudeReview.contextMeter');
    return {
      enabled: c.get<boolean>('enabled', true),
      showPercent: c.get<boolean>('showPercent', false),
      windowOverride: c.get<number>('contextWindow', 0),
    };
  }

  refresh(force: boolean): void {
    const cfg = this.config();
    if (!cfg.enabled) {
      this.item.hide();
      return;
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    const dirs = folders.flatMap((f) => projectDirsFor(claudeConfigDir(), f.uri.fsPath));
    const newest = newestTranscript(dirs);
    if (!newest) {
      this.item.hide();
      return;
    }
    const key = `${newest.file}|${newest.mtimeMs}|${newest.size}`;
    if (force || key !== this.lastKey) {
      this.lastKey = key;
      this.last = readUsage(newest.file);
    }
    const u = this.last;
    if (!u) {
      this.item.hide();
      return;
    }
    const windowSize = contextWindowFor(u.model, u.tokens, cfg.windowOverride);
    const fraction = u.tokens / windowSize;
    const pct = Math.min(100, fraction * 100);
    const pctText = pct < 10 ? pct.toFixed(1) : pct.toFixed(0);

    this.item.text = cfg.showPercent ? `${pieGlyph(fraction)} ${pctText}%` : pieGlyph(fraction);
    this.item.backgroundColor =
      pct >= 90 ? new vscode.ThemeColor('statusBarItem.errorBackground') : pct >= 75 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.accessibilityInformation = { label: `Claude context ${pctText} percent used`, role: 'button' };

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Claude context: ${pctText}% used**\n\n`);
    md.appendMarkdown(`\`${bar(fraction)}\`\n\n`);
    md.appendMarkdown(`${fmt(u.tokens)} / ${fmt(windowSize)} tokens${cfg.windowOverride ? '' : ' (window estimated)'}\n\n`);
    md.appendMarkdown(`| | tokens |\n|---|---:|\n`);
    md.appendMarkdown(`| Cached (read) | ${fmt(u.cacheRead)} |\n| Cached (written) | ${fmt(u.cacheCreation)} |\n| New input | ${fmt(u.input)} |\n| Last output | ${fmt(u.output)} |\n\n`);
    md.appendMarkdown(`$(hubot) ${u.model || 'unknown model'} · session \`${u.sessionId.slice(0, 8)}\` · ${ago(u.at)}\n\n`);
    md.appendMarkdown(`_Latest session in this workspace, read from its local transcript. Click to refresh._`);
    this.item.tooltip = md;
    this.item.show();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
