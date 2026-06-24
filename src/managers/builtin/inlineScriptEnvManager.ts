// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable, Event, EventEmitter, l10n, LogOutputChannel, MarkdownString, ThemeIcon } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    IconPath,
    PythonEnvironment,
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';

/**
 * Skeleton EnvironmentManager for PEP 723 inline-script envs. Every
 * method returns the empty / undefined / no-op equivalent; `create`,
 * `remove`, and `quickCreateConfig` are intentionally omitted so the
 * picker UI hides their entry points until later PRs land them.
 */
export class InlineScriptEnvManager implements EnvironmentManager, Disposable {
    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments: Event<DidChangeEnvironmentsEventArgs> =
        this._onDidChangeEnvironments.event;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs> = this._onDidChangeEnvironment.event;

    public readonly name = 'inline-script';
    public readonly displayName = l10n.t('Inline script environments');
    public readonly preferredPackageManagerId = 'ms-python.python:pip';
    public readonly description: string | undefined = undefined;
    public readonly tooltip: string | MarkdownString = new MarkdownString(
        l10n.t('Environments built from PEP 723 inline script metadata.'),
        true,
    );
    public readonly iconPath: IconPath = new ThemeIcon('file-code');

    constructor(public readonly log: LogOutputChannel) {}

    async refresh(_scope: RefreshEnvironmentsScope): Promise<void> {
        return;
    }

    async getEnvironments(_scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        return [];
    }

    async set(_scope: SetEnvironmentScope, _environment?: PythonEnvironment): Promise<void> {
        return;
    }

    async get(_scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        return undefined;
    }

    async resolve(_context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return undefined;
    }

    dispose(): void {
        this._onDidChangeEnvironments.dispose();
        this._onDidChangeEnvironment.dispose();
    }
}
