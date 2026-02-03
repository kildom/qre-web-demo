
import * as fs from 'node:fs';
import * as path from 'node:path';
import {LICENSES} from './additional-licenses';

const DEBUG = false;

const thisModuleName = 'qre-web-demo';

interface Metafile {
    inputs: {
        [path: string]: {
            bytes: number
            imports: {
                path: string
                kind: string
                external?: boolean
                original?: string
                with?: Record<string, string>
            }[]
            format?: string
            with?: Record<string, string>
        }
    }
    outputs: {
        [path: string]: {
            bytes: number
            inputs: {
                [path: string]: {
                    bytesInOutput: number
                }
            }
            imports: {
                path: string
                kind: string
                external?: boolean
            }[]
            exports: string[]
            entryPoint?: string
            cssBundle?: string
        }
    }
}

interface LicenseResolved {
    licenses: string,
    repository?: string,
    publisher?: string,
    email?: string,
    url?: string,
    paths: Set<string>,
    files: string[],
    licenseFile: string,
    licenseText: string,
    modules: Set<string>,
    priority: number,
}

interface LicenseCheckerEntry {
    licenses: string,
    repository?: string,
    publisher?: string,
    email?: string,
    url?: string,
    path: string,
    licenseFile: string,
    realPath: string,
    moduleName: string,
    resolved?: LicenseResolved,
    priority?: number,
}

const licenseCheckerFile = process.argv[2];
const outputFile = process.argv[3];
const buildMetaFiles = process.argv.slice(4);

type LicenseChecker = { [moduleName: string]: LicenseCheckerEntry };

let resolved: LicenseResolved[] = [];

if (!licenseCheckerFile || !buildMetaFiles.length || !outputFile) {
    console.error('USAGE: gen-licenses.ts license-checker-json esbuild-meta-file output-text-file');
}

let licenseChecker = JSON.parse(fs.readFileSync(licenseCheckerFile, 'utf-8')) as LicenseChecker;

if (DEBUG) {
    console.log('license-checker modules:');
    console.log(Object.keys(licenseChecker).join('\n'));
}

let buildMeta: Metafile = { inputs: {}, outputs: {} };
for (let buildMetaFile of buildMetaFiles) {
    let m = JSON.parse(fs.readFileSync(buildMetaFile, 'utf-8')) as Metafile;
    if (DEBUG) {
        console.log(`${buildMetaFile} build inputs:`);
        let all = new Set([].concat(...Object.values(m.outputs).map(o => Object.keys(o.inputs)) as any));
        console.log([...all].join('\n'));
    }
    buildMeta.inputs = {...buildMeta.inputs, ...m.inputs};
    buildMeta.outputs = {...buildMeta.outputs, ...m.outputs};
}

for (let [moduleName, info] of Object.entries(licenseChecker)) {
    info.realPath = fs.realpathSync(info.path);
    info.moduleName = moduleName;
}

for (let info of Object.values(licenseChecker)) {
    if (info.moduleName.startsWith(thisModuleName + '@')) {
        let content;
        try {
            content = fs.readFileSync('package.json', 'utf-8');
        } catch (e) {
            content = fs.readFileSync('../package.json', 'utf-8')
        }
        info.licenses = JSON.parse(content).license;
    }
}

licenseChecker = Object.fromEntries(Object.entries(licenseChecker).sort((a, b) => b[1].realPath.length - a[1].realPath.length));

if (DEBUG) {
    console.log('license-checker paths:');
    console.log(Object.values(licenseChecker).map(info => `${info.moduleName} => ${info.realPath}`).join('\n'));
}

let allInputs = new Set<string>();

for (let output of Object.values(buildMeta.outputs)) {
    for (let file of Object.keys(output.inputs)) {
        allInputs.add(file);
    }
}

if (DEBUG) {
    console.log('all inputs:');
    console.log([...allInputs].join('\n'));
    console.log('assignments:');
}

outher_loop:
for (let file of allInputs) {
    let pos = file.indexOf('?');
    if (pos >= 0) {
        file = file.substring(0, pos);
    }
    let realPath = fs.realpathSync(file);
    for (let info of Object.values(licenseChecker)) {
        if (realPath.startsWith(info.realPath)) {
            assign(info, file);
            if (DEBUG) console.log(`${realPath} => ${info.moduleName}`);
            continue outher_loop;
        }
    }
    console.error(`Unknown license for "${file}!`);
    process.exit(1);
}

resolved.sort((a, b) => b.priority - a.priority);

resolved.push(...LICENSES as LicenseResolved[]);

let text = '';

for (let info of resolved) {
    text += '\n===============================================================================\n\n';
    text += `Module:     ${[...info.modules].join(', ')}\n`;
    text += `License:    ${info.licenses}\n`;
    if (info.publisher && info.email)
        text += `Publisher:  ${info.publisher} <${info.email}>\n`;
    else if (info.publisher)
        text += `Publisher:  ${info.publisher}\n`;
    else if (info.email)
        text += `E-mail:     ${info.email}\n`;
    if (info.repository)
        text += `Repository: ${info.repository}\n`;
    if (info.url)
        text += `URL:        ${info.url}\n`;
    text += `License text:\n${info.licenseText.trimEnd()}\n`;
}

if (!outputFile.toLowerCase().endsWith('.txt')) {
    let cssName = path.basename(outputFile.substring(0, outputFile.length - path.extname(outputFile).length)) + '.css';
    text = `
    <html><link rel="stylesheet" href="${cssName}" /><body><pre>${
    text
        .trim()
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}
    </pre></body></html>
    `;
}

fs.writeFileSync(outputFile, text);

function assign(info: LicenseCheckerEntry, file: string) {
    if (info.resolved) {
        info.resolved.files.push(file);
        return;
    }
    let licenseText = fs.readFileSync(info.licenseFile, 'utf8');
    for (let res of resolved) {
        if (res.licenseText === licenseText
            && res.licenses === info.licenses
            && res.publisher === info.publisher
            && res.email === info.email
            && res.repository === info.repository
            && res.url === info.url
        ) {
            info.resolved = res;
            res.files.push(file);
            res.modules.add(info.moduleName);
            res.paths.add(info.path);
            return;
        }
    }
    let res: LicenseResolved = {
        files: [file],
        licenseFile: info.licenseFile,
        licenses: info.licenses,
        licenseText,
        modules: new Set([info.moduleName]),
        paths: new Set([info.path]),
        publisher: info.publisher,
        email: info.email,
        repository: info.repository,
        url: info.url,
        priority: info.priority || 0,
    };
    resolved.push(res);
}

