import * as vscode from "vscode";

export const FULL_DIAGNOSTIC_URI_SCHEME = "ty-diagnostics-view";

const MISSING_DIAGNOSTIC = "Unable to find original ty diagnostic";
// vscode-languageclient preserves `Diagnostic.data` in its diagnostic collection. Tag prepared
// reports so reconciliation can distinguish different reports that use the same index-based URI.
const REPORT_ID_KEY = "__ty_full_diagnostic_report_id";

interface PreparedDiagnostics {
  readonly reportId: string;
  readonly sourceKey: string;
  readonly targets: Map<string, { uri: vscode.Uri; content: string }>;
}

export class FullDiagnosticProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly contents = new Map<string, string>();
  private readonly targetsBySource = new Map<string, Set<string>>();
  private readonly pendingDiagnostics = new Map<string, Map<string, PreparedDiagnostics>>();
  private reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
  private nextReportId = 0;
  private disposed = false;
  private readonly diagnosticsListener = vscode.languages.onDidChangeDiagnostics(({ uris }) => {
    this.reconcileDiagnostics(uris);
  });

  get onDidChange(): vscode.Event<vscode.Uri> {
    return this.onDidChangeEmitter.event;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? MISSING_DIAGNOSTIC;
  }

  updateDiagnostics(sourceUri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void {
    this.commitDiagnostics(this.prepareDiagnostics(sourceUri, diagnostics, "document"));
  }

  prepareDocumentDiagnostics(sourceUri: vscode.Uri, diagnostics: vscode.Diagnostic[]): () => void {
    return this.preparePulledDiagnostics(sourceUri, diagnostics, "document");
  }

  prepareWorkspaceDiagnostics(sourceUri: vscode.Uri, diagnostics: vscode.Diagnostic[]): () => void {
    return this.preparePulledDiagnostics(sourceUri, diagnostics, "workspace");
  }

  private preparePulledDiagnostics(
    sourceUri: vscode.Uri,
    diagnostics: vscode.Diagnostic[],
    origin: "document" | "workspace",
  ): () => void {
    const prepared = this.prepareDiagnostics(sourceUri, diagnostics, origin);
    return () => {
      let pendingForSource = this.pendingDiagnostics.get(prepared.sourceKey);
      if (pendingForSource == null) {
        pendingForSource = new Map();
        this.pendingDiagnostics.set(prepared.sourceKey, pendingForSource);
      }
      pendingForSource.set(prepared.reportId, prepared);

      // Pull middleware runs before vscode-languageclient decides whether to install the report.
      // Reconcile on the next task so a discarded report never mutates the committed cache. A
      // workspace report can activate thousands of files at once, so coalesce all pending sources
      // behind one timer and one read of VS Code's diagnostic collection.
      this.scheduleReconciliation();
    };
  }

  private scheduleReconciliation(): void {
    if (this.reconciliationTimer != null) {
      return;
    }

    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = undefined;
      if (this.disposed || this.pendingDiagnostics.size === 0) {
        return;
      }

      const sourceUris = [...this.pendingDiagnostics.keys()].map((source) =>
        vscode.Uri.parse(source),
      );
      this.reconcileDiagnostics(sourceUris, true);
    }, 0);
  }

  private reconcileDiagnostics(sourceUris: readonly vscode.Uri[], discardPending = false): void {
    const linkedDiagnostics = this.linkedDiagnostics(sourceUris);

    for (const sourceUri of sourceUris) {
      this.reconcileSourceDiagnostics(
        sourceUri,
        linkedDiagnostics.get(sourceUri.toString()) ?? new Map(),
        discardPending,
      );
    }
  }

  private reconcileSourceDiagnostics(
    sourceUri: vscode.Uri,
    linkedDiagnostics: Map<string, string | undefined>,
    discardPending: boolean,
  ): void {
    const sourceKey = sourceUri.toString();
    const pendingForSource = this.pendingDiagnostics.get(sourceKey);

    if (pendingForSource != null) {
      for (const prepared of pendingForSource.values()) {
        if (matchesPreparedDiagnostics(linkedDiagnostics, prepared)) {
          this.pendingDiagnostics.delete(sourceKey);
          this.commitDiagnostics(prepared);
          return;
        }
      }

      if (discardPending) {
        this.pendingDiagnostics.delete(sourceKey);
      }
    }

    if (linkedDiagnostics.size === 0 && !this.pendingDiagnostics.has(sourceKey)) {
      this.deleteSource(sourceUri);
    }
  }

  private prepareDiagnostics(
    sourceUri: vscode.Uri,
    diagnostics: vscode.Diagnostic[],
    origin: "document" | "workspace",
  ): PreparedDiagnostics {
    const reportId = this.nextReportId.toString();
    this.nextReportId += 1;
    const sourceKey = sourceUri.toString();
    const targets = new Map<string, { uri: vscode.Uri; content: string }>();

    diagnostics.forEach((diagnostic, index) => {
      const data = (diagnostic as unknown as { data?: Record<string, unknown> }).data;
      if (data == null || typeof data.rendered !== "string") {
        return;
      }
      const rendered = data.rendered;
      data[REPORT_ID_KEY] = reportId;

      // This mirrors rust-analyzer's index-based URI scheme. Diagnostic indexes are not stable,
      // so an open document can briefly show stale content while diagnostics are recomputed. In
      // practice, this is acceptable because `updateDiagnostics` refreshes it with the next report.
      const target = vscode.Uri.from({
        scheme: FULL_DIAGNOSTIC_URI_SCHEME,
        path: `/${origin}/diagnostic message [${index.toString()}]`,
        fragment: sourceKey,
        query: index.toString(),
      });
      const targetKey = target.toString();
      const originalCode = diagnostic.code;
      const documentationUri =
        typeof originalCode === "object" &&
        originalCode.target.scheme !== FULL_DIAGNOSTIC_URI_SCHEME
          ? originalCode.target
          : undefined;
      const content = documentationUri
        ? `${rendered}${rendered.endsWith("\n") ? "\n" : "\n\n"}Documentation: ${documentationUri.toString()}\n`
        : rendered;

      targets.set(targetKey, { uri: target, content });

      diagnostic.code = {
        target,
        value: "Click for full diagnostic",
      };
    });

    return { reportId, sourceKey, targets };
  }

  private commitDiagnostics(prepared: PreparedDiagnostics): void {
    const { sourceKey, targets } = prepared;
    const previousTargets = this.targetsBySource.get(sourceKey) ?? new Set<string>();
    const currentTargets = new Set(targets.keys());

    for (const [targetKey, { uri, content }] of targets) {
      if (this.contents.get(targetKey) !== content) {
        this.contents.set(targetKey, content);
        this.onDidChangeEmitter.fire(uri);
      }
    }

    for (const previousTarget of previousTargets) {
      if (!currentTargets.has(previousTarget)) {
        this.contents.delete(previousTarget);
        this.onDidChangeEmitter.fire(vscode.Uri.parse(previousTarget));
      }
    }

    if (currentTargets.size > 0) {
      this.targetsBySource.set(sourceKey, currentTargets);
    } else {
      this.targetsBySource.delete(sourceKey);
    }
  }

  private linkedDiagnostics(
    sourceUris: readonly vscode.Uri[],
  ): Map<string, Map<string, string | undefined>> {
    const diagnosticsBySource = new Map(
      sourceUris.map((sourceUri) => [sourceUri.toString(), new Map<string, string | undefined>()]),
    );

    for (const [sourceUri, diagnostics] of vscode.languages.getDiagnostics()) {
      const linkedDiagnostics = diagnosticsBySource.get(sourceUri.toString());
      if (linkedDiagnostics == null) {
        continue;
      }

      for (const diagnostic of diagnostics) {
        if (
          diagnostic.code != null &&
          typeof diagnostic.code === "object" &&
          diagnostic.code.target.scheme === FULL_DIAGNOSTIC_URI_SCHEME
        ) {
          const reportId = (diagnostic as unknown as { data?: Record<string, unknown> }).data?.[
            REPORT_ID_KEY
          ];
          linkedDiagnostics.set(
            diagnostic.code.target.toString(),
            typeof reportId === "string" ? reportId : undefined,
          );
        }
      }
    }

    return diagnosticsBySource;
  }

  private deleteSource(sourceUri: vscode.Uri): void {
    const sourceKey = sourceUri.toString();
    this.pendingDiagnostics.delete(sourceKey);
    const targets = this.targetsBySource.get(sourceKey);
    if (targets == null) {
      return;
    }

    this.targetsBySource.delete(sourceKey);
    for (const target of targets) {
      this.contents.delete(target);
      this.onDidChangeEmitter.fire(vscode.Uri.parse(target));
    }
  }

  clear(): void {
    if (this.reconciliationTimer != null) {
      clearTimeout(this.reconciliationTimer);
      this.reconciliationTimer = undefined;
    }

    const targets = [...this.contents.keys()];
    this.contents.clear();
    this.targetsBySource.clear();
    this.pendingDiagnostics.clear();
    for (const target of targets) {
      this.onDidChangeEmitter.fire(vscode.Uri.parse(target));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.diagnosticsListener.dispose();
    this.clear();
    this.onDidChangeEmitter.dispose();
  }
}

function matchesPreparedDiagnostics(
  linkedDiagnostics: Map<string, string | undefined>,
  prepared: PreparedDiagnostics,
): boolean {
  return (
    linkedDiagnostics.size === prepared.targets.size &&
    [...prepared.targets].every(([target]) => linkedDiagnostics.get(target) === prepared.reportId)
  );
}
