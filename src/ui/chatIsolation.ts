// Keeps Claude Code chat tabs pinned to the right in their own editor group,
// like Copilot Chat: files never open next to a Claude chat, and the chat
// stays on the right-hand side.
//
// After every tab/group change (debounced) the layout is normalised:
//   1. The Claude chat group is locked (VS Code then routes new editors elsewhere).
//   2. Any non-Claude tab inside a Claude group is moved to the main file group.
//   3. File groups that ended up to the RIGHT of the Claude group, or that VS
//      Code auto-created while the Claude chat was focused, are merged into the
//      main file group (the closest group left of Claude). Splits the user makes
//      from a file group are left alone.
//   4. If no file group exists to the left, the Claude group is moved right.
import * as vscode from 'vscode';

const CLAUDE_VIEW_TYPE = 'claudeVSCodePanel';
const AUTO_LOCK_KEY = `mainThreadWebview-${CLAUDE_VIEW_TYPE}`;
const FOCUS_GROUP_CMDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

export function isClaudeChatTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_VIEW_TYPE);
}

const isClaudeGroup = (g: vscode.TabGroup) => g.tabs.some(isClaudeChatTab);
const sortedGroups = () => [...vscode.window.tabGroups.all].sort((a, b) => a.viewColumn - b.viewColumn);

function enabled(): boolean {
  return vscode.workspace.getConfiguration('claudeReview').get<boolean>('isolateClaudeChat', true);
}

/** Re-open a tab's editor in another group. Returns false for tabs we cannot recreate. */
async function reopenIn(tab: vscode.Tab, column: vscode.ViewColumn): Promise<boolean> {
  const opts = { viewColumn: column, preview: tab.isPreview, preserveFocus: false };
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    await vscode.window.showTextDocument(input.uri, opts);
  } else if (input instanceof vscode.TabInputTextDiff) {
    await vscode.commands.executeCommand('vscode.diff', input.original, input.modified, tab.label, opts);
  } else if (input instanceof vscode.TabInputCustom) {
    await vscode.commands.executeCommand('vscode.openWith', input.uri, input.viewType, opts);
  } else if (input instanceof vscode.TabInputNotebook) {
    await vscode.window.showNotebookDocument(await vscode.workspace.openNotebookDocument(input.uri), opts);
  } else {
    return false;
  }
  return true;
}

