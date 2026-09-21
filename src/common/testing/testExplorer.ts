import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { State } from "vscode-languageclient";
import type { LanguageClient } from "vscode-languageclient/node";
import { logger } from "../logger";
import { getInterpreterDetails } from "../python";
import {
  DiscoverTestsRequestType,
  ResolveTestRunParamsRequestType,
  type ResolveTestRunParamsResult,
  type TestItem as ServerTestItem,
  type TestItemKind as ServerTestItemKind,
} from "./protocol";
import {
  PytestOutput,
  moreSevere,
  normalizeId,
  treeIds,
  type PytestResult,
  type TestOutcome,
  type TestOutcomeKind,
} from "./pytestOutput";

const CONTROLLER_ID = "ty.tests";
const CONTROLLER_LABEL = "ty";
const RUN_PROFILE_LABEL = "Run Tests";

// pytest's own exit code for "the run collected zero tests".
const PYTEST_NO_TESTS_COLLECTED = 5;

/** A test item together with the server-reported kind it was built from. */
interface TrackedItem {
  readonly item: vscode.TestItem;
  readonly kind: ServerTestItemKind;
}

/**
 * Owns the VS Code test tree for `ty`: discovering tests from the language
 * server, keeping the tree in sync with file changes, and running tests as
 * pytest subprocesses.
 */
