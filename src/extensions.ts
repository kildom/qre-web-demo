
import * as monaco from 'monaco-editor';
import { qre } from 'qre';

enum TokenType {
    NAMESPACE,
    CLASS,
    ENUM,
    INTERFACE,
    STRUCT,
    TYPE_PARAMETER,
    TYPE,
    PARAMETER,
    VARIABLE,
    PROPERTY,
    ENUM_MEMBER,
    DECORATOR,
    EVENT,
    FUNCTION,
    METHOD,
    MACRO,
    LABEL,
    COMMENT,
    STRING,
    KEYWORD,
    NUMBER,
    REGEXP,
    OPERATOR,
};

enum TokenModifier {
    NONE = 0,
    DECLARATION = 1 << 0,
    DEFINITION = 1 << 1,
    READONLY = 1 << 2,
    STATIC = 1 << 3,
    DEPRECATED = 1 << 4,
    ABSTRACT = 1 << 5,
    ASYNC = 1 << 6,
    MODIFICATION = 1 << 7,
    DOCUMENTATION = 1 << 8,
    DEFAULT_LIBRARY = 1 << 9,
}

enum ParsingState {
    CODE,
    COMMENT,
    TEMPLATE,
    CRE,
    INTERPOLATION,
}

const legend = {
    tokenTypes: [
        'namespace',
        'class',
        'enum',
        'interface',
        'struct',
        'typeParameter',
        'type',
        'parameter',
        'variable',
        'property',
        'enumMember',
        'decorator',
        'event',
        'function',
        'method',
        'macro',
        'label',
        'comment',
        'string',
        'keyword',
        'number',
        'regexp',
        'operator',
    ],
    tokenModifiers: [
        'declaration',
        'definition',
        'readonly',
        'static',
        'deprecated',
        'abstract',
        'async',
        'modification',
        'documentation',
        'defaultLibrary',
    ],
};


class TokensBuilder {
    private prevLine = 0;
    private prevCol = 0;
    private data: number[] = [];

    public reset() {
        this.prevLine = 0;
        this.prevCol = 0;
        this.data.splice(0);
    }

    public add(line: number, col: number, length: number, type: TokenType, modifier: TokenModifier) {
        this.data.push(
            line - this.prevLine,
            this.prevLine === line ? col - this.prevCol : col,
            length,
            type,
            modifier
        );
        this.prevLine = line;
        this.prevCol = col;
    }

    public getData(): Uint32Array {
        return new Uint32Array(this.data);
    }
}

interface CodeRegExpGroups {
    qre?: string;
    comment?: string;
    template?: string;
}

const codeRegExpProto = qre.global`
    //! interface CodeRegExpGroups
    {
        // Start of CRE
        word-boundary;
        qre: "qre";
        flags: repeat {
            ".";
            at-least-1 [a-zA-Z];
        }
        "\`";
    } or {
        // Normal string
        _quote: ["'];
        lazy-repeat (("\\", any) or any);
        match<_quote> or end-of-line;
    } or {
        // Single line comment
        "//";
        repeat any;
        end-of-line;
    } or {
        // Multi line comment that ends on the same line
        "/*";
        lazy-repeat any;
        "*/";
    } or {
        // Multi line comment that continues on the next line
        comment: "/*";
        repeat any;
    } or {
        // Template string that ends on the same line
        "\`";
        lazy-repeat (("\\", any) or any);
        "\`";
    } or {
        // Template string that continues on the next line
        template: "\`";
        repeat any;
    }
`;

const commentRegExpProto = qre.global`
    "*/"
`;

const templateRegExpProto = qre.global`
    lazy-repeat (("\\", any) or any);
    "\`";
`;

interface CRERegExpGroups {
    endCRE?: string;
    begin?: string;
    end?: string;
    comment?: string;
    separator?: string;
    string?: string;
    characterClass?: string;
    identifier?: string;
    label?: string;
    keyword?: string;
    interpolation?: string;
}

