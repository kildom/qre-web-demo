

import * as monaco from 'monaco-editor';//esm/vs/editor/editor.main.js';

import { Alignment, Button, ContextMenu, Dialog, DialogBody, DialogFooter, Icon, InputGroup, Intent, Menu, MenuDivider, MenuItem, Navbar, OverlayToaster, Popover, Spinner, Tab, TabId, Tabs, Toaster } from '@blueprintjs/core';
import React, { useCallback } from 'react';
import ReactDOM from 'react-dom';
import * as db from './db.js';
import { CompressMessage, CompressResponse, ExecuteProgress, ExecuteResponse, RunStatus, WorkerMessage, WorkerProgress, WorkerResponse } from './shared.js';
import { qre } from 'qre';


import 'normalize.css/normalize.css';
import '@blueprintjs/core/lib/css/blueprint.css';
import '@blueprintjs/icons/lib/css/blueprint-icons.css';
import { setupEditor } from './extensions.js';


const INITIAL_FILE = 'Intro.js';
const INITIAL_CONTENT = `
let x;// TODO: put some intro here
`;

interface FileState {
    readonly id: number;
    readonly name: string;
    readonly mutable: {
        content: string | monaco.editor.ITextModel;
        viewState?: monaco.editor.ICodeEditorViewState;
        dirty: boolean;
    };
}

interface RecentFile {
    name: string;
    time: number;
}

enum DialogType {
    NONE,
    ABOUT,
    LICENSE,
}

interface State {
    readonly selectedFileId: number;
    readonly files: FileState[];
    readonly renaming: boolean;
    readonly status: string;
    readonly showDialog: DialogType;
    readonly recent: RecentFile[];
    readonly mutable: {
        storageVersion: number;
        closedIds: number[];
    }
}

(self as any).MonacoEnvironment = {
    getWorkerUrl: function (moduleId, label) {
        if (label === 'json') {
            return './vs/language/json/json.worker.js';
        }
        if (label === 'css' || label === 'scss' || label === 'less') {
            return './vs/language/css/css.worker.js';
        }
        if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return './vs/language/html/html.worker.js';
        }
        if (label === 'typescript' || label === 'javascript') {
            return './vs/language/typescript/ts.worker.js';
        }
        return './vs/editor/editor.worker.js';
    }
};

monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
});

monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
});

let initialState: State = {
    selectedFileId: 0,
    files: [],
    renaming: false,
    status: '',
    showDialog: DialogType.NONE,
    recent: [
        {
            name: 'Untitled-123.js',
            time: Date.now() - 1000000,
        },
        {
            name: 'Other file.js',
            time: Date.now() - 5000000,
        },
        {
            name: 'Some older.js',
            time: Date.now() - 15000000,
        },
    ],
    mutable: {
        closedIds: [],
        storageVersion: -1,
    }
};

let lastFileId: number = 10;

let curState: State | undefined = undefined;
let tempState: State | undefined = undefined;
let setStateReal: React.Dispatch<React.SetStateAction<State>>;

function setState(state: State) {
    if (tempState) {
        if (state === tempState) return; // ignore - this is recently set state
    } else {
        if (state === curState) return; // ignore - this is current state
    }
    tempState = state;
    setStateReal(state);
}

function getState(): State {
    if (!curState) {
        throw new Error('State not ready');
    }
    return tempState || curState;
}

function tabSelected(newTabId: number, prevTabId: undefined | number) {
    storeEditorFile();
    let state = getState();
    setState({ ...state, selectedFileId: newTabId });
    restoreEditorFile();
    renameDone();
};

function formatDate(time: number | Date): string {
    if (typeof time !== 'number') {
        time = time.getTime();
    }
    return Math.round((Date.now() - time) / 1000).toString();
}

async function fileClosed(id: number) {
    await delay(10);
    let state = getState();
    disposeEditorFile(state.files.find(file => file.id === id));
    let selected = state.files.find(file => file.id !== id)!.id;
    for (let file of state.files) {
        if (file.id === id) break;
        selected = file.id;
    }
    state = { ...state, selectedFileId: selected, files: state.files.filter(file => file.id !== id) };
    state.mutable.closedIds.push(id);
    setState(state);
    restoreEditorFile();
    renameDone();
    dbSynchronizeRequest();
    updateAddress();
}

