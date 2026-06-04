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

function parseHeaderFields(header: string): Partial<Record<keyof CfHtmlOffsets, number>> {
    const parsed: Partial<Record<keyof CfHtmlOffsets, number>> = {};

    for (const { key, name } of HEADER_FIELD_MAP) {
        const match = new RegExp(`^${name}:([\\d-]+)`, 'm').exec(header);

        if (match) {
            parsed[key] = parseInt(match[1], 10);
        }
    }

    return parsed;
}

const PASTE_DEBUG_ANCHORS = [
    'int main',
    'const char *s1',
    'const char *s2',
    '0xDDDDDDDD',
    'printf',
    'return 0',
] as const;

function extractFragmentContent(cfHtml: string): string | null {
    const start = cfHtml.indexOf(START_FRAGMENT);
    const end = cfHtml.indexOf(END_FRAGMENT);

    if (start === -1 || end === -1 || end <= start) {
        return null;
    }

    return cfHtml.slice(start + START_FRAGMENT.length, end);
}

export function debugPasteAnchors(
    cfHtml: string,
    plain: string,
    label: string
): void {
    const fragment = extractFragmentContent(cfHtml);
    const plainNorm = plain.replace(/\r\n/g, '\n');

    logCopyDebug(`--- paste anchors: ${label} ---`);

    for (const anchor of PASTE_DEBUG_ANCHORS) {
        const inPlain = plainNorm.includes(anchor);
        const inHtml = cfHtml.includes(anchor);
        const inFrag = fragment?.includes(anchor) ?? false;

        logCopyDebug(
            `anchor ${JSON.stringify(anchor)}: plain=${inPlain} html=${inHtml} fragment=${inFrag}`
        );
    }

    const parts = splitCfHtmlAtHtml(cfHtml);

    if (!parts) {
        logCopyDebug(`${label}: no CF_HTML header split`);
        return;
    }

    const parsed = parseHeaderFields(parts.header);
    const layout = parts.header + parts.body;
    const recomputed = computeCfHtmlOffsets(layout);
    const buf = Buffer.from(cfHtml, 'utf8');
    const total = buf.length;

    logCopyDebug(
        `${label}: totalBytes=${total} headerChars=${parts.header.length} bodyChars=${parts.body.length}`
    );

    for (const { key, name } of HEADER_FIELD_MAP) {
        const headerVal = parsed[key];
        const want = recomputed?.[key];

        if (headerVal === undefined) {
            continue;
        }

        const match =
            want === undefined
                ? 'no recompute'
                : headerVal === want
                  ? 'ok'
                  : `BAD want ${want}`;

        logCopyDebug(`${label} header ${name}=${headerVal} ${match}`);

        if (headerVal >= 0 && headerVal < total) {
            const slice = buf
                .subarray(Math.max(0, headerVal - 30), Math.min(total, headerVal + 50))
                .toString('utf8')
                .replace(/\r/g, '\\r')
                .replace(/\n/g, '\\n');

            logCopyDebug(`${label} @${name}: ...${slice}...`);
        } else if (headerVal >= total) {
            logCopyDebug(
                `${label} @${name}: OUT OF RANGE (offset ${headerVal} >= ${total}) — Office may truncate here`
            );
        }
    }

    if (fragment) {
        debugSpanDepthNearAnchor(fragment, 'const char *s2', label);
    }
}

function debugSpanDepthNearAnchor(
    fragment: string,
    anchor: string,
    label: string
): void {
    const pos = fragment.indexOf(anchor);

    if (pos === -1) {
        logCopyDebug(`${label}: anchor ${JSON.stringify(anchor)} not in fragment`);
        return;
    }

    const windowStart = Math.max(0, pos - 120);
    const windowEnd = Math.min(fragment.length, pos + anchor.length + 200);
    const window = fragment.slice(windowStart, windowEnd);
    let depth = 0;
    let minDepth = 0;
    const tagRe = /<\/?span\b[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(window)) !== null) {
        if (match[0].startsWith('</')) {
            depth--;
        } else {
            depth++;
        }

        minDepth = Math.min(minDepth, depth);
    }

    const snippet = window.replace(/\r/g, '\\r').replace(/\n/g, '\\n');

    logCopyDebug(
        `${label}: span depth near ${JSON.stringify(anchor)} depthEnd=${depth} minDepth=${minDepth} (want depthEnd=0)`
    );
    logCopyDebug(`${label}: window ${JSON.stringify(snippet.slice(0, 280))}`);
}

