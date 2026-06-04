import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

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

const HEADER_FIELD_MAP: { key: keyof CfHtmlOffsets; name: string }[] = [
    { key: 'startHtml', name: 'StartHTML' },
    { key: 'endHtml', name: 'EndHTML' },
    { key: 'startFragment', name: 'StartFragment' },
    { key: 'endFragment', name: 'EndFragment' },
    { key: 'startSelection', name: 'StartSelection' },
    { key: 'endSelection', name: 'EndSelection' },
];

function splitCfHtmlAtHtml(
    cfHtml: string
): { header: string; body: string; htmlStart: number } | null {
    const htmlStart = cfHtml.indexOf('<html');

    if (htmlStart === -1) {
        return null;
    }

    return {
        header: cfHtml.slice(0, htmlStart),
        body: cfHtml.slice(htmlStart),
        htmlStart,
    };
}

function patchHeaderField(
    header: string,
    fieldName: string,
    byteOffset: number
): string {
    const re = new RegExp(`^(${fieldName}:)([\\d-]+)`, 'm');

    if (!re.test(header)) {
        return header;
    }

    return header.replace(re, `$1${byteOffset.toString().padStart(10, '0')}`);
}

function computeCfHtmlOffsets(layout: string): CfHtmlOffsets | null {
    const htmlStart = layout.indexOf('<html');
    const endHtmlTagPos = layout.lastIndexOf('</html>');
    const startFragPos = layout.indexOf(START_FRAGMENT);
    const endFragPos = layout.indexOf(END_FRAGMENT);

    if (
        htmlStart === -1 ||
        endHtmlTagPos === -1 ||
        startFragPos === -1 ||
        endFragPos === -1
    ) {
        return null;
    }

    const endHtmlExclusive = endHtmlTagPos + '</html>'.length;
    const startFragContent = startFragPos + START_FRAGMENT.length;

    const endFragExclusive = endFragPos + END_FRAGMENT.length;

    return {
        startHtml: byteIndexAt(layout, htmlStart),
        endHtml: byteIndexAt(layout, endHtmlExclusive),
        startFragment: byteIndexAt(layout, startFragContent),
        endFragment: byteIndexAt(layout, endFragPos),
        startSelection: byteIndexAt(layout, startFragContent),
        // Word/PPT often truncate when EndSelection points past a stale offset; keep
        // selection aligned with the fragment (through <!--EndFragment-->).
        endSelection: byteIndexAt(layout, endFragExclusive),
    };
}

/** Patch numeric fields in the existing VS Code CF_HTML header (same char length). */
function recalculateCfHtmlHeader(cfHtml: string): string {
    const parts = splitCfHtmlAtHtml(cfHtml);

    if (!parts) {
        return cfHtml;
    }

    const offsets = computeCfHtmlOffsets(parts.header + parts.body);

    if (!offsets) {
        return cfHtml;
    }

    let newHeader = parts.header;

    for (const { key, name } of HEADER_FIELD_MAP) {
        if (new RegExp(`^${name}:`, 'm').test(newHeader)) {
            newHeader = patchHeaderField(newHeader, name, offsets[key]);
        }
    }

    return newHeader + parts.body;
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

    return recalculateCfHtmlHeader(
        cfHtml.slice(0, contentStart) + newFragment + cfHtml.slice(end)
    );
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
        return cfHtml;
    }

    return spliceCfHtmlFragment(cfHtml, patchedFragment);
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
            return null;
        }

        const html = Buffer.from(lines[0], 'base64').toString('utf8');

        if (!html) {
            return null;
        }

        const plain =
            lines.length >= 2
                ? Buffer.from(lines[1], 'base64').toString('utf8')
                : '';

        return { html, plain };
    } catch {
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

        return true;
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
            return payload;
        }

        if (attempt < attempts - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    return null;
}

export function clipboardSettleDelay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 200));
}
