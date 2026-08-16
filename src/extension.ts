import * as vscode from "vscode";
import { SmileSidebarProvider } from "./sidebarProvider";
import { initStore, loadVisualEffect, loadVisualEffectOpacity } from "./store";
import { applyVisualEffect, cleanupVisualEffects, initVisualEffects, restoreLegacyEffectColorEdits } from "./visualEffects";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await initStore(context);
  initVisualEffects(context.globalState, context.extensionPath);
  await restoreLegacyEffectColorEdits(context.globalState);
  void applyVisualEffect(loadVisualEffect(), { reload: false, opacity: loadVisualEffectOpacity() });

  const provider = new SmileSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SmileSidebarProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("smile.openPanel", async (tab?: string) => {
      await vscode.commands.executeCommand("smile.sidebar.focus");
      if (typeof tab === "string") {
        provider.focusTab(tab);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("smile.refresh", () => {
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.refresh();
    })
  );
}

export function deactivate(): Thenable<void> {
  return cleanupVisualEffects().then(() => undefined);
}