export class TestExplorer implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly getClient: () => LanguageClient | undefined;
  private readonly tracked = new Map<string, TrackedItem>();
  private readonly disposables: vscode.Disposable[] = [];
  private watcherDisposables: vscode.Disposable[] = [];

  // Discovery, pruning, and rename handling all mutate the shared tree
  // across `await` points. Chaining every mutation onto this promise instead
  // of letting them run concurrently keeps them from interleaving and
  // applying results out of order.
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(getClient: () => LanguageClient | undefined) {
    this.getClient = getClient;

    this.controller = vscode.tests.createTestController(CONTROLLER_ID, CONTROLLER_LABEL);
    this.controller.refreshHandler = () => this.discoverAll();
    this.controller.createRunProfile(
      RUN_PROFILE_LABEL,
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token),
      true,
    );

    this.createWatchers();

    this.disposables.push(
      this.controller,
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.createWatchers();
        void this.discoverAll();
      }),
      vscode.workspace.onDidRenameFiles((event) => void this.handleRenamedFiles(event)),
      vscode.workspace.onDidDeleteFiles((event) => this.handleDeletedFiles(event)),
    );

    logger.info("Test explorer: initialized controller, run profile, and file watchers");
  }

  dispose(): void {
    this.disposeWatchers();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Discovers the whole workspace and replaces the entire tree with the result. */
  discoverAll(): Promise<void> {
    return this.enqueueMutation(async () => {
      const client = this.getRunningClient();
      if (client === undefined) {
        logger.info("Test explorer: skipping discovery, the language server is not running");
        return;
      }

      const serverItems = await this.discoverTests(client);
      if (serverItems === undefined) return;

      this.tracked.clear();
      const roots = this.upsertItems(serverItems, client);
      this.controller.items.replace(roots);
    });
  }

  // Runs `mutation` after every mutation already queued has finished, and
  // keeps the queue going even if `mutation` throws, so a single failure
  // can't stall every later discovery or prune.
  private enqueueMutation(mutation: () => Promise<void>): Promise<void> {
    const scheduled = this.mutationQueue.then(mutation);
    this.mutationQueue = scheduled.catch((error) => {
      logger.error(`Test explorer mutation failed: ${error}`);
    });
    return scheduled;
  }

  private getRunningClient(): LanguageClient | undefined {
    const client = this.getClient();
    if (client === undefined || client.state !== State.Running) return undefined;
    return client;
  }

  private async discoverTests(
    client: LanguageClient,
    path?: string,
  ): Promise<ServerTestItem[] | undefined> {
    const scope = path ?? "the whole workspace";
    logger.info(`Test explorer: requesting ty/discoverTests for ${scope}`);
    try {
      const uri =
        path === undefined ? undefined : client.code2ProtocolConverter.asUri(vscode.Uri.file(path));
      const result = await client.sendRequest(DiscoverTestsRequestType, { uri });
      logger.info(
        `Test explorer: ty/discoverTests returned ${result.tests.length} items for ${scope}`,
      );
      return result.tests;
    } catch (error) {
      logger.error(`ty/discoverTests request failed: ${error}`);
      return undefined;
    }
  }

  /**
   * Builds or updates a `vscode.TestItem` for every item in `serverItems`,
   * then wires up parent/child relationships in a second pass so that
   * ordering in the response doesn't matter. Returns the items that have no
   * parent, leaving the caller to decide how to attach them.
   */
  private upsertItems(serverItems: ServerTestItem[], client: LanguageClient): vscode.TestItem[] {
    for (const serverItem of serverItems) {
      const existing = this.tracked.get(serverItem.id);
      if (existing !== undefined) {
        existing.item.label = serverItem.label;
        existing.item.range = client.protocol2CodeConverter.asRange(serverItem.range);
        continue;
      }
      this.tracked.set(serverItem.id, this.createTracked(serverItem, client));
    }

    const roots: vscode.TestItem[] = [];
    for (const serverItem of serverItems) {
      const entry = this.tracked.get(serverItem.id);
      if (entry === undefined) continue;

      // A parent nothing is known about is as good as no parent at all: this
      // item is as far up as the tree goes. The server names the project root
      // as the parent of the items directly inside it without describing the
      // root itself, so dropping these items would leave the tree empty.
      const parent =
        serverItem.parent === undefined ? undefined : this.tracked.get(serverItem.parent);
      if (parent === undefined) {
        roots.push(entry.item);
        continue;
      }
      parent.item.children.add(entry.item);
    }

    return roots;
  }

  private createTracked(serverItem: ServerTestItem, client: LanguageClient): TrackedItem {
    const uri =
      serverItem.uri === undefined
        ? vscode.Uri.file(serverItem.id)
        : client.protocol2CodeConverter.asUri(serverItem.uri);

    const item = this.controller.createTestItem(serverItem.id, serverItem.label, uri);
    item.range = client.protocol2CodeConverter.asRange(serverItem.range);
    return { item, kind: serverItem.kind };
  }

  /**
   * Replaces everything at or below `scopeId` with `serverItems`. Items
   * outside the scope, including ancestors included in the response for
   * context, are updated in place rather than being torn down and rebuilt.
   */
  private replaceScope(scopeId: string, serverItems: ServerTestItem[]): void {
    const client = this.getRunningClient();
    if (client === undefined) return;

    const formerParent = this.pruneWithin(scopeId);
    const roots = this.upsertItems(serverItems, client);
    for (const root of roots) {
      this.controller.items.add(root);
    }
    this.pruneEmptyAncestors(formerParent);
  }

  /**
   * Removes every tracked item at or below `scopeId` and returns what used
   * to be `scopeId`'s parent, so the caller can prune it if it's now empty.
   */
  private pruneWithin(scopeId: string): vscode.TestItem | undefined {
    const formerParent = this.tracked.get(scopeId)?.item.parent;
    for (const id of [...this.tracked.keys()]) {
      if (this.isWithinScope(id, scopeId)) {
        this.forget(id);
      }
    }
    return formerParent;
  }

  // Ids are built by appending `/` or `\` (directory to child) or `::` (file
  // to class/function) segments, so a simple prefix check also catches every
  // descendant transitively without walking the tree. Both slash styles are
  // accepted since ids come from filesystem paths, which use `\` on Windows.
  private isWithinScope(id: string, scopeId: string): boolean {
    return (
      id === scopeId ||
      id.startsWith(`${scopeId}/`) ||
      id.startsWith(`${scopeId}\\`) ||
      id.startsWith(`${scopeId}::`)
    );
  }

  private forget(id: string): void {
    const entry = this.tracked.get(id);
    if (entry === undefined) return;

    const parent = entry.item.parent;
    if (parent !== undefined) {
      parent.children.delete(id);
    } else {
      this.controller.items.delete(id);
    }
    this.tracked.delete(id);
  }

  private pruneEmptyAncestors(start: vscode.TestItem | undefined): void {
    let current = start;
    while (current !== undefined && current.children.size === 0) {
      const next = current.parent;
      this.forget(current.id);
      current = next;
    }
  }

  private createWatchers(): void {
    this.disposeWatchers();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      logger.info(`Test explorer: watching ${folder.uri.fsPath} for Python file changes`);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, "**/*.py"),
      );
      this.watcherDisposables.push(
        watcher,
        watcher.onDidCreate((uri) => {
          logger.info(`Test explorer: ${uri.fsPath} was created, discovering its tests`);
          void this.discoverPath(uri.fsPath);
        }),
        watcher.onDidChange((uri) => {
          logger.info(`Test explorer: ${uri.fsPath} changed, re-discovering its tests`);
          void this.discoverPath(uri.fsPath);
        }),
        // A folder being deleted or moved can surface as a single event for
        // the folder rather than one per file inside it, so this prunes by
        // path prefix rather than assuming `uri` is a file we're tracking.
        watcher.onDidDelete((uri) => {
          logger.info(`Test explorer: ${uri.fsPath} was deleted, pruning its tests`);
          void this.forgetPath(uri.fsPath);
        }),
      );
    }
  }

  private disposeWatchers(): void {
    for (const disposable of this.watcherDisposables) {
      disposable.dispose();
    }
    this.watcherDisposables = [];
  }

  private discoverPath(path: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const client = this.getRunningClient();
      if (client === undefined) {
        logger.info("Test explorer: skipping discovery, the language server is not running");
        return;
      }

      const serverItems = await this.discoverTests(client, path);
      if (serverItems === undefined) return;

      this.replaceScope(path, serverItems);
    });
  }

  private forgetPath(path: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const formerParent = this.pruneWithin(path);
      this.pruneEmptyAncestors(formerParent);
    });
  }

  // In-editor renames and deletes fire once per folder rather than once per
  // file, the same way the file system watcher does, so this reuses the
  // same path-prefix pruning.
  private async handleRenamedFiles(event: vscode.FileRenameEvent): Promise<void> {
    for (const { oldUri, newUri } of event.files) {
      logger.info(`Test explorer: ${oldUri.fsPath} was renamed to ${newUri.fsPath}`);
      void this.forgetPath(oldUri.fsPath);
    }
    await Promise.all(event.files.map(({ newUri }) => this.discoverPath(newUri.fsPath)));
  }

  private handleDeletedFiles(event: vscode.FileDeleteEvent): void {
    for (const uri of event.files) {
      logger.info(`Test explorer: ${uri.fsPath} was deleted in the editor, pruning its tests`);
      void this.forgetPath(uri.fsPath);
    }
  }

  private async runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const reporter = new RunReporter(
      this.controller.createTestRun(request),
      token,
      new Set((request.exclude ?? []).map((item) => item.id)),
      this.tracked,
    );

    const requested: vscode.TestItem[] = [];
    if (request.include !== undefined) {
      requested.push(...request.include);
    } else {
      this.controller.items.forEach((item) => requested.push(item));
    }

    try {
      for (const item of requested) {
        if (reporter.isExcluded(item)) continue;

        if (reporter.cancelled) {
          reporter.skipped(item);
          continue;
        }

        try {
          await this.runOne(item, reporter);
        } catch (error) {
          reporter.errored(item, `Unexpected error while running this test: ${error}`);
        }
      }
    } finally {
      reporter.end();
    }
  }

  private async runOne(item: vscode.TestItem, reporter: RunReporter): Promise<void> {
    const client = this.getRunningClient();
    if (client === undefined) {
      reporter.errored(item, "The ty language server is not running.");
      return;
    }

    logger.info(`Test explorer: requesting ty/resolveTestRunParams for ${item.id}`);
    let params: ResolveTestRunParamsResult | null;
    try {
      params = await client.sendRequest(ResolveTestRunParamsRequestType, { testId: item.id });
    } catch (error) {
      reporter.errored(item, `Failed to resolve how to run this test: ${error}`);
      return;
    }

    if (params == null) {
      logger.info(`Test explorer: ${item.id} is unknown or stale, re-discovering its file`);
      reporter.errored(item, "The test list is out of date. Re-discovering this file.");
      await this.discoverPath(this.fileScopeId(item.id));
      return;
    }

    logger.info(
      `Test explorer: resolved run params for ${item.id}: cwd=${params.workingDirectory}`,
    );

    let interpreter: string | undefined;
    try {
      interpreter = await this.interpreterFor(item);
    } catch (error) {
      // `getInterpreterDetails` throws when the Python extension isn't
      // installed at all, rather than reporting "no interpreter" the way
      // it does when the extension is present but unconfigured.
      reporter.errored(
        item,
        `Could not detect a Python interpreter: ${error}\n` +
          'Install the Python extension ("ms-python.python") to run tests.',
      );
      return;
    }

    if (interpreter === undefined) {
      reporter.errored(
        item,
        'No Python interpreter is configured. Use the "Python: Select Interpreter" command to pick one.',
      );
      return;
    }

    await this.executeTest(item, reporter, interpreter, params);
  }

  // Server-reported ids for classes and functions are the containing file's
  // id with `::`-joined qualified name segments appended, so the file scope
  // is everything before the first separator.
  private fileScopeId(id: string): string {
    const separator = id.indexOf("::");
    return separator === -1 ? id : id.substring(0, separator);
  }

  // The interpreter comes from the Python extension's active environment for
  // the item's workspace folder, so tests run with whatever the user picked
  // there rather than with an interpreter the language server chose.
  private async interpreterFor(item: vscode.TestItem): Promise<string | undefined> {
    const resource =
      item.uri !== undefined ? vscode.workspace.getWorkspaceFolder(item.uri) : undefined;
    const details = await getInterpreterDetails(resource);
    return details.path?.[0];
  }

  private async executeTest(
    item: vscode.TestItem,
    reporter: RunReporter,
    program: string,
    params: ResolveTestRunParamsResult,
  ): Promise<void> {
    reporter.started(item);

    const exit = await this.runPytest(item, reporter, program, params);

    if (reporter.cancelled) {
      logger.info(`Test explorer: run of ${item.id} was cancelled, pytest process killed`);
      reporter.skipped(item);
      return;
    }

    logger.info(`Test explorer: pytest exited with code ${exit.code} for ${item.id}`);

    // The exit code describes the run as a whole, so it goes on the item that
    // was run. What pytest printed for each test is applied second, so that a
    // test pytest named keeps its own outcome rather than the run-wide one.
    this.reportExit(item, reporter, exit);
    reporter.reportOutcomes(item, exit.output.outcomes, params.workingDirectory);
  }

  private async runPytest(
    item: vscode.TestItem,
    reporter: RunReporter,
    program: string,
    params: ResolveTestRunParamsResult,
  ): Promise<PytestResult> {
    logger.info(
      `Test explorer: running "${program} ${params.arguments.join(" ")}" in ${params.workingDirectory}`,
    );

    const output = new PytestOutput();
    const child = spawn(program, params.arguments, { cwd: params.workingDirectory });
    const cancelListeners = reporter.whenCancelled(() => child.kill());

    // Reading the streams as text rather than bytes leaves Node to hold on to a
    // multi-byte character split across two chunks until the rest of it arrives.
    const record = (chunk: string) => reporter.appendOutput(output.append(chunk), item);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", record);
    child.stderr.on("data", record);

    // Node doesn't emit `close` when the process fails to start at all (for
    // example an interpreter path that doesn't exist), only `error`, so both
    // need a listener or a bad interpreter path would hang the run forever.
    const exit = await new Promise<PytestResult>((resolve) => {
      child.on("error", (error) => {
        record(`Failed to start "${program}": ${error.message}\n`);
        resolve({ code: null, output });
      });
      child.on("close", (code) => resolve({ code, output }));
    });

    for (const listener of cancelListeners) {
      listener.dispose();
    }

    return exit;
  }

  // The exit code covers the run as a whole, so whatever it says lands on the
  // item that was run. Everything pytest printed goes with it, since a run that
  // ended badly is explained by its output rather than by a single test.
  private reportExit(item: vscode.TestItem, reporter: RunReporter, exit: PytestResult): void {
    switch (exit.code) {
      case 0:
        reporter.passed(item);
        break;
      case 1:
        // pytest's exit code for "at least one test failed". Which of them
        // failed is left to the outcomes pytest printed per test.
        reporter.failed(item, exit.output.text);
        break;
      case PYTEST_NO_TESTS_COLLECTED:
        reporter.skipped(item);
        break;
      case null:
        // The process closed with no exit code, and this isn't our own
        // cancellation (that case already returned above), so it was either
        // killed or never started.
        reporter.errored(item, `pytest did not finish.\n${exit.output.text}`);
        break;
      default:
        reporter.errored(item, `pytest exited with code ${exit.code}.\n${exit.output.text}`);
        break;
    }
  }
}

