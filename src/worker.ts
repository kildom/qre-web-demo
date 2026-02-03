

import { WASI, WASIBindings, WASIExitError, WASIKillError } from '@wasmer/wasi';
import { WasmFs } from '@wasmer/wasmfs';
import path from 'path-browserify';

globalThis.Buffer = require('buffer/').Buffer as any;
globalThis.global = globalThis;
globalThis.process = globalThis.process || {} as any;

/*globalThis.Buffer = {
    from: function from(data, encoding) {
        if (encoding === 'ascii') {
            return new TextEncoder().encode(data);
        }
        let bin = atob(data);
        return new Uint8Array([...bin].map(x => x.charCodeAt(0)));
    }
} as any;*/


import { deflateSync, inflateSync } from 'fflate';
import { CompressMessage, ExecuteMessage, RunStatus, WorkerMessage, WorkerProgress, WorkerResponse } from './shared.js';

const WASM_URL = './js.wasm';
const WASMER_SDK = './diswasmer_js_bg.wasm';

const dictionaryText = "JSON.stringify(.parse( RegExp(.input(.lastMatch(.lastParen(.leftContext(.rightContext(.compile(.exec(.test(.toString(.replace(.match(.matchAll(;\n                                // `;\n\n    \n\nconsole.log(\n\nconst \n\nlet undefined \n\nvar \n\nif (\n\nfor (\n\nwhile (\n\nswitch (    case of in instanceof new true false do {\n    this. break;\n return    } else {\n        } or {\n        ) {\n        }\n);\n\n`;\n\n';\n\n\";\n\n/* */\n\n// = + - * / || && += -= *= ++;\n --;\n == === !== != >= <= < > ?? & | ~ ^ << >> >>> ... \nimport qre from 'qre';\n\nimport qre from \"qre\";\n\n = qre`.indices`.global`.ignoreCase`.legacy`.unicode`.sticky`.cache`optional begin-of-text; end-of-text; begin-of-line; end-of-line; word-boundary; repeat at-least-1 at-most-times -to- not new-line; line-feed; carriage-return; tabulation; null; space; any; digit; white-space; whitespace; word-character; line-terminator; prop< property< lookahead look-ahead lookbehind look-behind group \"${}\" '${}' ${ ";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const dictionary = encoder.encode(JSON.stringify(dictionaryText));

onmessage = async (event) => {
    let message = event.data as WorkerMessage;
    try {
        switch (message.type) {
            case 'compress':
                compressMessage(message);
                break;
            case 'decompress':
                decompressMessage(message);
                break;
            case 'execute':
                await executeMessage(message);
                break;
        }
    } catch (err) {
        console.warn(err);
        response({
            type: 'error',
            mid: message.mid || 0,
            message: err.message || 'Unknown exception',
        });
    }
};

function response(res: WorkerResponse) {
    postMessage(res);
}

function progress(res: WorkerProgress) {
    res.mid = -Math.abs(res.mid);
    postMessage(res);
}

function compressMessage(message: CompressMessage) {
    let output = deflateSync(message.input, { level: 9, dictionary, mem: 7 });
    console.log('Compress', message.input.length, output.length);
    response({
        type: 'compress',
        mid: message.mid || 0,
        output,
    });
}

function decompressMessage(message: CompressMessage) {
    let output = inflateSync(message.input, { dictionary });
    console.log('Decompress', message.input.length, output.length);
    response({
        type: 'decompress',
        mid: message.mid || 0,
        output,
    });
}

let jsModule: WebAssembly.Module | undefined = undefined;
let creSource = '';
let stubSource = '';
let stdio: StandardIO;

let wasmFs = new WasmFs();

(wasmFs.fs as any)._oldWriteSync = wasmFs.fs.writeSync;
wasmFs.fs.writeSync = function(fd: number, buffer: Buffer | Uint8Array | string, offset?: number, length?: number, position?: number): number {
    if ((fd == 1 || fd == 2) && !position && length !== 0 && typeof(buffer) === 'object') {
        stdio.write(fd, buffer, offset, length);
        return length || buffer.length;
    } else {
        return (wasmFs.fs as any)._oldWriteSync(fd, buffer, offset, length, position);
    }
} as any;


const bindings: WASIBindings = {
    hrtime: function (): bigint {
        return BigInt(Math.round(performance.now() * 1000000));
    },
    exit: function (rval: number): void {
        throw new WASIExitError(rval);
    },
    kill: function (signal: string): void {
        throw new WASIKillError(signal);
    },
    randomFillSync: function <T>(buffer: T, offset: number, size: number): T {
        let part = new Uint8Array((buffer as ArrayBufferView).buffer, (buffer as ArrayBufferView).byteOffset + offset, size);
        if (crypto && crypto.getRandomValues) {
            crypto.getRandomValues(part);
        } else {
            for (let i = 0; i < size; i++) {
                part[i] = Math.floor(Math.floor(Math.random() * 256));
            }
        }
        return buffer;
    },
    isTTY: () => false,
    fs: null,
    path: path,
};

