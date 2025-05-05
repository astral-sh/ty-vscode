// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { LanguageStatusItem, Disposable, l10n, LanguageStatusSeverity } from "vscode";
import { createLanguageStatusItem } from "./vscodeapi";
import { Command } from "vscode-languageclient";
import { getDocumentSelector } from "./utilities";

let _status: LanguageStatusItem | undefined;

/**
 * Registers a status item with the given ID, name and command.
 * The status item is registered with the document selector that is specific to the language server.
 * The command is used when the status item is clicked.
 * The returned disposable should be disposed when the status item is no longer needed.
 *
 * @param id The ID of the status item.
 * @param name The name of the status item.
 * @param command The command to run when the status item is clicked.
 * @returns A disposable that should be disposed when the status item is no longer needed.
 */
/* <<<<<<<<<<  be8822d9-742d-4b2f-a450-307005820191  >>>>>>>>>>> */
export function registerLanguageStatusItem(id: string, name: string, command: string): Disposable {
  _status = createLanguageStatusItem(id, getDocumentSelector());
  _status.name = name;
  _status.text = name;
  _status.command = Command.create(l10n.t("Open logs"), command);

  return {
    dispose: () => {
      _status?.dispose();
      _status = undefined;
    },
  };
}

export function updateStatus(
  status: string | undefined,
  severity: LanguageStatusSeverity,
  busy?: boolean,
  detail?: string,
): void {
  if (_status) {
    let name = _status.name;
    _status.text = status && status.length > 0 ? `${name}: ${status}` : `${name}`;
    _status.severity = severity;
    _status.busy = busy ?? false;
    _status.detail = detail;
  }
}
