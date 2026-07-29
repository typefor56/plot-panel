import type * as vscode from 'vscode';
import type { VariablesGrouping, VariablesSorting } from './categorize';

/**
 * How the Variables view organizes its rows: grouping (kind | size) and
 * sorting (name | size | recent). Toolbar toggles, not preferences, so they
 * persist in globalState like the plot display modes. Same tiny-emitter
 * pattern as displayOptions.ts; type-only vscode import keeps it testable
 * with a stub Memento.
 */

const GROUPING_KEY = 'plotPanel.variablesGrouping';
const SORTING_KEY = 'plotPanel.variablesSorting';

const GROUPINGS: readonly VariablesGrouping[] = ['kind', 'size'];
const SORTINGS: readonly VariablesSorting[] = ['name', 'size', 'recent'];

function isGrouping(value: unknown): value is VariablesGrouping {
  return typeof value === 'string' && (GROUPINGS as readonly string[]).includes(value);
}

function isSorting(value: unknown): value is VariablesSorting {
  return typeof value === 'string' && (SORTINGS as readonly string[]).includes(value);
}

export class VariablesOptions {
  private currentGrouping: VariablesGrouping;
  private currentSorting: VariablesSorting;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly memento: vscode.Memento) {
    const storedGrouping: unknown = memento.get(GROUPING_KEY);
    this.currentGrouping = isGrouping(storedGrouping) ? storedGrouping : 'kind';
    const storedSorting: unknown = memento.get(SORTING_KEY);
    this.currentSorting = isSorting(storedSorting) ? storedSorting : 'name';
  }

  get grouping(): VariablesGrouping {
    return this.currentGrouping;
  }

  setGrouping(grouping: VariablesGrouping): void {
    if (grouping === this.currentGrouping) {
      return;
    }
    this.currentGrouping = grouping;
    void this.memento.update(GROUPING_KEY, grouping);
    this.emit();
  }

  get sorting(): VariablesSorting {
    return this.currentSorting;
  }

  setSorting(sorting: VariablesSorting): void {
    if (sorting === this.currentSorting) {
      return;
    }
    this.currentSorting = sorting;
    void this.memento.update(SORTING_KEY, sorting);
    this.emit();
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