function languageFromName(name: string): string {
    let ext = '';
    let m = name.match(/\.([a-z]+)$/);
    if (m) {
        ext = m[1].toLowerCase();
    }
    return extensions[ext] || 'javascript';
}

function restoreEditorFile() {
    let state = getState();
    let id = state.selectedFileId;
    let file = state.files.find(file => file.id === id) as FileState;
    let language = languageFromName(file.name);
    let model: monaco.editor.ITextModel;
    if (typeof file.mutable.content === 'string') {
        model = monaco.editor.createModel(file.mutable.content, language);
        file.mutable.content = model;
    } else {
        model = file.mutable.content;
    }
    editor.setModel(null);
    editor.setModel(model);
    editor.setValue(editor.getValue());
    if (file.mutable.viewState) {
        editor.restoreViewState(file.mutable.viewState);
    }
    editor.focus();
    setTimeout(() => editor?.focus(), 50);
}

function storeEditorFile() {
    if (editor === undefined) {
        return;
    }
    let state = getState();
    let id = state.selectedFileId;
    let file = state.files.find(file => file.id === id) as FileState;
    let model = editor.getModel();
    file.mutable.content = model || editor.getValue();
    file.mutable.viewState = editor.saveViewState() || undefined;
}

function disposeEditorFile(file?: FileState) {
    if (file) {
        if (typeof file.mutable.content !== 'string') {
            file.mutable.content.dispose();
        }
        file.mutable.content = '';
        file.mutable.viewState = undefined;
    }
}

function renameStart(file: FileState) {
    let state = getState();
    if (state.selectedFileId !== file.id) {
        return;
    }
    setTimeout(() => {
        let state = getState();
        if (state.selectedFileId !== file.id) {
            return;
        }
        setState({ ...state, renaming: true })
    }, 100);
}

function renameUpdate(text: string) {
    let state = getState();
    setState({ ...state, files: state.files.map(file => file.id !== state.selectedFileId ? file : { ...file, name: text }) });
}

function renameDone() {
    let state = getState();
    setState({ ...state, renaming: false });
    let file = state.files.find(file => file.id === state.selectedFileId) as FileState;
    let name = file.name.trim();
    if (name === '') {
        name = 'Untitled';
    }
    if (name !== file.name) {
        renameUpdate(name);
    }
    let language = languageFromName(name);
    if (typeof file.mutable.content !== 'string' && language !== file.mutable.content.getLanguageId()) {
        monaco.editor.setModelLanguage(file.mutable.content, language);
    }
    file.mutable.dirty = true;
    dbSynchronizeRequest();
    updateAddress();
}

const NEW_FILE_TEMPLATE = `
// Import Quick Regular Expressions
import qre from "qre";

const yourExpression = qre\`\`;
`;

function newFile(ext: string) {
    let state = getState();
    let names = new Set(state.files.map(file => file.name));
    let fileName = `Untitled.${ext}`;
    let index = 2;
    while (names.has(fileName)) {
        fileName = `Untitled (${index}).${ext}`;
        index++;
    }
    let file: FileState = {
        id: generateFileId(state),
        name: fileName,
        mutable: {
            content: NEW_FILE_TEMPLATE,
            dirty: true,
        }
    }
    setState({ ...state, files: [...state.files, file] });
    tabSelected(file.id, state.selectedFileId);
    dbSynchronizeRequest();
    updateAddress();
}

async function toDataURL(data, type) {
    return await new Promise(r => {
        const reader = new FileReader();
        reader.onload = () => r(reader.result);
        reader.readAsDataURL(new File([data], 'file', { type }));
    });
}

function toBase64(data: Uint8Array): Promise<string> {
    return new Promise<string>(r => {
        const reader = new FileReader();
        reader.onload = () => {
            let url = reader.result as string;
            let pos = url.indexOf('base64,') + 7;
            r(url.substring(pos));
        };
        reader.readAsDataURL(new Blob([data]));
    });
}

async function fromBase64(data: string): Promise<Uint8Array> {
    const res = await fetch('data:application/octet-stream;base64,' + data);
    return new Uint8Array(await res.arrayBuffer());
}

