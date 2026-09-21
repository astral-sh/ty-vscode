import * as path from "node:path";

export type TestOutcomeKind = "passed" | "failed" | "errored" | "skipped";

/** The outcome of a test, as pytest printed it. */
export interface TestOutcome {
  /** The test's node id, as printed: relative to the directory the run started in. */
  readonly id: string;
  readonly kind: TestOutcomeKind;
}

/** How a finished pytest process ended, and what it printed along the way. */
export interface PytestResult {
  /** Null when pytest never got to exit on its own. */
  readonly code: number | null;
  readonly output: PytestOutput;
}

// A node id, then the outcome. Requiring the `.py` of the file the test lives in
// is what keeps the underscore rules pytest draws around its failure sections
// from reading as outcomes of their own.
const OUTCOME_LINE = /^(.+?\.py(?:::.+?)?) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/;

const KINDS: Record<string, TestOutcomeKind | undefined> = {
  PASSED: "passed",
  FAILED: "failed",
  ERROR: "errored",
  SKIPPED: "skipped",
  // An expected failure isn't a failure, and there's nothing in the tree that
  // can say "expected", so it reads as a test that didn't really run.
  XFAIL: "skipped",
  XPASS: "passed",
};

/** Least to most serious, for a test pytest reported more than once. */
const SEVERITY: readonly TestOutcomeKind[] = ["passed", "skipped", "failed", "errored"];

/** Everything a pytest run printed, and the outcomes named in it. */
export class PytestOutput {
  /** Everything pytest wrote to stdout and stderr, in the order it arrived. */
  text = "";

  /**
   * Adds a piece of pytest's output and returns it with the `\r\n` line
   * endings the editor's test output pane expects.
   */
  append(chunk: string): string {
    const normalized = chunk.replace(/\r?\n/g, "\r\n");
    this.text += normalized;
    return normalized;
  }

  /** The outcome pytest printed for each test it ran. */
  get outcomes(): TestOutcome[] {
    const outcomes: TestOutcome[] = [];
    for (const line of this.text.split("\n")) {
      const match = OUTCOME_LINE.exec(line.trim());
      if (match == null) continue;

      const kind = KINDS[match[2]];
      if (kind !== undefined) {
        outcomes.push({ id: match[1], kind });
      }
    }
    return outcomes;
  }
}

/** Keeps the more serious of two outcomes reported for the same test. */
export function moreSevere(one: TestOutcomeKind, other: TestOutcomeKind): TestOutcomeKind {
  return SEVERITY.indexOf(other) > SEVERITY.indexOf(one) ? other : one;
}

/**
 * The two ids a printed node id can be looked up under in the tree: the test
 * exactly as pytest named it, and the function it was generated from.
 *
 * pytest prints the path part relative to the directory the run started in,
 * while the tree's ids hold absolute paths, so the path is resolved first. A
 * parametrized test is printed once per parameter set, as
 * `tests/test_a.py::test_b[1-2]`, while discovery reads the source without
 * running it and so reports only the function, which is what the second id
 * drops the bracketed part for.
 */
export function treeIds(workingDirectory: string, nodeId: string): readonly [string, string] {
  const separator = nodeId.indexOf("::");
  const file = path.resolve(
    workingDirectory,
    separator === -1 ? nodeId : nodeId.substring(0, separator),
  );
  const id = separator === -1 ? file : `${file}${nodeId.substring(separator)}`;

  // The parameters follow the last `::` segment, so anything before it, such as
  // a bracket in a directory name, is left alone.
  const lastSeparator = id.lastIndexOf("::");
  const bracket = lastSeparator === -1 ? -1 : id.indexOf("[", lastSeparator);
  const withoutParameters = bracket === -1 ? id : id.substring(0, bracket);

  return [normalizeId(id), normalizeId(withoutParameters)];
}

/**
 * Puts a test id in a form two ids can be compared in. Ids are built from
 * filesystem paths, which mix separators and differ in case on Windows.
 */
export function normalizeId(id: string): string {
  const separators = id.replace(/\\/g, "/");
  return process.platform === "win32" ? separators.toLowerCase() : separators;
}
