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
    vscode.commands.registerCommand("smile-cpp.openPanel", async (tab?: string) => {
      await provider.openWindow(typeof tab === "string" ? tab : undefined);
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(SmileSidebarProvider.panelType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        provider.attachPanel(panel, true);
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("smile-cpp.refresh", () => {
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