let worker = new Worker('./worker.js', { name: 'Executor-Compiler-Compressor' });
worker.onmessage = workerOnmessage;
let workerWaitingPromises: {
    mid: number,
    resolve: (value: WorkerResponse | PromiseLike<WorkerResponse>) => void,
    reject: (reason: any) => void,
    progress?: (msg: WorkerProgress) => void
}[] = [];
let workerLastMessageId = 0;
let encoder = new TextEncoder();
let decoder = new TextDecoder();

function killWorker() {
    worker.terminate();
    worker = new Worker('./worker.js', { name: 'Executor-Compiler-Compressor' });
    worker.onmessage = workerOnmessage;
    let arr = workerWaitingPromises;
    workerWaitingPromises = [];
    for (let item of arr) {
        item.reject(new WorkerBlockedError('Worker execution timeout reached'));
    }
}

async function sendWithResponse<T>(message: WorkerMessage, progress?: (msg: WorkerProgress) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let mid = ++workerLastMessageId
        message.mid = mid;
        workerWaitingPromises.push({ mid, resolve: resolve as any, reject, progress });
        worker.postMessage(message);
    });
}

function workerAsyncResponse(message: WorkerResponse | WorkerProgress) {
    console.warn('Unknown', message);
}

function workerOnmessage(event) {
    let response = event.data as WorkerResponse | WorkerProgress;
    let isProgress = response.mid < 0;
    let mid = Math.abs(response.mid);
    let index = workerWaitingPromises.findIndex(entry => entry.mid === mid);
    if (index < 0) {
        workerAsyncResponse(response);
    } else {
        if (response.type === 'error') {
            let promiseInfo = workerWaitingPromises.splice(index, 1)[0];
            promiseInfo.reject(new Error(response.message));
        } else if (isProgress) {
            let promiseInfo = workerWaitingPromises[index];
            promiseInfo.progress?.(response as WorkerProgress);
        } else {
            let promiseInfo = workerWaitingPromises.splice(index, 1)[0];
            promiseInfo.resolve(response as WorkerResponse);
        }
    }
};

class WorkerBlockedError extends Error { }

let currentAddressKey = '';
let currentAddressHash = '';


async function updateAddress(stateParam?: State) {
    let state = stateParam || getState();
    let file = state.files.find(file => file.id === state.selectedFileId);
    if (!file) return;
    let textData = file.name + '\0' + getFileContent(file);
    if (textData === currentAddressKey) return;
    currentAddressKey = textData;
    let data = encoder.encode(textData);
    try {
        let response = await sendWithResponse<CompressResponse>({
            type: 'compress',
            input: data,
            version: 2,
        });
        let hash = '#2' + await toBase64(response.output);
        currentAddressHash = hash;
        history.replaceState(null, '', hash);
    } catch (err) {
        currentAddressKey = '';
        if (err instanceof WorkerBlockedError) {
            setTimeout(() => updateAddress(), 100);
        } else {
            throw err;
        }
    } finally {
        runScript();
    }
}

let pendingRun = false;
let runningPromise: Promise<ExecuteResponse> | undefined = undefined;


let killTimeout = setTimeout(() => { }, 0);

function setKillTimeout(timeout: number) {
    clearTimeout(killTimeout);
    killTimeout = setTimeout(() => {
        killWorker();
    }, timeout);
}

function stopKillTimeout() {
    clearTimeout(killTimeout);
}

function runningCallback(progress: ExecuteProgress) {
    console.log(progress.status);
    switch (progress.status) {
        case RunStatus.DOWNLOADING:
            setKillTimeout(30000);
            showOutput(['Downloading modules...']);
            break;
        case RunStatus.COMPILING:
            setKillTimeout(3000);
            showOutput(['Compiling TypeScript...']);
            break;
        case RunStatus.LOADING:
            setKillTimeout(1000);
            showOutput(['Loading script...']);
            break;
        case RunStatus.RUNNING:
            setKillTimeout(5000);
            showOutput(['Running script...']);
            break;
    }
}