const creRegExpProto = qre.global`
    //! interface CRERegExpGroups
    // const tokenRegExpBase = /(?<creEnd>(?<!\\)\`)|\s*(?:(?<begin>[{(])|(?<end>[)}])|(?<separator>[,;])|(?<label>[a-zA-Z_][a-zA-Z0-9_]*):|(?<keyword>[a-zA-Z0-9\u2011\\-]+)|(?<literal>(?<_literalQuote>["'])(?:\\.|.)*?\k<_literalQuote>)|<(?<identifier>.*?)>|\[(?<complement>\^)?(?<characterClass>(?:\\.|.)*?)\]|(?<prefix>\`[A-Z]{3,})(?<index>[0-9]+)\}|(?<comment1>\/\*.*?\*\/)|(?<interpolation>\$\{)|(?<comment2>\/\/.*?)(?=[\r\n\u2028\u2029]|$))\s*/sy;
    {
        endCRE: "\`"
    } or {
        begin: [{(]
    } or {
        end: [)}]
    } or {
        comment: {
            "//";
            lazy-repeat any;
            end-of-line;
        } or {
            "/*";
            lazy-repeat any;
            "*/";
        }
    } or {
        separator: [,;]
    } or {
        string: ["'];
        lazy-repeat (("\\", any) or any);
        match<string>;
    } or {
        characterClass: "[";
        optional "^";
        lazy-repeat (("\\", any) or any);
        "]";
    } or {
        identifier: "<";
        repeat any;
        ">";
    } or {
        label: [a-zA-Z_];
        repeat [a-zA-Z0-9_];
        ":";
    } or {
        keyword: at-least-1 [a-zA-Z0-9\u2011\\-];
    } or {
        interpolation: "\${";
    }
`;

const interpolationRegExpProto = qre.global`
    "}"
`;

interface KeywordsRegExpGroups {
    characterClass?: string;
    quantifier?: string;
    operator?: string;
    assertion?: string;
}

const keywordsRegExp = qre.ignoreCase`
    //! interface KeywordsRegExpGroups
    begin-of-text;
    {
        characterClass: {
            "any"
            or "digit"
            or ("white", optional "-", "space")
            or ("word-char", optional "acter")
            or (optional "line-", "term", optional "inator")
            or ("prop", optional "erty")
        }
    } or {
        quantifier: {
            optional ("lazy-" or "non-greedy-");
            "optional"
            or (optional "at-", "least-" or "most-", at-least-1 digit)
            or (optional "repeat-", at-least-1 digit, optional "-times")
            or (optional "repeat-", at-least-1 digit, "-to-", at-least-1 digit, optional "-times")
            or "repeat";
        }
    } or {
        operator: ("or" or "not" or "match");
    } or {
        assertion: {
            "word-boundary"
            or "begin-of-text"
            or "start-of-text"
            or "end-of-text"
            or "begin-of-line"
            or "start-of-line"
            or "end-of-line"
            or "look-ahead"
            or "look-behind"
            or "lookahead"
            or "lookbehind";
        }
    }
    // TODO: https://kildom.github.io/qre/docs.html#string-literal-alias
    end-of-text;
`;

class CRESemanticTokensProvider implements monaco.languages.DocumentSemanticTokensProvider {

    private builder = new TokensBuilder();
    private codeRegExp = new RegExp(codeRegExpProto);
    private commentRegExp = new RegExp(commentRegExpProto);
    private templateRegExp = new RegExp(templateRegExpProto);
    private creRegExp = new RegExp(creRegExpProto);
    private interpolationRegExp = new RegExp(interpolationRegExpProto);

    getLegend() {
        return legend;
    }

