import { EventEmitter, MarkdownString } from 'vscode';
import {
    CreateEnvironmentOptions,
    CreateEnvironmentScope,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    IconPath,
    PythonEnvironment,
    PythonEnvironmentApi,
    QuickCreateConfig,
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';
import { PipenvStrings } from '../../common/localize';
import { NativePythonFinder } from '../common/nativePythonFinder';

export class PipenvManager implements EnvironmentManager {
    private collection: PythonEnvironment[] = [];
    private fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;
    constructor(private readonly nativeFinder: NativePythonFinder, private readonly api: PythonEnvironmentApi) {
        this.name = 'pipenv';
        this.displayName = 'Pipenv';
        this.preferredPackageManagerId = 'ms-python.python:pip';
        this.tooltip = new MarkdownString(PipenvStrings.pipenvManager, true);
    }

    name: string;
    displayName: string;
    preferredPackageManagerId: string;
    description?: string;
    tooltip: string | MarkdownString;
    iconPath?: IconPath;

    public dispose() {
        this.collection = [];
        this.fsPathToEnv.clear();
    }

    quickCreateConfig?(): QuickCreateConfig | undefined {
        // To be implemented
        return undefined;
    }

    async create?(
        _scope: CreateEnvironmentScope,
        _options?: CreateEnvironmentOptions,
    ): Promise<PythonEnvironment | undefined> {
        // To be implemented
        return undefined;
    }

    async remove?(_environment: PythonEnvironment): Promise<void> {
        // To be implemented
    }

    async refresh(_scope: RefreshEnvironmentsScope): Promise<void> {
        // To be implemented
    }

    async getEnvironments(_scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        // To be implemented
        return [];
    }

    async set(_scope: SetEnvironmentScope, _environment?: PythonEnvironment): Promise<void> {
        // To be implemented
    }

    async get(_scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        // To be implemented
        return undefined;
    }

    async resolve(_context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        // To be implemented
        return undefined;
    }

    async clearCache?(): Promise<void> {
        // To be implemented
    }
}