async function runScript() {
    while (!curState) {
        await new Promise(r => setTimeout(r, 100));
    }
    if (pendingRun) return;
    while (runningPromise) {
        pendingRun = true;
        try {
            await runningPromise;
        } catch (err) { }
        pendingRun = false;
    }
    let state = getState();
    let file = state.files.find(file => file.id === state.selectedFileId) as FileState;
    let content = getFileContent(file);
    try {
        runningPromise = sendWithResponse<ExecuteResponse>({
            type: 'execute',
            name: file.name,
            typescript: languageFromName(file.name) === 'typescript',
            code: content,
        }, runningCallback);
        try {
            setKillTimeout(5000);
            let response = await runningPromise;
            if (response.compileMessages.length) {
                showOutput(['', response.compileMessages, ...response.stdio], response.fileName);
            } else {
                showOutput(response.stdio, response.fileName);
            }
        } catch (err) {
            if (err instanceof WorkerBlockedError) {
                showOutput(['', 'Execution takes too long. Terminated!']);
            } else {
                throw err;
            }
        } finally {
            stopKillTimeout();
        }
    } catch (e) {
        showOutput(['', 'Unexpected error: ' + e.message]);
    } finally {
        runningPromise = undefined;
    }
}


function getFileContent(file: FileState): string {
    return typeof (file.mutable.content) === 'string' ? file.mutable.content : file.mutable.content.getValue();
}

function openFileWithContent(name: string, content: string) {
    let initial = !curState;
    let state = initial ? initialState : getState();
    let index = state.files.findIndex(file => getFileContent(file).trim() === content.trim());
    let file: FileState;
    if (index >= 0) {
        file = state.files[index];
    } else {
        file = {
            id: generateFileId(state),
            name: name,
            mutable: {
                content: content,
                dirty: true,
            },
        };
        state = { ...state, files: state.files.concat([file]) };
    }
    if (initial) {
        initialState = { ...state, selectedFileId: file.id };
    } else {
        setState(state);
        tabSelected(file.id, 0);
    }
}

async function readFromHash(): Promise<void> {
    try {
        let hash = location.hash;
        if (hash === currentAddressHash) return;
        currentAddressHash = hash;
        if (hash.length < 3) return;
        let version = hash.substring(1, 2);
        if (version !== '1' && version !== '2') throw new Error('Invalid format.');
        let data = await fromBase64(hash.substring(2));
        let response = await sendWithResponse<CompressResponse>({
            type: 'decompress',
            input: data,
            version: parseInt(version),
        });
        let textData = decoder.decode(response.output);
        if (version === '1') {
            textData = textData
                .replace(/cre/g, 'qre')
                .replace(/con-reg-exp/g, 'qre')
                .replace(/Convenient/g, 'Quick');
        }
        let index = textData.indexOf('\0');
        openFileWithContent(textData.substring(0, index), textData.substring(index + 1));
    } catch (err) {
        mainToaster.show({ message: (<>Cannot decode input URL.<br /><br />{`${err.message}`}</>), intent: Intent.DANGER, icon: 'error' });
    }
};


onhashchange = () => {
    readFromHash();
    currentAddressKey = '';
    updateAddress();
};

let mainToaster: Toaster;

async function copyAddress() {
    let addr = location.href;
    let index = addr.indexOf('#');
    if (index >= 0) {
        addr = addr.substring(0, index);
    }
    addr += currentAddressHash;
    let ok = false;
    try {
        let input = document.getElementById('clipboardWorkspace') as HTMLInputElement;
        input.value = addr;
        input.select();
        document.execCommand('copy');
        ok = true;
    } catch (e) { }
    try {
        await navigator.clipboard.writeText(addr);
        ok = true;
    } catch (e) {
        try {
            await navigator.permissions.query({ name: 'clipboard-write' as any });
            await navigator.clipboard.writeText(addr);
            ok = true;
        } catch (e) { }
    }
    if (ok) {
        mainToaster.show({
            message: (
                <>Address copied to the clipboard.<br />
                    You can paste it now anywhere to share the code.</>
            ), intent: Intent.SUCCESS, icon: 'clipboard', timeout: 3000
        });
    } else {
        mainToaster.show({
            message: (
                <>Cannot copy to clipboard.<br />Copy address bar manually.</>
            ), intent: Intent.DANGER, icon: 'error', timeout: 15000
        });
    }
}

