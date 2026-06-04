import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { logCopyDebug } from './copyDebug';

const execFileAsync = promisify(execFile);

const START_FRAGMENT = '<!--StartFragment-->';
const END_FRAGMENT = '<!--EndFragment-->';

export function normalizePlainText(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseBase64StdoutLines(stdout: string): string[] {
    return stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^[A-Za-z0-9+/]+=*$/.test(line) && line.length >= 8);
}

function byteIndexAt(text: string, charIndex: number): number {
    return Buffer.byteLength(text.slice(0, charIndex), 'utf8');
}

function colorizeHexLiteral(literal: string, nibbleColors: string[]): string {
    const parts = literal.match(/^0[xX]([0-9a-fA-F]+)([uUlL]*)$/);

    if (!parts || nibbleColors.length === 0) {
        return literal;
    }

    let digitHtml = '';
    let colorIndex = 0;
    const digits = parts[1];
    const suffix = parts[2];

    for (let end = digits.length; end > 0; end -= 4) {
        const start = Math.max(0, end - 4);
        const chunk = digits.slice(start, end);
        const color = nibbleColors[colorIndex % nibbleColors.length];
        digitHtml =
            `<span style="color: ${color} !important;">${chunk}</span>` + digitHtml;
        colorIndex++;
    }

    return `0x${digitHtml}${suffix}`;
}

/**
 * Patch hex only inside text between tags. Does not touch tags, nbsp, or structure.
 */
function patchHexColorsInHtmlTextNodes(
    html: string,
    nibbleColors: string[],
    allowedLiterals?: ReadonlySet<string>
): string {
    if (nibbleColors.length === 0) {
        return html;
    }

    let result = '';
    let index = 0;

    while (index < html.length) {
        if (html[index] === '<') {
            const tagEnd = html.indexOf('>', index);

            if (tagEnd === -1) {
                result += html.slice(index);
                break;
            }

            result += html.slice(index, tagEnd + 1);
            index = tagEnd + 1;
            continue;
        }

        let textEnd = index;

        while (textEnd < html.length && html[textEnd] !== '<') {
            textEnd++;
        }

        const text = html.slice(index, textEnd);

        result += text.replace(/0[xX]([0-9a-fA-F]+)([uUlL]*)/g, match => {
            if (allowedLiterals && !allowedLiterals.has(match)) {
                return match;
            }

            return colorizeHexLiteral(match, nibbleColors);
        });
        index = textEnd;
    }

    return result;
}

type CfHtmlOffsets = {
    startHtml: number;
    endHtml: number;
    startFragment: number;
    endFragment: number;
    startSelection: number;
    endSelection: number;
};

function buildHeaderBlock(version: string, offsets: CfHtmlOffsets): string {
    const pad = (n: number) => n.toString().padStart(10, '0');

    return (
        `Version:${version}\r\n` +
        `StartHTML:${pad(offsets.startHtml)}\r\n` +
        `EndHTML:${pad(offsets.endHtml)}\r\n` +
        `StartFragment:${pad(offsets.startFragment)}\r\n` +
        `EndFragment:${pad(offsets.endFragment)}\r\n` +
        `StartSelection:${pad(offsets.startSelection)}\r\n` +
        `EndSelection:${pad(offsets.endSelection)}\r\n` +
        '\r\n'
    );
}

/**
 * Offsets must be computed on the final `header + body` layout, not on the
 * pre-header-rebuild string (header length change shifts every byte position).
 */