    provideDocumentSemanticTokens(model: monaco.editor.ITextModel, lastResultId: string | null, token: monaco.CancellationToken) {
        const lines = model.getLinesContent();
        this.builder.reset();

        let state: ParsingState = ParsingState.CODE;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            let backtickPos = line.indexOf('`');

            if ((state === ParsingState.CODE && backtickPos < 0 && line.indexOf('/*') < 0)
                || (state === ParsingState.COMMENT && line.indexOf('*/') < 0)
                || (state === ParsingState.TEMPLATE && backtickPos < 0)
            ) {
                continue;
            }

            let index = 0;
            let match: RegExpExecArray | null;

            do {
                switch (state) {
                    case ParsingState.CODE:
                        this.codeRegExp.lastIndex = index;
                        match = this.codeRegExp.exec(line);
                        index = this.codeRegExp.lastIndex;
                        if (match) {
                            state = this.parseCode(match);
                        }
                        break;
                    case ParsingState.COMMENT:
                        this.commentRegExp.lastIndex = index;
                        match = this.commentRegExp.exec(line);
                        index = this.commentRegExp.lastIndex;
                        if (match) {
                            state = ParsingState.CODE;
                        }
                        break;
                    case ParsingState.TEMPLATE:
                        this.templateRegExp.lastIndex = index;
                        match = this.templateRegExp.exec(line);
                        index = this.templateRegExp.lastIndex;
                        if (match) {
                            state = ParsingState.CODE;
                        }
                        break;
                    case ParsingState.CRE:
                        this.creRegExp.lastIndex = index;
                        match = this.creRegExp.exec(line);
                        index = this.creRegExp.lastIndex;
                        if (match) {
                            state = this.parseCRE(i, match);
                        }
                        break;
                    case ParsingState.INTERPOLATION:
                        this.interpolationRegExp.lastIndex = index;
                        match = this.interpolationRegExp.exec(line);
                        index = this.interpolationRegExp.lastIndex;
                        if (match) {
                            this.builder.add(i, match.index, match[0].length, TokenType.CLASS, TokenModifier.NONE);
                            state = ParsingState.CRE;
                        }
                        break;
                }
            } while (match);
        }
        return { data: this.builder.getData() };
    }

    parseCode(match: RegExpExecArray): ParsingState {
        let groups = match.groups as CodeRegExpGroups;
        if (groups.comment) {
            return ParsingState.COMMENT;
        } else if (groups.template) {
            return ParsingState.TEMPLATE;
        } else if (groups.qre) {
            return ParsingState.CRE;
        } else {
            return ParsingState.CODE;
        }
    }

    parseCRE(lineNumber: number, match: RegExpExecArray | null) {
        if (!match) return ParsingState.CRE;
        let groups = match.groups as CRERegExpGroups;
        if (groups.endCRE) {
            return ParsingState.CODE;
        } else if (groups.begin || groups.end || groups.separator) {
            this.builder.add(lineNumber, match.index, match[0].length, TokenType.OPERATOR, TokenModifier.NONE);
        } else if (groups.comment) {
            this.builder.add(lineNumber, match.index, match[0].length, TokenType.COMMENT, TokenModifier.NONE);
        } else if (groups.string) {
            this.builder.add(lineNumber, match.index, match[0].length, TokenType.STRING, TokenModifier.NONE);
        } else if (groups.characterClass) {
            this.builder.add(lineNumber, match.index, match[0].length, TokenType.METHOD, TokenModifier.NONE);
        } else if (groups.identifier) {
            this.builder.add(lineNumber, match.index, match[0].length, TokenType.LABEL, TokenModifier.NONE);
        } else if (groups.label) {
            this.builder.add(lineNumber, match.index, match[0].length, TokenType.LABEL, TokenModifier.NONE);
        } else if (groups.interpolation) {
            return ParsingState.INTERPOLATION;
        } else if (groups.keyword) {
            let keyword = groups.keyword.toLowerCase().replace(/\u2011/g, '-');
            let kg = keyword.match(keywordsRegExp)?.groups as KeywordsRegExpGroups | null;
            if (!kg) {
                this.builder.add(lineNumber, match.index, match[0].length, TokenType.COMMENT, TokenModifier.NONE);
            } else if (kg.quantifier || kg.operator) {
                this.builder.add(lineNumber, match.index, match[0].length, TokenType.KEYWORD, TokenModifier.NONE);
            } else if (kg.characterClass) {
                this.builder.add(lineNumber, match.index, match[0].length, TokenType.METHOD, TokenModifier.NONE);
            } else if (kg.assertion) {
                this.builder.add(lineNumber, match.index, match[0].length, TokenType.TYPE, TokenModifier.NONE);
            }
        }
        return ParsingState.CRE;
    }

    releaseDocumentSemanticTokens(resultId: string | undefined) {
    }
}

export function setupEditor(monacoModule: typeof monaco) {
    let provider = new CRESemanticTokensProvider();
    monacoModule.languages.registerDocumentSemanticTokensProvider("javascript", provider);
    monacoModule.languages.registerDocumentSemanticTokensProvider("typescript", provider);
}
