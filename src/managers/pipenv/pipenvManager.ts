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
    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    public readonly name: string;
    public readonly displayName: string;
    public readonly preferredPackageManagerId: string;
    public readonly description?: string;
    public readonly tooltip: string | MarkdownString;
    public readonly iconPath?: IconPath;

    constructor(
        public readonly nativeFinder: NativePythonFinder, 
        public readonly api: PythonEnvironmentApi
    ) {
        this.name = 'pipenv';
        this.displayName = 'Pipenv';
        this.preferredPackageManagerId = 'ms-python.python:pipenv';
        this.tooltip = new MarkdownString(PipenvStrings.pipenvManager, true);
    }

    public dispose() {
        this._onDidChangeEnvironment.dispose();
        this._onDidChangeEnvironments.dispose();
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
        // TODO: Implement pipenv environment refresh
        // This should discover pipenv environments and update the collection
    }

    async getEnvironments(_scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        // TODO: Implement pipenv environment discovery
        // This should return all discovered pipenv environments
        return [];
    }

    async set(_scope: SetEnvironmentScope, _environment?: PythonEnvironment): Promise<void> {
        // TODO: Implement setting pipenv environment for a scope
        // This should update the selected environment for the given scope
    }

    async get(_scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        // TODO: Implement getting the selected pipenv environment for a scope
        return undefined;
    }

    async resolve(_context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        // TODO: Implement resolving a path to a pipenv environment
        return undefined;
    }

    async clearCache?(): Promise<void> {
        // TODO: Implement cache clearing
        // This should clear any cached environment discovery data
    }
}
