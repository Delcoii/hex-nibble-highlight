import * as vscode from 'vscode';

let decorations: vscode.TextEditorDecorationType[] = [];

type OffsetRange = {
    start: number;
    end: number;
};


export function activate(context: vscode.ExtensionContext) {
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

    decorations = [
        vscode.window.createTextEditorDecorationType({
        //   color: '#FFD866',
        //   fontWeight: 'bold'
          color: '#ffa166'
        }),
        vscode.window.createTextEditorDecorationType({
            color: '#78b6e8'
        }),
        vscode.window.createTextEditorDecorationType({
            color: '#87dc76'
        }),
        vscode.window.createTextEditorDecorationType({
            color: '#AB9DF2'
        })
    ];

    function clearDecorations(editor: vscode.TextEditor): void {
        for (const decoration of decorations) {
            editor.setDecorations(decoration, []);
        }
    }

    function isSupportedLanguage(languageId: string): boolean {
        return ['c', 'cpp'].includes(languageId);
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

    
    function update(editor: vscode.TextEditor | undefined): void {
        if (!editor) {
            return;
        }

        const doc = editor.document;

        if (!isSupportedLanguage(doc.languageId)) {
            clearDecorations(editor);
            return;
        }

        const text = doc.getText();
        // const rangesByColor: vscode.Range[][] = decorations.map(() => []);
        const commentRanges = getCommentRanges(text);
        const rangesByColor: vscode.Range[][] = decorations.map(() => []);


        /*
        Matches hexadecimal integer literals.

        Examples:
            0x1234
            0XDEADBEEF
            0x12345678ULL
            0xffff0000u

        Group 1 contains only hexadecimal digits.
        Group 2 contains an optional integer suffix.
        */
        const regex = /0[xX]([0-9a-fA-F]+)([uUlL]*)/g;

        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
            const fullStartOffset = match.index;
            const fullEndOffset = regex.lastIndex;

            if (overlapsAnyRange(fullStartOffset, fullEndOffset, commentRanges)) {
                continue;
            }
            const digits = match[1];
            const digitStartOffset = fullStartOffset + 2;
            const digitEndOffset = digitStartOffset + digits.length;


            let colorIndex = 0;

            // Color hexadecimal digits in groups of four.
            // The grouping starts from the right side.
            for (let end = digitEndOffset; end > digitStartOffset; end -= 4) {
                const start = Math.max(digitStartOffset, end - 4);

                const startPos = doc.positionAt(start);
                const endPos = doc.positionAt(end);

                rangesByColor[colorIndex % decorations.length].push(
                    new vscode.Range(startPos, endPos)
                );

                colorIndex++;
            }
        }

        decorations.forEach((decoration, index) => {
            editor.setDecorations(decoration, rangesByColor[index]);
        });
    }

    function updateActiveEditor(): void {
        update(vscode.window.activeTextEditor);
    }

    updateActiveEditor();

    context.subscriptions.push(
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
        })
    );
}

export function deactivate(): void {
    for (const decoration of decorations) {
        decoration.dispose();
    }

    decorations = [];
}