/**
 * Reports results into one run of the `Run Tests` profile.
 *
 * Nothing is ever reported for an item the request excluded, or for anything
 * nested under one, since they were left out of the run entirely.
 */
class RunReporter {
  constructor(
    private readonly run: vscode.TestRun,
    private readonly token: vscode.CancellationToken,
    private readonly excluded: ReadonlySet<string>,
    private readonly tracked: ReadonlyMap<string, TrackedItem>,
  ) {}

  /** True once the editor or the user has asked for the run to stop. */
  get cancelled(): boolean {
    return this.token.isCancellationRequested || this.run.token.isCancellationRequested;
  }

  isExcluded(item: vscode.TestItem): boolean {
    return this.excluded.has(item.id);
  }

  /** Calls `stop` if the run is cancelled, until the returned listeners are disposed. */
  whenCancelled(stop: () => void): vscode.Disposable[] {
    return [this.token.onCancellationRequested(stop), this.run.token.onCancellationRequested(stop)];
  }

  appendOutput(text: string, item: vscode.TestItem): void {
    this.run.appendOutput(text, undefined, item);
  }

  end(): void {
    this.run.end();
  }

  started(item: vscode.TestItem): void {
    this.reportRun(item, (target) => this.run.started(target));
  }

  passed(item: vscode.TestItem): void {
    this.reportRun(item, (target) => this.run.passed(target));
  }

