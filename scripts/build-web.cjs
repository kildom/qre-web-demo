const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const copyStaticFiles = require('esbuild-copy-static-files');

const workerEntryPoints = [
    'vs/language/json/json.worker.js',
    'vs/language/css/css.worker.js',
    'vs/language/html/html.worker.js',
    'vs/language/typescript/ts.worker.js',
    'vs/editor/editor.worker.js'
];

build({
    entryPoints: workerEntryPoints.map((entry) => `./node_modules/monaco-editor/esm/${entry}`),
    bundle: true,
    sourcemap: true,
    minify: true,
    target: ['es2020', 'chrome80', 'edge80', 'firefox78'],
    format: 'iife',
    outbase: './node_modules/monaco-editor/esm/',
    outdir: path.join(__dirname, '../dist'),
    metafile: true,
}, false, 'temp/web-monaco.json');

build({
    entryPoints: ['temp/worker.js'],
    bundle: true,
    sourcemap: true,
    minify: true,
    format: 'iife',
    outdir: path.join(__dirname, '../dist'),
    metafile: true,
}, false, 'temp/web-worker.json');

build({
    entryPoints: ['temp/index.jsx'],
    bundle: true,
    sourcemap: true,
    minify: true,
    format: 'iife',
    outdir: path.join(__dirname, '../dist'),
    metafile: true,
    loader: {
        '.ttf': 'file',
        '.svg': 'file',
        '.woff': 'file',
        '.woff2': 'file',
        '.eot': 'file',
    },
    plugins: [
        copyStaticFiles({
            src: 'static',
            dest: 'dist',
            dereference: true,
            errorOnExist: false,
            recursive: true,
        }),
        copyStaticFiles({
            src: 'node_modules/qre/dist/esm/qre.mjs',
            dest: 'dist/qre.mjs',
        })
    ],
}, true, 'temp/web-main.json');


async function build(opts, startServer, metaFileName) {
    /** @type {'s'| 'w'| ''} */
    let mode = (process.argv[2] || '').substring(0, 1).toLowerCase();
    let ctx = await esbuild.context(opts);
    if (startServer && mode === 's') {
        let result = await ctx.serve({
            host: '127.0.0.1',
            port: 8080,
            servedir: path.join(__dirname, '../dist'),
        });
        console.log('Server running on:');
        console.log(`    http://${result.host}:${result.port}/`);
    } else if (mode !== '') {
        await ctx.watch();
    } else {
        let result = await ctx.rebuild();
        if (result.errors.length > 0) {
            console.error(result.errors);
        }
        if (result.warnings.length > 0) {
            console.error(result.warnings);
        }
        if (!result.errors.length && !result.warnings.length) {
            console.log('Build done.');
        }
        ctx.dispose();
        if (!mode && metaFileName) {
            fs.mkdirSync(path.dirname(metaFileName), { recursive: true });
            fs.writeFileSync(metaFileName, JSON.stringify(result.metafile, null, 4));
        }
    }
}