function debugValidateFragment(fragment: string, label: string): void {
    const openSpan = (fragment.match(/<span\b/gi) ?? []).length;
    const closeSpan = (fragment.match(/<\/span>/gi) ?? []).length;
    const hasStart = fragment.includes(START_FRAGMENT);
    const hasEnd = fragment.includes(END_FRAGMENT);

    logCopyDebug(
        `${label}: len=${fragment.length} spans ${openSpan}/${closeSpan} markers=${hasStart}/${hasEnd}`
    );

    if (openSpan !== closeSpan) {
        logCopyDebug(`${label}: WARN unbalanced <span> (${openSpan} vs ${closeSpan})`);
    }
}

/**
 * Patch numeric fields in the existing VS Code header (same byte length as layout).
 */
function recalculateCfHtmlHeader(cfHtml: string): string {
    logCopyDebug(`recalculateCfHtmlHeader: in len=${cfHtml.length}`);

    const parts = splitCfHtmlAtHtml(cfHtml);

    if (!parts) {
        logCopyDebug(
            `recalculateCfHtmlHeader: FAIL no <html> prefix=${JSON.stringify(cfHtml.slice(0, 100))}`
        );
        return cfHtml;
    }

    const layout = parts.header + parts.body;
    const beforeHeaderFields = parseHeaderFields(parts.header);

    logCopyDebug(
        `layout: headerChars=${parts.header.length} htmlStartByte=${byteIndexAt(layout, parts.htmlStart)} bodyChars=${parts.body.length}`
    );

    for (const { key, name } of HEADER_FIELD_MAP) {
        const value = beforeHeaderFields[key];

        if (value !== undefined) {
            logCopyDebug(`header before ${name}=${value}`);
        }
    }

    const offsets = computeCfHtmlOffsets(layout);

    if (!offsets) {
        logCopyDebug('recalculateCfHtmlHeader: FAIL computeCfHtmlOffsets');
        return cfHtml;
    }

    let newHeader = parts.header;

    for (const { key, name } of HEADER_FIELD_MAP) {
        if (new RegExp(`^${name}:`, 'm').test(newHeader)) {
            newHeader = patchHeaderField(newHeader, name, offsets[key]);
        } else {
            logCopyDebug(`header field absent (skip): ${name}`);
        }
    }

    if (newHeader.length !== parts.header.length) {
        logCopyDebug(
            `WARN: header char length changed ${parts.header.length} -> ${newHeader.length}`
        );
    }

    const result = newHeader + parts.body;
    const afterHeaderFields = parseHeaderFields(newHeader);

    logCopyDebug(
        `CF_HTML offsets computed: StartHTML=${offsets.startHtml} EndHTML=${offsets.endHtml} EndFragment=${offsets.endFragment} EndSelection=${offsets.endSelection} totalBytes=${byteIndexAt(result, result.length)}`
    );

    for (const { key, name } of HEADER_FIELD_MAP) {
        const written = afterHeaderFields[key];

        if (written !== undefined) {
            const ok = written === offsets[key] ? 'ok' : `MISMATCH want ${offsets[key]}`;
            logCopyDebug(`header after ${name}=${written} ${ok}`);
        }
    }

    debugPeekBytesAtOffsets(result, offsets);

    return result;
}

function debugPeekBytesAtOffsets(cfHtml: string, offsets: CfHtmlOffsets): void {
    const buf = Buffer.from(cfHtml, 'utf8');
    const total = buf.length;

    const peek = (label: string, offset: number) => {
        if (offset < 0 || offset >= total) {
            logCopyDebug(`peek ${label}@${offset}: OUT OF RANGE (total=${total})`);
            return;
        }

        const sample = buf
            .subarray(offset, Math.min(offset + 40, total))
            .toString('utf8')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n');

        logCopyDebug(`peek ${label}@${offset}: "${sample}"`);
    };

    peek('StartHTML', offsets.startHtml);
    peek('EndHTML', offsets.endHtml - 20);
    peek('EndFragment', offsets.endFragment);
    peek('EndSelection', offsets.endSelection);
}