function App() {
    let arr = React.useState<State>({ ...initialState });
    let state = arr[0];
    setStateReal = arr[1];
    curState = state;
    tempState = undefined;
    //console.log(state);
    updateAddress(state);
    return (
        <>
            <div className="bottons">
                <Navbar>
                    <Navbar.Group align={Alignment.LEFT}>
                        <Navbar.Heading><span style={{ fontSize: '85%' }}><a href="https://kildom.github.io/qre/" target="_blank">Quick Regular Expressions</a><br />Web Demo</span></Navbar.Heading>
                        <Navbar.Divider />
                        <Popover placement="bottom" content={
                            <Menu large={true}>
                                <MenuItem text="JavaScript" icon="add" onClick={() => newFile('js')} />
                                <MenuItem text="TypeScript" icon="add" onClick={() => newFile('ts')} />
                            </Menu>
                        }>
                            <Button minimal={true} icon="add" text="New" rightIcon="caret-down" />
                        </Popover>
                        <Popover placement="bottom" content={
                            <Menu large={true}>
                                <MenuItem text="number.js" icon="document" label="Match JS floating point number" labelClassName='menu-label' />
                                <MenuItem text="json-array.js" icon="document" label="Match JSON array of numbers" labelClassName='menu-label' />
                                <MenuItem text="ipv4-address.js" icon="document" label="Match IPv4 address" labelClassName='menu-label' />
                                <MenuItem text="time.js" icon="document" label="Match time in both 12 and 24-hour format" labelClassName='menu-label' />
                            </Menu>
                        }>
                            <Button minimal={true} text="Samples" icon="code" rightIcon="caret-down" />
                        </Popover>
                        <Popover placement="bottom" content={
                            <Menu large={true}>
                                <MenuItem text="Open tutorial" icon="share" label="Go to tutorial page first" labelClassName='menu-label' intent='primary' />
                                <MenuDivider />
                                <MenuItem text="tutorial-1.js" icon="document" label="Simples expression" labelClassName='menu-label' />
                                <MenuItem text="tutorial-1a.js" icon="document" label="Simple expression with character class" labelClassName='menu-label' />
                            </Menu>
                        }>
                            <Button minimal={true} text="Tutorial" icon="learning" rightIcon="caret-down" />
                        </Popover>
                        <Popover placement="bottom" content={
                            <Menu large={true}>
                                <MenuItem text="From URL" icon="text-highlight" />
                                <MenuItem text="Local File" icon="folder-shared" />
                                <MenuItem text="Recently closed" icon="history">
                                    {state.recent.map(item => (
                                        <MenuItem text={item.name} icon="document" label={formatDate(item.time)} labelClassName='menu-label' />
                                    ))}
                                </MenuItem>
                            </Menu>
                        }>
                            <Button minimal={true} icon="folder-open" text="Open" rightIcon="caret-down" />
                        </Popover>
                        <Button minimal={true} icon="share" text="Share" onClick={copyAddress} />
                        <Button minimal={true} icon="download" text="Download" />
                        <Navbar.Divider />
                    </Navbar.Group>
                    <Navbar.Group align={Alignment.RIGHT}>
                        <Button minimal={true} icon="help" text="About" onClick={() => setState({ ...state, showDialog: DialogType.ABOUT })} />
                    </Navbar.Group>
                </Navbar>
            </div>
            <div className="tabs">
                <Tabs selectedTabId={state.selectedFileId} large={true}
                    onChange={tabSelected}>
                    {state.files.map(file =>
                        (state.renaming && file.id === state.selectedFileId) ? (
                            <InputGroup onKeyUp={key => key.key === 'Enter' || key.key === 'Escape' ? renameDone() : null} inputClassName='file-name-input' style={{ width: `calc(25px + ${file.name.length}ch)` }} large={true} autoFocus={true} value={file.name} onValueChange={text => renameUpdate(text)} onBlur={() => renameDone()} />
                        ) : (
                            <Tab id={file.id} onMouseUp={() => renameStart(file)}>  {file.name} {state.files.length > 1 ? (
                                <Icon icon="small-cross" className='close-icon' onClick={() => fileClosed(file.id)} />
                            ) : ' '}</Tab>
                        ))}
                </Tabs>
            </div>
            <Dialog title="About Quick Regular Expressions" icon="help" isOpen={state.showDialog === DialogType.ABOUT} onClose={() => setState({ ...state, showDialog: DialogType.NONE })}>
                <DialogBody>
                    <p>The <b><i>Quick Regular Expressions</i></b> give a different approach to a regular expressions syntax. The main goal is to provide a syntax that is more manageable in complex regular expressions. It looks more like actual program source code with clearly visible structure, comments, and meaning.</p>
                    <p>See the following pages to learn more:</p>
                    <ul>
                        <li><a href="https://kildom.github.io/qre/" target="_blank">Website</a></li>
                        <li><a href="https://kildom.github.io/qre/tutorial.html" target="_blank">Tutorial</a></li>
                        <li><a href="https://kildom.github.io/qre/docs.html" target="_blank">Documentation</a></li>
                        <li><a href="https://kildom.github.io/qre/cheat-sheet.html" target="_blank">Cheat Sheet</a></li>
                        <li><a href="https://github.com/kildom/qre/" target="_blank">GitHub repository</a></li>
                    </ul>
                </DialogBody>
                <DialogFooter actions={<>
                    <Button text="License information" onClick={() => setState({ ...state, showDialog: DialogType.LICENSE })} />
                    <Button intent="primary" text="  Close  " onClick={() => setState({ ...state, showDialog: DialogType.NONE })} />
                </>
                } />
            </Dialog>
            <Dialog title="License Information" icon="info-sign" isOpen={state.showDialog === DialogType.LICENSE} onClose={() => setState({ ...state, showDialog: DialogType.NONE })} style={{maxWidth: 'calc(100vw - 40px)', width: '900px'}}>
                <DialogBody>
                    <p>The <b><i>Quick Regular Expressions</i></b> are published under the MIT license, see details below.</p>
                    <p>This site is additionally using a software that is covered by the following licenses:</p>
                    <iframe src="license.html" style={{maxHeight: 'calc(100vh - 400px)', width: '100%', height: '600px', border: '1px solid #777' }}></iframe>
                </DialogBody>
                <DialogFooter actions={<>
                    <Button intent="primary" text="  Close  " onClick={() => setState({ ...state, showDialog: DialogType.NONE })} />
                </>
                } />
            </Dialog>
        </>
    );
}