function recalculateCfHtmlHeader(cfHtmlWithOldHeader: string): string {
    const headerEnd = cfHtmlWithOldHeader.indexOf('\r\n\r\n');

    if (headerEnd === -1) {
        return cfHtmlWithOldHeader;
    }

    const body = cfHtmlWithOldHeader.slice(headerEnd + 4);
    const versionMatch = cfHtmlWithOldHeader.match(/^Version:([\d.]+)/m);
    const version = versionMatch?.[1] ?? '1.0';

    const placeholderHeader = buildHeaderBlock(version, {
        startHtml: 0,
        endHtml: 0,
        startFragment: 0,
        endFragment: 0,
        startSelection: 0,
        endSelection: 0,
    });
    const temp = placeholderHeader + body;

    const startHtmlPos = temp.indexOf('<html');
    const endHtmlTagPos = temp.lastIndexOf('</html>');
    const startFragPos = temp.indexOf(START_FRAGMENT);
    const endFragPos = temp.indexOf(END_FRAGMENT);

    if (
        startHtmlPos === -1 ||
        endHtmlTagPos === -1 ||
        startFragPos === -1 ||
        endFragPos === -1
    ) {
        return cfHtmlWithOldHeader;
    }

    const endHtmlExclusive = endHtmlTagPos + '</html>'.length;
    const startFragContent = startFragPos + START_FRAGMENT.length;

    const offsets: CfHtmlOffsets = {
        startHtml: byteIndexAt(temp, startHtmlPos),
        endHtml: byteIndexAt(temp, endHtmlExclusive),
        startFragment: byteIndexAt(temp, startFragContent),
        endFragment: byteIndexAt(temp, endFragPos),
        startSelection: byteIndexAt(temp, startFragContent),
        endSelection: byteIndexAt(temp, endHtmlExclusive),
    };

    const header = buildHeaderBlock(version, offsets);
    const result = header + body;

    if (header.length !== placeholderHeader.length) {
        logCopyDebug(
            `WARN: CF_HTML header size changed ${placeholderHeader.length} -> ${header.length}`
        );
    }

    logCopyDebug(
        `CF_HTML offsets: StartHTML=${offsets.startHtml} EndHTML=${offsets.endHtml} EndFragment=${offsets.endFragment} EndSelection=${offsets.endSelection} total=${byteIndexAt(result, result.length)}`
    );

    return result;
}

function spliceCfHtmlFragment(cfHtml: string, newFragment: string): string {
    const start = cfHtml.indexOf(START_FRAGMENT);
    const end = cfHtml.indexOf(END_FRAGMENT);

    if (start === -1 || end === -1 || end <= start) {
        return cfHtml;
    }

    const contentStart = start + START_FRAGMENT.length;
    const oldFragment = cfHtml.slice(contentStart, end);

    if (oldFragment === newFragment) {
        return cfHtml;
    }

    const updated =
        cfHtml.slice(0, contentStart) + newFragment + cfHtml.slice(end);

    return recalculateCfHtmlHeader(updated);
}

/**
 * VS Code syntax HTML stays intact; only 0x literals in text nodes get nibble colors.
 */
export function patchCfHtmlHexColors(
    cfHtml: string,
    nibbleColors: string[],
    allowedLiterals?: ReadonlySet<string>
): string {
    const start = cfHtml.indexOf(START_FRAGMENT);
    const end = cfHtml.indexOf(END_FRAGMENT);

    if (start === -1 || end === -1 || end <= start) {
        logCopyDebug('patchCfHtmlHexColors: no fragment markers');
        return patchHexColorsInHtmlTextNodes(cfHtml, nibbleColors, allowedLiterals);
    }

    const contentStart = start + START_FRAGMENT.length;
    const fragment = cfHtml.slice(contentStart, end);
    const patchedFragment = patchHexColorsInHtmlTextNodes(
        fragment,
        nibbleColors,
        allowedLiterals
    );

    if (patchedFragment === fragment) {
        logCopyDebug('patchCfHtmlHexColors: no hex matched in HTML text nodes');
        return cfHtml;
    }

    logCopyDebug(
        `patchCfHtmlHexColors: fragment ${fragment.length} -> ${patchedFragment.length}`
    );

    return spliceCfHtmlFragment(cfHtml, patchedFragment);
}

export function htmlHasNibbleHexPatch(
    html: string,
    nibbleColors: string[]
): boolean {
    return (
        html.includes('!important') &&
        nibbleColors.some(color => html.includes(color))
    );
}

export function collectHexLiterals(plainText: string): string[] {
    const regex = /0[xX]([0-9a-fA-F]+)([uUlL]*)/g;
    const literals: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(plainText)) !== null) {
        literals.push(match[0]);
    }

    return [...new Set(literals)];
}

export type ClipboardPayload = {
    html: string;
    plain: string;
};

export async function readPlainTextWithRetry(
    attempts = 10,
    delayMs = 80
): Promise<string> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const plain = await vscode.env.clipboard.readText();

        if (plain) {
            return plain;
        }

        if (attempt < attempts - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    return '';
}