export class ChatIsolation implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  /** Whether the Claude chat group was the active group before the latest change. */
  private claudeWasActive = false;
  /** Groups VS Code created while a Claude chat had focus (to be merged back). */
  private readonly autoCreated = new Set<vscode.TabGroup>();

  constructor() {
    this.claudeWasActive = isClaudeGroup(vscode.window.tabGroups.activeTabGroup);
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabGroups((e) => {
        for (const g of e.opened) {
          if (this.claudeWasActive && !this.busy) this.autoCreated.add(g);
        }
        // Track focus synchronously so a split the user makes from a file group is not
        // mistaken for a group VS Code created while the chat had focus.
        if (!e.opened.length) this.claudeWasActive = isClaudeGroup(vscode.window.tabGroups.activeTabGroup);
        this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeReview.isolateClaudeChat')) {
          void this.ensureAutoLockSetting();
          this.schedule();
        }
      }),
    );
    void this.ensureAutoLockSetting();
    this.schedule();
  }

  private schedule(): void {
    if (this.busy) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.normalise(), 120);
  }

  /** Add (or remove) the Claude chat view type in workbench.editor.autoLockGroups. */
  private async ensureAutoLockSetting(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('workbench.editor');
    // Only touch the user's own value: get() would return VS Code's merged
    // defaults, and writing those back would copy every default into settings.json.
    const userValue = cfg.inspect<Record<string, boolean>>('autoLockGroups')?.globalValue;
    const current = { ...(userValue ?? {}) };
    const want = enabled();
    if (!!current[AUTO_LOCK_KEY] === want) return;
    if (want) current[AUTO_LOCK_KEY] = true;
    else delete current[AUTO_LOCK_KEY];
    try {
      await cfg.update('autoLockGroups', Object.keys(current).length ? current : undefined, vscode.ConfigurationTarget.Global);
    } catch (e) {
      console.error('[claude-review] could not update workbench.editor.autoLockGroups', e);
    }
  }

  private async focusGroup(g: vscode.TabGroup): Promise<void> {
    const idx = sortedGroups().indexOf(g);
    if (idx >= 0 && idx < FOCUS_GROUP_CMDS.length) await vscode.commands.executeCommand(FOCUS_GROUP_CMDS[idx]);
  }

  /** Bring the user's focus back to the editor they were on (if it still exists). */
  private async restoreFocus(tab: vscode.Tab | undefined): Promise<void> {
    if (!tab) return;
    const g = vscode.window.tabGroups.all.find((x) => x.tabs.some((t) => t.label === tab.label && sameInput(t, tab)));
    if (!g) return;
    const t = g.tabs.find((x) => sameInput(x, tab));
    if (t && !isClaudeChatTab(t)) await reopenIn(t, g.viewColumn);
    else await this.focusGroup(g);
  }

  async normalise(): Promise<void> {
    if (!enabled() || this.busy) return;
    this.busy = true;
    try {
      // Forget groups that no longer exist.
      const alive = new Set(vscode.window.tabGroups.all);
      for (const g of [...this.autoCreated]) if (!alive.has(g)) this.autoCreated.delete(g);

      const claude = sortedGroups().filter(isClaudeGroup);
      if (!claude.length) return;
      const firstClaudeCol = Math.min(...claude.map((g) => g.viewColumn));
      const active = vscode.window.tabGroups.activeTabGroup;
      const focusedTab = active.activeTab;
      let changed = false;

      // 1. Lock Claude groups (lock acts on the active group).
      if (isClaudeGroup(active) && focusedTab && isClaudeChatTab(focusedTab)) {
        await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
      }

      const fileGroups = () => sortedGroups().filter((g) => !isClaudeGroup(g) && g.tabs.length);
      const mainGroup = () => {
        const left = fileGroups().filter((g) => g.viewColumn < firstClaudeColNow());
        // Prefer a group the user made (not auto-created), closest to the chat.
        return left.filter((g) => !this.autoCreated.has(g)).pop() ?? left.pop();
      };
      const firstClaudeColNow = () => Math.min(...sortedGroups().filter(isClaudeGroup).map((g) => g.viewColumn));

      // 4. No file group on the left but some on the right: move the Claude group(s) to the far right.
      if (!mainGroup() && fileGroups().some((g) => g.viewColumn > firstClaudeCol)) {
        for (const cg of sortedGroups().filter(isClaudeGroup)) {
          await this.focusGroup(cg);
          for (let i = 0; i < vscode.window.tabGroups.all.length; i++) {
            const last = sortedGroups()[sortedGroups().length - 1];
            if (isClaudeGroup(last)) break;
            await vscode.commands.executeCommand('workbench.action.moveActiveEditorGroupRight');
          }
        }
        // Groups that were right of Claude are now the user's file area: not "auto-created" any more
        // except the newest one, which can be merged below if there are several.
        changed = true;
      }

      // 2 + 3. Collect tabs that must move into the main group.
      const target = mainGroup();
      if (target) {
        const toMove: vscode.Tab[] = [];
        for (const g of sortedGroups()) {
          if (g === target) continue;
          if (isClaudeGroup(g)) {
            toMove.push(...g.tabs.filter((t) => !isClaudeChatTab(t)));
          } else if (g.viewColumn > firstClaudeColNow() || this.autoCreated.has(g)) {
            toMove.push(...g.tabs);
          }
        }
        for (const tab of toMove) {
          if (await reopenIn(tab, target.viewColumn)) {
            await vscode.window.tabGroups.close(tab, true);
            changed = true;
          }
        }
      }
      this.autoCreated.clear();
      if (changed) await this.restoreFocus(focusedTab && !isClaudeChatTab(focusedTab) ? focusedTab : undefined);
    } catch (e) {
      console.error('[claude-review] layout normalisation failed', e);
    } finally {
      this.claudeWasActive = isClaudeGroup(vscode.window.tabGroups.activeTabGroup);
      this.busy = false;
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

function sameInput(a: vscode.Tab, b: vscode.Tab): boolean {
  const x = a.input as { uri?: vscode.Uri; modified?: vscode.Uri; viewType?: string };
  const y = b.input as { uri?: vscode.Uri; modified?: vscode.Uri; viewType?: string };
  if (x?.uri && y?.uri) return x.uri.toString() === y.uri.toString();
  if (x?.modified && y?.modified) return x.modified.toString() === y.modified.toString();
  return a.label === b.label && x?.viewType === y?.viewType;
}