const extensions: { [key: string]: string } = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
};
let editor: monaco.editor.IStandaloneCodeEditor;

interface ExternalPromiseResult<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
}

interface DBFile {
    id: number;
    name: string;
    content: string;
};

interface DBVersion {
    id: 'version';
    version: number;
};

type DBEntry = DBFile | DBVersion;

function externalPromise<T = void>(): ExternalPromiseResult<T> {
    let result = {} as ExternalPromiseResult<T>;
    result.promise = new Promise<T>((resolve, reject) => {
        result.resolve = resolve;
        result.reject = reject;
    });
    return result;
}

function delay(time: number): Promise<void> {
    return new Promise(r => setTimeout(r, time));
}

function deffer(): Promise<void> {
    return delay(0);
}

function generateFileId(state?: State) {
    let id: number;
    let repeat = false;
    do {
        id = Math.floor(Math.random() * 4503599627370496);
        if (state) {
            for (let file of state.files) {
                repeat = id === file.id;
            }
        }
    } while (repeat);
    return id;
}

let database: db.Database;

async function createDatabaseStructure(database: db.Database) {
    try {
        database.deleteObjectStore('files');
    } catch (err) { }
    try {
        database.deleteObjectStore('recent');
    } catch (err) { }
    let files = database.createObjectStore<DBEntry>('files', { keyPath: 'id' });
    database.createObjectStore('recent');
    await files.put({
        id: 'version',
        version: -1,
    });
}

