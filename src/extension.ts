import * as vscode from 'vscode';
import {
    clipboardSettleDelay,
    normalizePlainText,
    patchCfHtmlHexColors,
    readPlainTextWithRetry,
    readRichClipboardWithRetry,
    writeRichClipboard,
} from './richClipboard';

let nibbleDecorations: vscode.TextEditorDecorationType[] = [];

type OffsetRange = {
    start: number;
    end: number;
};

type ConditionalFrame = {
    parentActive: boolean;
    parentResolvable: boolean;
    anyBranchTaken: boolean;
    known: boolean;
};

type HexColorSpan = {
    start: number;
    end: number;
    colorIndex: number;
};


export function activate(context: vscode.ExtensionContext) {
    let nibbleColors: string[] = [];
    const outputChannel = vscode.window.createOutputChannel('Hex Nibble Highlight');

    context.subscriptions.push(outputChannel);
    /*
    // bold setting...
    decorations = [
        vscode.window.createTextEditorDecorationType({
        //   color: '#FFD866',
        //   fontWeight: 'bold'
            color: '#ffa166',
            fontWeight: 'bold'
        }),
        vscode.window.createTextEditorDecorationType({
            color: '#78b6e8',
            fontWeight: 'bold'
        }),
        vscode.window.createTextEditorDecorationType({
            color: '#87dc76',
            fontWeight: 'bold'
        }),
        vscode.window.createTextEditorDecorationType({
            color: '#AB9DF2',
            fontWeight: 'bold'
        })
    ];
    */
    
    function isLightTheme(): boolean {
        const kind = vscode.window.activeColorTheme.kind;

        return (
            kind === vscode.ColorThemeKind.Light ||
            kind === vscode.ColorThemeKind.HighContrastLight
        );
    }

    function createDecorations(): void {
        for (const decoration of nibbleDecorations) {
            decoration.dispose();
        }

        const colors = isLightTheme()
            ? [
                '#9a4a00', // Dark orange for light themes
                '#006a8a', // Dark cyan-blue for light themes
                '#2f7d20', // Dark green for light themes
                '#6b4bb8'  // Dark purple for light themes
            ]
            : [
                '#ffa166', // Orange for dark themes
                '#78b6e8', // Blue for dark themes
                '#87dc76', // Green for dark themes
                '#AB9DF2'  // Purple for dark themes
            ];

        nibbleColors = colors;

        nibbleDecorations = colors.map(color =>
            vscode.window.createTextEditorDecorationType({
                color
            })
        );

    }

    createDecorations();


    function clearDecorations(editor: vscode.TextEditor): void {
        for (const decoration of nibbleDecorations) {
            editor.setDecorations(decoration, []);
        }

    }

    function isSupportedDocument(doc: vscode.TextDocument): boolean {
        if (['c', 'cpp', 'dat'].includes(doc.languageId)) {
            return true;
        }

        return doc.fileName.toLowerCase().endsWith('.dat');
    }

    function getCommentRanges(text: string): OffsetRange[] {
        const ranges: OffsetRange[] = [];

        let i = 0;
        let state: 'normal' | 'string' | 'char' | 'lineComment' | 'blockComment' = 'normal';
        let commentStart = -1;

        while (i < text.length) {
            const current = text[i];
            const next = i + 1 < text.length ? text[i + 1] : '';

            if (state === 'normal') {
                if (current === '"') {
                    state = 'string';
                    i++;
                    continue;
                }

                if (current === "'") {
                    state = 'char';
                    i++;
                    continue;
                }

                if (current === '/' && next === '/') {
                    state = 'lineComment';
                    commentStart = i;
                    i += 2;
                    continue;
                }

                if (current === '/' && next === '*') {
                    state = 'blockComment';
                    commentStart = i;
                    i += 2;
                    continue;
                }

                i++;
                continue;
            }

            if (state === 'string') {
                if (current === '\\') {
                    i += 2;
                    continue;
                }

                if (current === '"') {
                    state = 'normal';
                }

                i++;
                continue;
            }

            if (state === 'char') {
                if (current === '\\') {
                    i += 2;
                    continue;
                }

                if (current === "'") {
                    state = 'normal';
                }

                i++;
                continue;
            }

            if (state === 'lineComment') {
                if (current === '\n') {
                    ranges.push({
                    start: commentStart,
                    end: i
                    });

                    state = 'normal';
                    commentStart = -1;
                }

                i++;
                continue;
            }

            if (state === 'blockComment') {
                if (current === '*' && next === '/') {
                    ranges.push({
                    start: commentStart,
                    end: i + 2
                    });

                    state = 'normal';
                    commentStart = -1;
                    i += 2;
                    continue;
                }

                i++;
                continue;
            }
        }

        if (state === 'lineComment' || state === 'blockComment') {
            ranges.push({
                start: commentStart,
                end: text.length
            });
        }

        return ranges;
    }

    function overlapsAnyRange(start: number, end: number, ranges: OffsetRange[]): boolean {
        for (const range of ranges) {
            if (end <= range.start) {
              continue;
            }

            if (start >= range.end) {
                continue;
            }

            return true;
        }

        return false;
    }

    function isIdentifier(token: string): boolean {
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token);
    }

    function parseIntegerToken(token: string): number {
        if (/^0[xX][0-9a-fA-F]+$/.test(token)) {
            return Number.parseInt(token, 16);
        }

        if (/^0[0-7]+$/.test(token)) {
            return Number.parseInt(token, 8);
        }

        return Number.parseInt(token, 10);
    }

    function evaluateIfExpression(expression: string): boolean | null {
        const sanitized = expression
            .replace(/\/\*.*?\*\//g, ' ')
            .replace(/\/\/.*$/g, '')
            .trim();

        if (!sanitized) {
            return null;
        }

        const tokenRegex = /\s+|0[xX][0-9a-fA-F]+|[0-9]+|&&|\|\||==|!=|<=|>=|[()!<>]|[A-Za-z_][A-Za-z0-9_]*/g;
        const rawTokens = sanitized.match(tokenRegex);

        if (!rawTokens) {
            return null;
        }

        const tokens = rawTokens.filter(token => !/^\s+$/.test(token));

        if (tokens.join('') !== sanitized.replace(/\s+/g, '')) {
            return null;
        }

        let cursor = 0;

        function peek(): string | undefined {
            return tokens[cursor];
        }

        function consume(expected: string): boolean {
            if (tokens[cursor] === expected) {
                cursor++;
                return true;
            }

            return false;
        }

        function parsePrimary(): number | null {
            const token = peek();

            if (!token) {
                return null;
            }

            if (consume('(')) {
                const inner = parseOr();

                if (!consume(')')) {
                    return null;
                }

                return inner;
            }

            if (isIdentifier(token)) {
                cursor++;

                // Without full macro context, identifier-based expressions are unknown.
                return null;
            }

            if (/^0[xX][0-9a-fA-F]+$/.test(token) || /^[0-9]+$/.test(token)) {
                cursor++;
                return parseIntegerToken(token);
            }

            return null;
        }

        function parseUnary(): number | null {
            if (consume('!')) {
                const value = parseUnary();

                if (value === null) {
                    return null;
                }

                return value === 0 ? 1 : 0;
            }

            return parsePrimary();
        }

        function parseRelational(): number | null {
            let left = parseUnary();

            while (true) {
                const operator = peek();

                if (!operator || !['<', '>', '<=', '>='].includes(operator)) {
                    return left;
                }

                cursor++;
                const right = parseUnary();

                if (left === null || right === null) {
                    return null;
                }

                switch (operator) {
                    case '<':
                        left = left < right ? 1 : 0;
                        break;
                    case '>':
                        left = left > right ? 1 : 0;
                        break;
                    case '<=':
                        left = left <= right ? 1 : 0;
                        break;
                    case '>=':
                        left = left >= right ? 1 : 0;
                        break;
                }
            }
        }

        function parseEquality(): number | null {
            let left = parseRelational();

            while (true) {
                const operator = peek();

                if (!operator || !['==', '!='].includes(operator)) {
                    return left;
                }

                cursor++;
                const right = parseRelational();

                if (left === null || right === null) {
                    return null;
                }

                left = operator === '=='
                    ? (left === right ? 1 : 0)
                    : (left !== right ? 1 : 0);
            }
        }

        function parseAnd(): number | null {
            let left = parseEquality();

            while (consume('&&')) {
                const right = parseEquality();

                if (left === null || right === null) {
                    return null;
                }

                left = (left !== 0 && right !== 0) ? 1 : 0;
            }

            return left;
        }

        function parseOr(): number | null {
            let left = parseAnd();

            while (consume('||')) {
                const right = parseAnd();

                if (left === null || right === null) {
                    return null;
                }

                left = (left !== 0 || right !== 0) ? 1 : 0;
            }

            return left;
        }

        const parsedValue = parseOr();

        if (parsedValue === null || cursor !== tokens.length) {
            return null;
        }

        return parsedValue !== 0;
    }

    function getInactivePreprocessorRanges(doc: vscode.TextDocument): OffsetRange[] {
        const inactiveRanges: OffsetRange[] = [];
        const frameStack: ConditionalFrame[] = [];

        let currentActive: boolean = true;
        let currentResolvable: boolean = true;

        for (let lineIndex = 0; lineIndex < doc.lineCount; lineIndex++) {
            const line = doc.lineAt(lineIndex);
            const directiveMatch = line.text.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/);

            if (!directiveMatch) {
                if (!currentActive && currentResolvable && line.text.length > 0) {
                    inactiveRanges.push({
                        start: doc.offsetAt(new vscode.Position(lineIndex, 0)),
                        end: doc.offsetAt(new vscode.Position(lineIndex, line.text.length))
                    });
                }

                continue;
            }

            const directive = directiveMatch[1];
            const expression = directiveMatch[2].trim();

            if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
                const parentActive: boolean = currentActive;
                const parentResolvable: boolean = currentResolvable;

                const frame: ConditionalFrame = {
                    parentActive,
                    parentResolvable,
                    anyBranchTaken: false,
                    known: true
                };

                if (!parentResolvable) {
                    frame.known = false;
                    currentActive = true;
                    currentResolvable = false;
                    frameStack.push(frame);
                    continue;
                }

                let conditionValue: boolean | null;

                if (!parentActive) {
                    conditionValue = false;
                } else if (directive === 'if') {
                    conditionValue = evaluateIfExpression(expression);
                } else {
                    // #ifdef and #ifndef require macro knowledge. Keep this block unresolved.
                    conditionValue = null;
                }

                if (directive === 'ifndef' && conditionValue !== null) {
                    conditionValue = !conditionValue;
                }

                if (conditionValue === null) {
                    frame.known = false;
                    currentActive = true;
                    currentResolvable = false;
                } else {
                    frame.anyBranchTaken = conditionValue;
                    currentActive = parentActive && conditionValue;
                    currentResolvable = true;
                }

                frameStack.push(frame);
                continue;
            }

            if (directive === 'elif') {
                const frame = frameStack[frameStack.length - 1];

                if (!frame) {
                    continue;
                }

                if (!frame.parentResolvable || !frame.known) {
                    currentActive = true;
                    currentResolvable = false;
                    continue;
                }

                if (!frame.parentActive) {
                    currentActive = false;
                    currentResolvable = true;
                    continue;
                }

                const conditionValue = evaluateIfExpression(expression);

                if (conditionValue === null) {
                    frame.known = false;
                    currentActive = true;
                    currentResolvable = false;
                    continue;
                }

                const branchActive = !frame.anyBranchTaken && conditionValue;
                frame.anyBranchTaken = frame.anyBranchTaken || conditionValue;

                currentActive = frame.parentActive && branchActive;
                currentResolvable = true;
                continue;
            }

            if (directive === 'else') {
                const frame = frameStack[frameStack.length - 1];

                if (!frame) {
                    continue;
                }

                if (!frame.parentResolvable || !frame.known) {
                    currentActive = true;
                    currentResolvable = false;
                    continue;
                }

                const branchActive = frame.parentActive && !frame.anyBranchTaken;
                frame.anyBranchTaken = true;

                currentActive = branchActive;
                currentResolvable = true;
                continue;
            }

            if (directive === 'endif') {
                const frame = frameStack.pop();

                if (!frame) {
                    continue;
                }

                currentActive = frame.parentActive;
                currentResolvable = frame.parentResolvable;
            }
        }

        return inactiveRanges;
    }

    function collectHexDigitColorSpans(doc: vscode.TextDocument): HexColorSpan[] {
        const text = doc.getText();
        const commentRanges = getCommentRanges(text);
        const inactiveRanges = getInactivePreprocessorRanges(doc);
        const spans: HexColorSpan[] = [];
        const regex = /0[xX]([0-9a-fA-F]+)([uUlL]*)/g;

        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
            const fullStartOffset = match.index;
            const fullEndOffset = regex.lastIndex;

            if (overlapsAnyRange(fullStartOffset, fullEndOffset, commentRanges)) {
                continue;
            }

            if (overlapsAnyRange(fullStartOffset, fullEndOffset, inactiveRanges)) {
                continue;
            }

            const digits = match[1];
            const digitStartOffset = fullStartOffset + 2;
            const digitEndOffset = digitStartOffset + digits.length;

            let colorIndex = 0;

            for (let end = digitEndOffset; end > digitStartOffset; end -= 4) {
                const start = Math.max(digitStartOffset, end - 4);

                spans.push({ start, end, colorIndex });
                colorIndex++;
            }
        }

        return spans;
    }

    function collectActiveHexLiterals(doc: vscode.TextDocument): string[] {
        const text = doc.getText();
        const commentRanges = getCommentRanges(text);
        const inactiveRanges = getInactivePreprocessorRanges(doc);
        const literals: string[] = [];
        const regex = /0[xX]([0-9a-fA-F]+)([uUlL]*)/g;

        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
            const fullStartOffset = match.index;
            const fullEndOffset = regex.lastIndex;

            if (overlapsAnyRange(fullStartOffset, fullEndOffset, commentRanges)) {
                continue;
            }

            if (overlapsAnyRange(fullStartOffset, fullEndOffset, inactiveRanges)) {
                continue;
            }

            literals.push(match[0]);
        }

        return [...new Set(literals)];
    }

    async function copyWithHighlight(): Promise<void> {
        const editor = vscode.window.activeTextEditor;

        if (!editor || !isSupportedDocument(editor.document)) {
            await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
            return;
        }

        const richCopyEnabled = vscode.workspace
            .getConfiguration('hex-nibble-highlight')
            .get<boolean>('richCopy', true);

        if (!richCopyEnabled) {
            await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
            return;
        }

        try {
            await vscode.commands.executeCommand(
                'editor.action.clipboardCopyWithSyntaxHighlightingAction'
            );
            await clipboardSettleDelay();

            const clipboard = await readRichClipboardWithRetry();
            const plainRaw = clipboard?.plain || (await readPlainTextWithRetry());
            const plainText = normalizePlainText(plainRaw);

            if (clipboard?.html && plainText) {
                const allowedLiterals = new Set(
                    collectActiveHexLiterals(editor.document)
                );
                const patchedHtml = patchCfHtmlHexColors(
                    clipboard.html,
                    nibbleColors,
                    allowedLiterals
                );

                await writeRichClipboard(plainRaw || plainText, patchedHtml);
                return;
            }
        } catch (error) {
            const message = error instanceof Error
                ? (error.stack ?? error.message)
                : String(error);

            outputChannel.appendLine(`hex-nibble-highlight: rich clipboard failed: ${message}`);
            await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
        }
    }

    function update(editor: vscode.TextEditor | undefined): void {
        if (!editor) {
            return;
        }

        const doc = editor.document;

        if (!isSupportedDocument(doc)) {
            clearDecorations(editor);
            return;
        }

        const rangesByColor: vscode.Range[][] = nibbleDecorations.map(() => []);

        for (const span of collectHexDigitColorSpans(doc)) {
            rangesByColor[span.colorIndex % nibbleDecorations.length].push(
                new vscode.Range(
                    doc.positionAt(span.start),
                    doc.positionAt(span.end)
                )
            );
        }

        nibbleDecorations.forEach((decoration, index) => {
            editor.setDecorations(decoration, rangesByColor[index]);
        });
    }

    function updateActiveEditor(): void {
        update(vscode.window.activeTextEditor);
    }

    updateActiveEditor();

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'hex-nibble-highlight.copyWithHighlight',
            copyWithHighlight
        ),

        vscode.window.onDidChangeActiveTextEditor(editor => {
            update(editor);
        }),

        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;

            if (editor && event.document === editor.document) {
                update(editor);
            }
        }),

        vscode.window.onDidChangeTextEditorVisibleRanges(event => {
            update(event.textEditor);
        }),

        vscode.window.onDidChangeTextEditorSelection(event => {
            update(event.textEditor);
        }),

        vscode.window.onDidChangeActiveColorTheme(() => {
            createDecorations();
            updateActiveEditor();
        })
    );
}

export function deactivate(): void {
    for (const decoration of nibbleDecorations) {
        decoration.dispose();
    }

    nibbleDecorations = [];
}