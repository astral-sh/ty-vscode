import type { Range } from "vscode-languageclient";
import { RequestType } from "vscode-languageclient";

export type TestItemKind = "directory" | "file" | "class" | "function";

export interface TestItem {
  id: string;
  kind: TestItemKind;
  label: string;
  parent?: string;
  uri?: string;
  range?: Range;
}

export interface DiscoverTestsParams {
  uri?: string;
}

export interface DiscoverTestsResult {
  tests: TestItem[];
}

export const DiscoverTestsRequestType = new RequestType<
  DiscoverTestsParams,
  DiscoverTestsResult,
  void
>("ty/discoverTests");

export interface ResolveTestRunParamsParams {
  testId: string;
}

export interface ResolveTestRunParamsResult {
  workingDirectory: string;
  arguments: string[];
}

export const ResolveTestRunParamsRequestType = new RequestType<
  ResolveTestRunParamsParams,
  ResolveTestRunParamsResult | null,
  void
>("ty/resolveTestRunParams");