export async function readRichClipboard(): Promise<ClipboardPayload | null> {
    if (process.platform !== 'win32') {
        logCopyDebug('readRichClipboard: skipped (not win32)');
        return null;
    }

    const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$data = [System.Windows.Forms.Clipboard]::GetDataObject()',
        'if ($null -eq $data) { exit 2 }',
        '$html = $data.GetData([System.Windows.Forms.DataFormats]::Html)',
        'if ($null -eq $html) { exit 3 }',
        '$plain = $data.GetData([System.Windows.Forms.DataFormats]::UnicodeText)',
        'if ($null -eq $plain) { $plain = "" }',
        '$htmlB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$html))',
        '$plainB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$plain))',
        '[Console]::Out.WriteLine($htmlB64)',
        '[Console]::Out.WriteLine($plainB64)',
    ].join('\n');

    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

    try {
        const { stdout } = await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-STA', '-EncodedCommand', encodedCommand],
            { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 }
        );

        const lines = parseBase64StdoutLines(stdout);

        if (lines.length < 1) {
            logCopyDebug(
                `readRichClipboard: no base64 lines (stdout ${stdout.length} chars)`
            );
            return null;
        }

        const html = Buffer.from(lines[0], 'base64').toString('utf8');

        if (!html) {
            logCopyDebug('readRichClipboard: decoded html empty');
            return null;
        }

        const plain =
            lines.length >= 2
                ? Buffer.from(lines[1], 'base64').toString('utf8')
                : '';

        logCopyDebug(
            `readRichClipboard: ok html=${html.length} plain=${plain.length}`
        );
        return { html, plain };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logCopyDebug(`readRichClipboard: error ${message}`);
        return null;
    }
}

const CLIPBOARD_PS_SCRIPT = `param(
    [Parameter(Mandatory = $true)][string]$PlainPath,
    [Parameter(Mandatory = $true)][string]$HtmlPath
)
Add-Type -AssemblyName System.Windows.Forms
$plain = [System.IO.File]::ReadAllText($PlainPath, [System.Text.Encoding]::UTF8)
$cf = [System.IO.File]::ReadAllText($HtmlPath, [System.Text.Encoding]::UTF8)
$data = New-Object System.Windows.Forms.DataObject
$data.SetData([System.Windows.Forms.DataFormats]::Html, $cf)
$data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $plain)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
`;

async function removeTempFile(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch {
        // ignore cleanup errors
    }
}

export async function writeRichClipboard(
    plainText: string,
    cfHtml: string
): Promise<boolean> {
    if (process.platform !== 'win32') {
        return false;
    }

    const id = randomBytes(8).toString('hex');
    const plainPath = join(tmpdir(), `hex-nibble-${id}-plain.txt`);
    const htmlPath = join(tmpdir(), `hex-nibble-${id}.html`);
    const scriptPath = join(tmpdir(), `hex-nibble-${id}.ps1`);

    try {
        await writeFile(plainPath, plainText, 'utf8');
        await writeFile(htmlPath, cfHtml, 'utf8');
        await writeFile(scriptPath, CLIPBOARD_PS_SCRIPT, 'utf8');

        await execFileAsync(
            'powershell.exe',
            [
                '-NoProfile',
                '-STA',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                scriptPath,
                '-PlainPath',
                plainPath,
                '-HtmlPath',
                htmlPath,
            ],
            { timeout: 15_000 }
        );

        logCopyDebug(
            `writeRichClipboard: ok via temp files (plain=${plainText.length} html=${cfHtml.length})`
        );
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logCopyDebug(`writeRichClipboard: error ${message}`);
        throw error;
    } finally {
        await removeTempFile(plainPath);
        await removeTempFile(htmlPath);
        await removeTempFile(scriptPath);
    }
}

export async function readRichClipboardWithRetry(
    attempts = 10,
    delayMs = 80
): Promise<ClipboardPayload | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const payload = await readRichClipboard();

        if (payload?.html) {
            logCopyDebug(`readRichClipboardWithRetry: success attempt ${attempt + 1}`);
            return payload;
        }

        if (attempt < attempts - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    logCopyDebug(`readRichClipboardWithRetry: failed after ${attempts} attempts`);
    return null;
}

export function clipboardSettleDelay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 200));
}