async function openStorage() {
    const INDEXED_DB_VERSION = 18;
    database = await db.open('qre-web-demo-storage', INDEXED_DB_VERSION, createDatabaseStructure, 1000);
    await using transaction = database.transaction('files', 'readonly');
    let files = transaction.objectStore<DBEntry>('files');
    let list = await files.getAll();
    let stateFiles: FileState[] = [];
    for (let entry of list) {
        if ('version' in entry) {
            initialState.mutable.storageVersion = entry.version;
        } else {
            stateFiles.push({
                id: entry.id,
                name: entry.name,
                mutable: {
                    content: entry.content,
                    dirty: false,
                },
            });
        }
    }
    if (stateFiles.length > 0) {
        initialState = { ...initialState, files: stateFiles, selectedFileId: stateFiles[0].id };
    }
}

async function loadStorageChanges() {
    let state = getState();
    await using transaction = database.transaction('files', 'readonly');
    let store = transaction.objectStore<DBEntry>('files');
    let versionObject = await store.get('version');
    let version = versionObject?.id === 'version' ? versionObject?.version || -1 : -1;
    if (version === state.mutable.storageVersion) {
        return;
    }
    for (let file of state.files) {
        if (file.mutable.dirty) continue;
        let row = await store.get(file.id);
        state = getState();
        if (!row || row.id === 'version') continue;
        let fileContent = file.mutable.content;
        if (typeof fileContent !== 'string') {
            fileContent = fileContent.getValue();
        }
        if (row.content !== fileContent) {
            if (typeof file.mutable.content !== 'string') {
                file.mutable.content.setValue(row.content);
            } else {
                file.mutable.content = row.content;
            }
            console.log('Recv Content', row.name);
        }
        if (row.name !== file.name) {
            state = getState();
            console.log('Recv Name', row.name, '=>', file.name);
            setState({ ...state, files: state.files.map(f => f.id !== file.id ? f : { ...f, name: (row as DBFile).name }) });
        }
    }
    state.mutable.storageVersion = version;
}

async function storeStorageChanges() {
    let state = getState();
    let rows: DBFile[] = [];
    let closedIds = state.mutable.closedIds;
    state.mutable.closedIds = [];
    for (let file of state.files) {
        if (file.mutable.dirty) {
            file.mutable.dirty = false;
            let content = file.mutable.content;
            rows.push({
                id: file.id,
                name: file.name,
                content: typeof content === 'string' ? content : content.getValue(),
            });
        }
    }
    if (closedIds.length > 0 || rows.length > 0) {
        let changes = 0;
        await using transaction = database.transaction('files', 'readwrite');
        let storage = transaction.objectStore<DBEntry>('files');
        for (let id of closedIds) {
            let old = await storage.get(id);
            if (old) {
                changes++;
                await storage.delete(id);
            }
        }
        for (let row of rows) {
            let old = await storage.get(row.id);
            if (!old || old.id === "version" || old.content !== row.content || old.name !== row.name) {
                changes++;
                await storage.put(row);
            }
        }
        if (changes) {
            //console.log('Changes', changes);
            let versionChange: DBVersion = {
                id: 'version',
                version: generateFileId(),
            }
            await storage.put(versionChange);
            await transaction.commit();
            state.mutable.storageVersion = versionChange.version;
        }
    }
}

async function dbSynchronize() {
    if (!curState) return;
    try {
        await loadStorageChanges();
        await storeStorageChanges();
    } catch (err) {
        try {
            await delay(50);
            await storeStorageChanges();
        } catch (err) {
            await delay(100);
            await storeStorageChanges();
        }
    }
}

let dbSynchronizing = false;
let dbSynchronizeWaiting = false;
let dbSynchronizeTimer = setTimeout(() => { }, 0);

async function dbSynchronizeRequest() {
    clearTimeout(dbSynchronizeTimer);
    if (dbSynchronizing) {
        if (dbSynchronizeWaiting) return;
        dbSynchronizeWaiting = true;
        while (dbSynchronizing) {
            await delay(2);
        }
        dbSynchronizeWaiting = false;
    }
    dbSynchronizing = true;
    try {
        await dbSynchronize();
    } finally {
        dbSynchronizing = false;
        dbSynchronizeTimer = setTimeout(dbSynchronizeRequest, 1000);
    }
}

function editorValueChange() {
    let state = getState();
    let file = state.files.find(file => file.id === state.selectedFileId);
    file!.mutable.dirty = true;
    dbSynchronizeRequest();
    updateAddress();
}

