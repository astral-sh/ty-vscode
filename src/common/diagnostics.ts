// `anser` uses TypeScript's `export =` syntax.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Anser = require("anser");
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

interface AnsiStyle {
  readonly foreground: string | null;
  readonly background: string | null;
  readonly foregroundTruecolor: string | null;
  readonly backgroundTruecolor: string | null;
  readonly decorations: readonly Anser.DecorationName[];
}

export class FullDiagnosticProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly contents = new Map<string, string>();
  private readonly targetsBySource = new Map<string, Set<string>>();
  private readonly pendingDiagnostics = new Map<string, Map<string, PreparedDiagnostics>>();
  private readonly decorationTypes = new Map<string, vscode.TextEditorDecorationType>();
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
    return Anser.ansiToText(this.contents.get(uri.toString()) ?? MISSING_DIAGNOSTIC);
  }

  applyDecorations(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== FULL_DIAGNOSTIC_URI_SCHEME) {
      return;
    }

    const rangesByDecoration = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
    for (const decorationType of this.decorationTypes.values()) {
      rangesByDecoration.set(decorationType, []);
    }

    const rendered = this.contents.get(editor.document.uri.toString()) ?? "";
    let line = 0;
    let character = 0;

    for (const span of Anser.ansiToJson(rendered, { use_classes: true })) {
      const style: AnsiStyle = {
        foreground: span.fg,
        background: span.bg,
        foregroundTruecolor: span.fg_truecolor,
        backgroundTruecolor: span.bg_truecolor,
        decorations: span.decorations,
      };
      const decorationType = this.decorationType(style);
      const segments = span.content.split("\n");

      for (const [index, segment] of segments.entries()) {
        if (segment.length > 0 && decorationType != null) {
          let ranges = rangesByDecoration.get(decorationType);
          if (ranges == null) {
            ranges = [];
            rangesByDecoration.set(decorationType, ranges);
          }
          ranges.push(new vscode.Range(line, character, line, character + segment.length));
        }

        if (index < segments.length - 1) {
          line += 1;
          character = 0;
        } else {
          character += segment.length;
        }
      }
    }

    for (const [decorationType, ranges] of rangesByDecoration) {
      editor.setDecorations(decorationType, ranges);
    }
  }

  private decorationType(style: AnsiStyle): vscode.TextEditorDecorationType | undefined {
    const foreground = FullDiagnosticProvider.toEditorColor(
      style.foreground,
      style.foregroundTruecolor,
    );
    const background = FullDiagnosticProvider.toEditorColor(
      style.background,
      style.backgroundTruecolor,
    );
    const bold = style.decorations.includes("bold");
    const italic = style.decorations.includes("italic");
    const underline = style.decorations.includes("underline");

    if (foreground == null && background == null && !bold && !italic && !underline) {
      return undefined;
    }

    const key = JSON.stringify(style);
    let decorationType = this.decorationTypes.get(key);
    if (decorationType == null) {
      decorationType = vscode.window.createTextEditorDecorationType({
        color: foreground,
        backgroundColor: background,
        fontWeight: bold ? "bold" : undefined,
        fontStyle: italic ? "italic" : undefined,
        textDecoration: underline ? "underline" : undefined,
      });
      this.decorationTypes.set(key, decorationType);
    }

    return decorationType;
  }

  private static toEditorColor(
    color: string | null,
    truecolor: string | null,
  ): vscode.ThemeColor | string | undefined {
    if (color == null) {
      return undefined;
    }

    if (color === "ansi-truecolor") {
      return truecolor == null ? undefined : `rgb(${truecolor})`;
    }

    const paletteColor = /^ansi-palette-(\d+)$/.exec(color)?.[1];
    if (paletteColor != null) {
      const rgb = Anser.ansiToJson(`\x1b[38;5;${paletteColor}m`)[1]?.fg;
      return rgb == null ? undefined : `rgb(${rgb})`;
    }

    const themeColor = ANSI_THEME_COLORS[color];
    return themeColor == null ? undefined : new vscode.ThemeColor(themeColor);
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
    for (const decorationType of this.decorationTypes.values()) {
      decorationType.dispose();
    }
    this.decorationTypes.clear();
  }
}

const ANSI_THEME_COLORS: Readonly<Record<string, string>> = {
  "ansi-black": "terminal.ansiBlack",
  "ansi-red": "terminal.ansiRed",
  "ansi-green": "terminal.ansiGreen",
  "ansi-yellow": "terminal.ansiYellow",
  "ansi-blue": "terminal.ansiBlue",
  "ansi-magenta": "terminal.ansiMagenta",
  "ansi-cyan": "terminal.ansiCyan",
  "ansi-white": "terminal.ansiWhite",
  "ansi-bright-black": "terminal.ansiBrightBlack",
  "ansi-bright-red": "terminal.ansiBrightRed",
  "ansi-bright-green": "terminal.ansiBrightGreen",
  "ansi-bright-yellow": "terminal.ansiBrightYellow",
  "ansi-bright-blue": "terminal.ansiBrightBlue",
  "ansi-bright-magenta": "terminal.ansiBrightMagenta",
  "ansi-bright-cyan": "terminal.ansiBrightCyan",
  "ansi-bright-white": "terminal.ansiBrightWhite",
};

function matchesPreparedDiagnostics(
  linkedDiagnostics: Map<string, string | undefined>,
  prepared: PreparedDiagnostics,
): boolean {
  return (
    linkedDiagnostics.size === prepared.targets.size &&
    [...prepared.targets].every(([target]) => linkedDiagnostics.get(target) === prepared.reportId)
  );
}
