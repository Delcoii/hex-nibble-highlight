import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function logCopyDebug(message: string): void {
    const enabled = vscode.workspace
        .getConfiguration('hex-nibble-highlight')
        .get<boolean>('debugCopy', true);

    if (!enabled) {
        return;
    }

    outputChannel ??= vscode.window.createOutputChannel('Hex Nibble Highlight');
    const time = new Date().toLocaleTimeString();
    outputChannel.appendLine(`[${time}] ${message}`);
}

export function showCopyDebugOutput(): void {
    outputChannel?.show(true);
}

export function disposeCopyDebugOutput(): void {
    outputChannel?.dispose();
    outputChannel = undefined;
}