  skipped(item: vscode.TestItem): void {
    this.reportRun(item, (target) => this.run.skipped(target));
  }

  failed(item: vscode.TestItem, message: string): void {
    if (this.isExcluded(item)) return;
    this.run.failed(item, new vscode.TestMessage(message));
  }

  errored(item: vscode.TestItem, message: string): void {
    if (this.isExcluded(item)) return;
    this.run.errored(item, new vscode.TestMessage(message));
  }

  /**
   * Gives each test pytest named an outcome of its own, which is what lets a run
   * of a whole directory, file, or class report a result for the tests inside it.
   *
   * A test can be reported more than once, either because it failed in more than
   * one phase or because it is parametrized, in which case discovery's single
   * item for the function takes the most serious outcome of the set.
   */
  reportOutcomes(
    item: vscode.TestItem,
    outcomes: readonly TestOutcome[],
    workingDirectory: string,
  ): void {
    const candidates = new Map<string, vscode.TestItem>();
    this.forEachIncluded(item, (candidate) => candidates.set(normalizeId(candidate.id), candidate));

    const results = new Map<vscode.TestItem, TestOutcomeKind>();
    for (const outcome of outcomes) {
      const [exact, withoutParameters] = treeIds(workingDirectory, outcome.id);
      const target = candidates.get(exact) ?? candidates.get(withoutParameters);
      if (target === undefined) {
        logger.info(`Test explorer: pytest reported ${outcome.id}, which is not in the tree`);
        continue;
      }

      const reported = results.get(target);
      results.set(
        target,
        reported === undefined ? outcome.kind : moreSevere(reported, outcome.kind),
      );
    }

    for (const [target, kind] of results) {
      switch (kind) {
        case "passed":
          this.run.passed(target);
          break;
        case "skipped":
          this.run.skipped(target);
          break;
        // The pytest output holds the traceback and is right there in the test
        // results, so there is nothing worth repeating on the test itself.
        case "failed":
          this.run.failed(target, []);
          break;
        case "errored":
          this.run.errored(target, []);
          break;
      }
    }
  }

  // Running a directory, file, or class covers every function nested inside it
  // in a single subprocess, so an outcome for the run as a whole applies to the
  // item itself and to each function-kind descendant, but not to the class and
  // file containers in between, which have no outcome of their own.
  private reportRun(item: vscode.TestItem, report: (target: vscode.TestItem) => void): void {
    this.forEachIncluded(item, (target) => {
      if (target === item || this.tracked.get(target.id)?.kind === "function") {
        report(target);
      }
    });
  }

  // Walks `item` and everything nested inside it, leaving out excluded items
  // along with the whole subtree under them.
  private forEachIncluded(item: vscode.TestItem, visit: (target: vscode.TestItem) => void): void {
    if (this.isExcluded(item)) return;

    visit(item);
    item.children.forEach((child) => this.forEachIncluded(child, visit));
  }
}