function test() {
    let res = indexedDB.open('aa', 12);
    res.onerror = () => console.log(res.error);
    res.onblocked = () => console.log('Blocked', res.error);
    res.onsuccess = () => console.log('Success111');
    res.onupgradeneeded = async (event) => {
        console.log('Upgradeneeded', event.oldVersion, event.newVersion);
        //setTimeout(() => {
        console.log('Upgradeneeded continue');
        let db = res.result;
        let transaction = res.transaction as IDBTransaction;
        db.deleteObjectStore('jest');
        let store = db.createObjectStore('jest', { keyPath: 'id' });
        let res2 = store.put({ id: 1, value: 'first' });
        let resolve: any;
        let reject: any;
        let p = new Promise((a, b) => { resolve = a; reject = b; });
        res2.onerror = () => reject(res2.error);
        res2.onsuccess = () => resolve();
        await p;
        console.log('Success1');
        let res3 = store.put({ id: 1, value: 'first' });
        res3.onerror = () => console.log('put2:', res3.error);
        res3.onsuccess = () => {
            console.log('Success2');
            //transaction.commit();
        }
        let res4 = store.get(1);
        res4.onerror = () => console.log('put2:', res4.error);
        res4.onsuccess = () => {
            console.log('Success3', res4.result);
            //transaction.commit();
        }
        //}, 1000);
    };
}

function showIntroIfNeeded() {
    if (initialState.files.length === 0) {
        initialState.files.push({
            id: generateFileId(),
            name: INITIAL_FILE,
            mutable: {
                content: INITIAL_CONTENT,
                dirty: false,
            },
        });
        initialState = { ...initialState, selectedFileId: initialState.files[0].id };
    }
}

window.onload = async () => {
    setupEditor(monaco);
    mainToaster = await OverlayToaster.createAsync({ position: 'top' });
    //test();
    await openStorage(); // TODO: handle errors to allow other stuff even when storage does not work properly
    await readFromHash();
    showIntroIfNeeded();
    let mainPanel = document.querySelector('.editorPanel') as HTMLElement;
    let panel = document.createElement('div');
    panel.className = 'editor';
    editor = monaco.editor.create(panel, {
        theme: 'vs-dark',
        automaticLayout: true,
        extraEditorClassName: 'editorControl',
        model: null,
        "semanticHighlighting.enabled": true,
    });
    editor.onDidChangeModelContent(editorValueChange);
    mainPanel.appendChild(panel);
    ReactDOM.render(<App />, document.getElementById('reactRoot'));
    restoreEditorFile();
    dbSynchronizeRequest();
    updateAddress();
};


function escapeHTML(str: string): string {
    const chars = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return str.replace(/[&<>"']/g, x => chars[x]);
}

function showOutput(stdio: string[], fileName?: string) {
    let fileRegExp: RegExp | undefined = fileName ? qre.global`
            "${fileName}";
            ":";
            lineNumber: at-least-1 [0-9];
            optional {
                ":";
                columnNumber: at-least-1 [0-9];
            }
        ` : undefined;
    let container = document.getElementById('outputText') as HTMLElement;
    container.innerHTML = '';
    let html = '';
    for (let i = 0; i < stdio.length; i++) {
        html += `<span class="std${i & 1 ? 'err' : 'out'}">`;
        let text = escapeHTML(stdio[i]).replace(/\r?\n/g, `</span></div><div><span class="std${i & 1 ? 'err' : 'out'}">`);
        if (fileRegExp) {
            text = text.replace(fileRegExp, (all: string, line: string, column: string) => {
                return `<a href="javascript://${all}" data-line="${line}" data-column="${column}">${all}</a>`;
            });
        }
        html += text;
        html += `</span>`;
    }
    container.innerHTML = '<div>' + html + '</div>';
    for (let link of container.querySelectorAll('a')) {
        let line = link.getAttribute('data-line');
        let column = link.getAttribute('data-column');
        if (!line) continue;
        link.onclick = () => {
            goToLine(parseInt(line as string), column ? parseInt(column) : 1);
        }
    }
}

function goToLine(line: number, column: number) {
    editor.setSelection(new monaco.Range(line, column, line, column));
    editor.focus();
}
