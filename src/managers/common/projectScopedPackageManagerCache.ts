// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable } from 'vscode';
import { PythonProject } from '../../api';
import { InternalPackageManager } from './registeredManagers';

interface ProjectScopedPackageManagerEntry {
    provider: InternalPackageManager;
    manager: InternalPackageManager;
    subscription: Disposable;
}

/**
 * Owns the package manager scoped to each tracked Python project.
 *
 * A project has at most one active scoped manager. Changing its configured provider replaces and
 * disposes the previous manager. Project removal, provider removal, and cache disposal also release
 * the scoped manager and its event subscription.
 */
export class ProjectScopedPackageManagerCache implements Disposable {
    private readonly entries = new Map<PythonProject, ProjectScopedPackageManagerEntry>();

    constructor(
        private readonly subscribe: (manager: InternalPackageManager) => Disposable,
        private readonly onDidInvalidate: () => void,
    ) {}

    /**
     * Returns the manager for a project, creating and caching a scoped manager when supported.
     *
     * @param provider The project's currently configured root package manager.
     * @param project The canonical tracked project.
     * @returns The scoped manager, the shared provider, or undefined when no provider is configured.
     */
    getOrCreate(
        provider: InternalPackageManager | undefined,
        project: PythonProject,
    ): InternalPackageManager | undefined {
        const existing = this.entries.get(project);
        if (!provider?.createForProject) {
            if (existing) {
                this.entries.delete(project);
                this.disposeEntry(existing);
                this.onDidInvalidate();
            }
            return provider;
        }
        if (existing?.provider === provider) {
            return existing.manager;
        }

        const manager = provider.createForProject(project);
        let subscription: Disposable;
        try {
            subscription = this.subscribe(manager);
        } catch (error) {
            manager.dispose();
            throw error;
        }

        if (existing) {
            this.disposeEntry(existing);
        }
        this.entries.set(project, { provider, manager, subscription });
        if (existing) {
            this.onDidInvalidate();
        }
        return manager;
    }

    /**
     * Disposes entries whose canonical projects are no longer tracked.
     *
     * @param projects The complete current set of tracked projects.
     */
    reconcileProjects(projects: readonly PythonProject[]): void {
        const activeProjects = new Set(projects);
        let invalidated = false;
        for (const [project, entry] of this.entries) {
            if (!activeProjects.has(project)) {
                this.entries.delete(project);
                this.disposeEntry(entry);
                invalidated = true;
            }
        }
        if (invalidated) {
            this.onDidInvalidate();
        }
    }

    /**
     * Disposes all scoped managers created from a provider.
     *
     * @param provider The provider being unregistered.
     */
    removeProvider(provider: InternalPackageManager): void {
        let invalidated = false;
        for (const [project, entry] of this.entries) {
            if (entry.provider === provider) {
                this.entries.delete(project);
                this.disposeEntry(entry);
                invalidated = true;
            }
        }
        if (invalidated) {
            this.onDidInvalidate();
        }
    }

    /** Disposes every cached scoped manager and its event subscription. */
    dispose(): void {
        for (const entry of this.entries.values()) {
            this.disposeEntry(entry);
        }
        this.entries.clear();
    }

    private disposeEntry(entry: ProjectScopedPackageManagerEntry): void {
        entry.subscription.dispose();
        entry.manager.dispose();
    }
}