export async function debugDumpClipboardToFile(
    cfHtml: string,
    plain: string
): Promise<string | null> {
    const id = randomBytes(4).toString('hex');
    const htmlPath = join(tmpdir(), `hex-nibble-debug-${id}.html`);
    const plainPath = join(tmpdir(), `hex-nibble-debug-${id}.txt`);

    try {
        await writeFile(htmlPath, cfHtml, 'utf8');
        await writeFile(plainPath, plain, 'utf8');
        logCopyDebug(`debug dump: ${htmlPath}`);
        logCopyDebug(`debug dump: ${plainPath}`);
        return htmlPath;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logCopyDebug(`debug dump failed: ${message}`);
        return null;
    }
}

export async function debugVerifyWrittenClipboard(
    expectedHtmlLen: number,
    expectedPlainLen: number
): Promise<void> {
    logCopyDebug('--- verify clipboard after write ---');

    const read = await readRichClipboard();

    if (!read) {
        logCopyDebug('verify: readRichClipboard FAILED');
        return;
    }

    logCopyDebug(
        `verify: html=${read.html.length} (expected ${expectedHtmlLen}) plain=${read.plain.length} (expected ${expectedPlainLen})`
    );

    if (read.html.length !== expectedHtmlLen) {
        logCopyDebug(
            `verify: WARN html length mismatch delta=${read.html.length - expectedHtmlLen}`
        );
    }

    const parts = splitCfHtmlAtHtml(read.html);

    if (!parts) {
        logCopyDebug('verify: no <html> in read-back HTML');
        return;
    }

    const parsed = parseHeaderFields(parts.header);
    const layout = parts.header + parts.body;
    const recomputed = computeCfHtmlOffsets(layout);

    for (const line of parts.header.split(/\r?\n/).filter(Boolean)) {
        logCopyDebug(`verify header line: ${line}`);
    }

    if (recomputed) {
        for (const { key, name } of HEADER_FIELD_MAP) {
            const headerVal = parsed[key];
            const want = recomputed[key];
            const match =
                headerVal === undefined
                    ? 'missing'
                    : headerVal === want
                      ? 'ok'
                      : `BAD (want ${want})`;
            logCopyDebug(`verify ${name}: ${headerVal ?? 'n/a'} ${match}`);
        }

        debugPeekBytesAtOffsets(read.html, recomputed);
    }

    const fragStart = read.html.indexOf(START_FRAGMENT);
    const fragEnd = read.html.indexOf(END_FRAGMENT);

    if (fragStart !== -1 && fragEnd !== -1) {
        const fragLen = fragEnd - fragStart - START_FRAGMENT.length;
        logCopyDebug(`verify fragment content chars=${fragLen}`);
        debugValidateFragment(
            read.html.slice(fragStart, fragEnd + END_FRAGMENT.length),
            'verify fragment'
        );
    }

    const plainLines = read.plain.replace(/\r\n/g, '\n').split('\n');
    logCopyDebug(
        `verify plain: lines=${plainLines.length} lastLine=${JSON.stringify(plainLines.at(-1) ?? '')}`
    );
    logCopyDebug(
        `verify plain tail: ${JSON.stringify(read.plain.slice(-120))}`
    );

    debugPasteAnchors(read.html, read.plain, 'clipboard read-back');
}

function spliceCfHtmlFragment(cfHtml: string, newFragment: string): string {
    const start = cfHtml.indexOf(START_FRAGMENT);
    const end = cfHtml.indexOf(END_FRAGMENT);

    if (start === -1 || end === -1 || end <= start) {
        logCopyDebug('spliceCfHtmlFragment: missing fragment markers');
        return cfHtml;
    }

    const contentStart = start + START_FRAGMENT.length;
    const oldFragment = cfHtml.slice(contentStart, end);

    if (oldFragment === newFragment) {
        logCopyDebug('spliceCfHtmlFragment: fragment unchanged, skip header');
        return cfHtml;
    }

    const updated =
        cfHtml.slice(0, contentStart) + newFragment + cfHtml.slice(end);

    logCopyDebug(
        `spliceCfHtmlFragment: cfHtml ${cfHtml.length} -> ${updated.length} (frag +${newFragment.length - oldFragment.length})`
    );

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

    debugValidateFragment(fragment, 'fragment before');
    debugValidateFragment(patchedFragment, 'fragment after');

    logCopyDebug('patchCfHtmlHexColors: splice + recalculateCfHtmlHeader');
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