class StandardIO {
    private chunks: string[] = [];
    private data = new Uint8Array(256);
    private dataLength = 0;
    public write(fd: number, input: Buffer | Uint8Array, offset: number = 0, length?: number) {
        if (length === undefined || length === null) length = input.length - offset;
        if (length <= 0) return;
        if (!((fd ^ this.chunks.length) & 1)) {
            this.finishChunk();
        }
        let part = new Uint8Array(input.buffer, input.byteOffset + offset, length);
        if (this.dataLength + length > this.data.length) {
            let newLength = Math.round(1.5 * (this.dataLength + length));
            let old = this.data;
            this.data = new Uint8Array(newLength);
            this.data.set(old);
        }
        this.data.set(part, this.dataLength);
        this.dataLength += part.length;
    }
    public getChunks(): string[] {
        if (this.data.length > 0) {
            this.finishChunk();
        }
        return this.chunks;
    }
    private finishChunk() {
        this.chunks.push(decoder.decode(this.data.subarray(0, this.dataLength)));
        this.dataLength = 0;
    }
}

async function executeMessage(message: ExecuteMessage) {

    let firstRun = !jsModule;
    if (!jsModule) {
        progress({
            type: 'execute-progress',
            mid: message.mid || 0,
            status: RunStatus.DOWNLOADING,
        });
        let jsModulePromise = WebAssembly.compileStreaming(fetch(WASM_URL));
        let creSourceRequestPromise = fetch('./qre.mjs');
        let stubSourceRequestPromise = fetch('./console-stub.mjs');
        let creSourcePromise = (await creSourceRequestPromise).text();
        let stubSourcePromise = (await stubSourceRequestPromise).text();
        jsModule = await jsModulePromise;
        creSource = await creSourcePromise;
        stubSource = await stubSourcePromise;
    }

    progress({
        type: 'execute-progress',
        mid: message.mid || 0,
        status: RunStatus.LOADING,
    });

    stdio = new StandardIO();

    let wasi = new WASI({
        args: [
            'js.wasm',
            '-f', '/wrapper.js',
            '--selfhosted-xdr-path=/selfhosted.bin',
            `--selfhosted-xdr-mode=${firstRun ? 'encode' : 'decode'}`],
        preopens: { '/': '/' },
        env: {},
        bindings: {
            ...bindings,
            fs: wasmFs.fs,
        },
    });

    let instance = await WebAssembly.instantiate(jsModule, wasi.getImports(jsModule));

    let fileName = message.name;
    if (fileName === 'console-stub.mjs' || fileName === 'wrapper.js') {
        fileName = 'input-' + fileName;
    }
    fileName = fileName.replace(/[^a-z0-9_.-]/gi, '_');

    if (firstRun) {
        wasmFs.fs.writeFileSync('/console-stub.mjs', stubSource);
    }






    wasmFs.fs.writeFileSync('/wrapper.js', `
        function getModule(source, fileName) {
            try {
                let stencil = compileToStencil(source, { module: true, fileName });
                return instantiateModuleStencil(stencil);
            } catch (e) {
                if (e instanceof SyntaxError) {
                    printErr(e.toString());
                    printErr(\`\${e.fileName}:\${e.lineNumber}:\${e.columnNumber}\`);
                }
                return null;
            }
        }







        mainMod = getModule(\`
            globalThis.console = (await import("/console-stub.mjs")).console;
            try{
                await import("/" + ${JSON.stringify(fileName)});
            } catch(e) {
                if (e instanceof SyntaxError) {
                    printErr(e.toString());
                    printErr(\\\`\\\${e.fileName}:\\\${e.lineNumber}:\\\${e.columnNumber}\\\`);
                } else {
                    printErr(e.toString());
                    printErr("stack:");
                    printErr("    " + e.stack.replace(/(\\\\r?\\\\n)/g, "$1    "));
                }
            }\`, '/_startup.mjs');
        creMod = getModule(${JSON.stringify(creSource)}, '/qre.mjs');
        registerModule('qre', creMod);
        moduleLink(mainMod);
        moduleEvaluate(mainMod);
    `);
    wasmFs.fs.writeFileSync('/' + fileName, message.code);

    wasmFs.volume.fds[1].position = 0;
    wasmFs.volume.fds[2].position = 0;
    wasmFs.fs.writeFileSync('/dev/stdout', "");
    wasmFs.fs.writeFileSync('/dev/stderr', "");

    progress({
        type: 'execute-progress',
        mid: message.mid || 0,
        status: RunStatus.RUNNING,
    });

    try {
        wasi.start(instance);
    } catch (err) {
        if (err instanceof WASIExitError) {
            stdio.write(2, encoder.encode(`Exit code: ${err.code}\n\n`));
        } else {
            stdio.write(2, encoder.encode(`Unexpected exception: ${err.message}\n\n`));
        }
    }

    stdio.write(1, wasmFs.fs.readFileSync('/dev/stdout') as any);
    stdio.write(2, wasmFs.fs.readFileSync('/dev/stderr') as any);

    response({
        type: 'execute',
        mid: message.mid || 0,
        compileMessages: '',
        stdio: stdio.getChunks(),
        fileName: '/' + fileName,
    });
}

