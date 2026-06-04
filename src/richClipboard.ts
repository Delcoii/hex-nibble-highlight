import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function extractCfHtmlFragment(cfHtml: string): string {
    const startMarker = '<!--StartFragment-->';
    const endMarker = '<!--EndFragment-->';
    const start = cfHtml.indexOf(startMarker);
    const end = cfHtml.indexOf(endMarker);

    if (start === -1 || end === -1 || end <= start) {
        return cfHtml;
    }

    return cfHtml.slice(start + startMarker.length, end);
}

const START_FRAGMENT = '<!--StartFragment-->';
const END_FRAGMENT = '<!--EndFragment-->';

function byteLengthUtf8(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

function byteOffsetAt(text: string, charIndex: number): number {
    return Buffer.byteLength(text.slice(0, charIndex), 'utf8');
}

function patchCfHtmlOffsets(cfHtml: string): string {
    const headerEnd = cfHtml.indexOf('\r\n\r\n');

    if (headerEnd === -1) {
        return cfHtml;
    }

    const body = cfHtml.slice(headerEnd + 4);
    const placeholderHeader =
        'Version:1.0\r\n' +
        'StartHTML:0000000000\r\n' +
        'EndHTML:0000000000\r\n' +
        'StartFragment:0000000000\r\n' +
        'EndFragment:0000000000\r\n' +
        '\r\n';
    const temp = placeholderHeader + body;

    const startHtmlIdx = temp.indexOf('<html');
    const startFragmentIdx = temp.indexOf(START_FRAGMENT);
    const endFragmentIdx = temp.indexOf(END_FRAGMENT);
    const endHtmlIdx = temp.lastIndexOf('</html>');

    if (
        startHtmlIdx === -1 ||
        startFragmentIdx === -1 ||
        endFragmentIdx === -1 ||
        endHtmlIdx === -1
    ) {
        return cfHtml;
    }

    const endHtmlExclusive = endHtmlIdx + '</html>'.length;
    const endFragmentExclusive = endFragmentIdx + END_FRAGMENT.length;
    const startFragmentContent = startFragmentIdx + START_FRAGMENT.length;
    const pad = (byteOffset: number) => byteOffset.toString().padStart(10, '0');

    const header =
        'Version:1.0\r\n' +
        `StartHTML:${pad(byteOffsetAt(temp, startHtmlIdx))}\r\n` +
        `EndHTML:${pad(byteOffsetAt(temp, endHtmlExclusive))}\r\n` +
        `StartFragment:${pad(byteOffsetAt(temp, startFragmentContent))}\r\n` +
        `EndFragment:${pad(byteOffsetAt(temp, endFragmentExclusive))}\r\n` +
        '\r\n';

    return header + body;
}

export function patchCfHtmlHexColors(
    cfHtml: string,
    nibbleColors: string[]
): string {
    const start = cfHtml.indexOf(START_FRAGMENT);
    const end = cfHtml.indexOf(END_FRAGMENT);

    if (start === -1 || end === -1 || end <= start) {
        return patchHexColorsInHtmlTextNodes(cfHtml, nibbleColors);
    }

    const before = cfHtml.slice(0, start + START_FRAGMENT.length);
    const fragment = cfHtml.slice(start + START_FRAGMENT.length, end);
    const after = cfHtml.slice(end);
    const patchedFragment = patchHexColorsInHtmlTextNodes(fragment, nibbleColors);

    if (patchedFragment === fragment) {
        return cfHtml;
    }

    return patchCfHtmlOffsets(before + patchedFragment + after);
}

export function buildCfHtml(htmlFragment: string): string {
    const fragment = `${START_FRAGMENT}${htmlFragment}${END_FRAGMENT}`;
    const fullHtml = `<html><body>${fragment}</body></html>`;
    const header = 'Version:1.0\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n\r\n';

    return patchCfHtmlOffsets(header + fullHtml);
}

/**
 * Patch only text between HTML tags. Syntax spans/structure stay intact.
 */
export function patchHexColorsInHtmlTextNodes(
    html: string,
    nibbleColors: string[]
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

        result += patchHexColorsInPlainTextNode(
            html.slice(index, textEnd),
            nibbleColors
        );
        index = textEnd;
    }

    return result;
}

function patchHexColorsInPlainTextNode(
    text: string,
    nibbleColors: string[]
): string {
    return text.replace(
        /0[xX]([0-9a-fA-F]+)([uUlL]*)/g,
        (_match, digits: string, suffix: string) => {
            let digitHtml = '';
            let colorIndex = 0;

            for (let end = digits.length; end > 0; end -= 4) {
                const start = Math.max(0, end - 4);
                const chunk = digits.slice(start, end);
                const color = nibbleColors[colorIndex % nibbleColors.length];
                digitHtml =
                    `<span style="color: ${color} !important;">${chunk}</span>` +
                    digitHtml;
                colorIndex++;
            }

            return `0x${digitHtml}${suffix}`;
        }
    );
}

export type ClipboardPayload = {
    html: string;
    plain: string;
};

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

        const lines = stdout
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0);

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

export async function writeRichClipboard(
    plainText: string,
    cfHtml: string
): Promise<boolean> {
    if (process.platform !== 'win32') {
        return false;
    }

    const plainB64 = Buffer.from(plainText, 'utf8').toString('base64');
    const cfB64 = Buffer.from(cfHtml, 'utf8').toString('base64');

    const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        `$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${plainB64}'))`,
        `$cf = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${cfB64}'))`,
        '$data = New-Object System.Windows.Forms.DataObject',
        '$data.SetData([System.Windows.Forms.DataFormats]::Html, $cf)',
        '$data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $plain)',
        '[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)',
    ].join('\n');

    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

    await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-EncodedCommand', encodedCommand],
        { timeout: 15_000 }
    );

    return true;
}

export async function readRichClipboardWithRetry(
    attempts = 5,
    delayMs = 50
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
    return new Promise(resolve => setTimeout(resolve, 120));
}
