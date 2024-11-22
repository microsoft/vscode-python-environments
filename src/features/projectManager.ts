import { Uri, EventEmitter, MarkdownString, Disposable } from 'vscode';
import { IconPath, PythonProject } from '../api';
import * as path from 'path';
import { PythonProjectManager, PythonProjectSettings, PythonProjectsImpl } from '../internal.api';
import {
    getConfiguration,
    getWorkspaceFolders,
    onDidChangeConfiguration,
    onDidChangeWorkspaceFolders,
} from '../common/workspace.apis';
import { createSimpleDebounce } from '../common/utils/debounce';

type ProjectArray = PythonProject[];

export class PythonProjectManagerImpl implements PythonProjectManager {
    private disposables: Disposable[] = [];
    private _projects = new Map<string, PythonProject>();
    private readonly _onDidChangeProjects = new EventEmitter<ProjectArray | undefined>();
    public readonly onDidChangeProjects = this._onDidChangeProjects.event;
    private readonly updateDebounce = createSimpleDebounce(100, () => this.updateProjects());

    initialize(): void {
        this.add(this.getInitialProjects());
        this.disposables.push(
            this._onDidChangeProjects,
            new Disposable(() => this._projects.clear()),
            onDidChangeWorkspaceFolders(() => {
                this.updateDebounce.trigger();
            }),
            onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration('python-envs.defaultEnvManager') ||
                    e.affectsConfiguration('python-envs.pythonProjects') ||
                    e.affectsConfiguration('python-envs.defaultPackageManager')
                ) {
                    this.updateDebounce.trigger();
                }
            }),
        );
    }

    private getInitialProjects(): ProjectArray {
        const newProjects: ProjectArray = [];
        const workspaces = getWorkspaceFolders() ?? [];
        for (const w of workspaces) {
            const config = getConfiguration('python-envs', w.uri);
            const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
            newProjects.push(new PythonProjectsImpl(w.name, w.uri));
            for (const o of overrides) {
                const uri = Uri.file(path.resolve(w.uri.fsPath, o.path));
                newProjects.push(new PythonProjectsImpl(o.path, uri));
            }
        }
        return newProjects;
    }

    private updateProjects(): void {
        const workspaces = getWorkspaceFolders() ?? [];
        const existingProjects = Array.from(this._projects.values());
        const newProjects: ProjectArray = [];

        for (const w of workspaces) {
            const config = getConfiguration('python-envs', w.uri);
            const overrides = config.get<PythonProjectSettings[]>('pythonProjects', []);
            newProjects.push(new PythonProjectsImpl(w.name, w.uri));
            for (const o of overrides) {
                const uri = Uri.file(path.resolve(w.uri.fsPath, o.path));
                newProjects.push(new PythonProjectsImpl(o.path, uri));
            }
        }

        const projectsToRemove = existingProjects.filter(
            (w) => !newProjects.find((n) => n.uri.toString() === w.uri.toString()),
        );
        projectsToRemove.forEach((w) => this._projects.delete(w.uri.toString()));

        const projectsToAdd = newProjects.filter(
            (n) => !existingProjects.find((w) => w.uri.toString() === n.uri.toString()),
        );
        projectsToAdd.forEach((w) => this._projects.set(w.uri.toString(), w));

        if (projectsToRemove.length > 0 || projectsToAdd.length > 0) {
            this._onDidChangeProjects.fire(Array.from(this._projects.values()));
        }
    }

    create(
        name: string,
        uri: Uri,
        options?: { description?: string; tooltip?: string | MarkdownString; iconPath?: IconPath },
    ): PythonProject {
        return new PythonProjectsImpl(name, uri, options);
    }

    add(projects: PythonProject | ProjectArray): void {
        const _projects = Array.isArray(projects) ? projects : [projects];
        if (_projects.length === 0) {
            return;
        }

        _projects.forEach((w) => this._projects.set(w.uri.toString(), w));
        this._onDidChangeProjects.fire(Array.from(this._projects.values()));
    }

    remove(projects: PythonProject | ProjectArray): void {
        const _projects = Array.isArray(projects) ? projects : [projects];
        if (_projects.length === 0) {
            return;
        }

        _projects.forEach((w) => this._projects.delete(w.uri.toString()));
        this._onDidChangeProjects.fire(Array.from(this._projects.values()));
    }

    getProjects(uris?: Uri[]): ReadonlyArray<PythonProject> {
        if (uris === undefined) {
            return Array.from(this._projects.values());
        } else {
            const projects: PythonProject[] = [];
            for (const uri of uris) {
                const project = this.get(uri);
                if (project !== undefined && !projects.includes(project)) {
                    projects.push(project);
                }
            }
            return projects;
        }
    }

    get(uri: Uri): PythonProject | undefined {
        let pythonProject = this._projects.get(uri.toString());
        if (!pythonProject) {
            pythonProject = this.findProjectByUri(uri);
        }
        return pythonProject;
    }

    private findProjectByUri(uri: Uri): PythonProject | undefined {
        const _projects = Array.from(this._projects.values()).sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);

        const normalizedUriPath = path.normalize(uri.fsPath);
        for (const p of _projects) {
            const normalizedProjectPath = path.normalize(p.uri.fsPath);
            if (this.isUriMatching(normalizedUriPath, normalizedProjectPath)) {
                return p;
            }
        }
        return undefined;
    }

    private isUriMatching(normalizedUriPath: string, normalizedProjectPath: string): boolean {
        if (normalizedProjectPath === normalizedUriPath) {
            return true;
        }
        let parentPath = path.dirname(normalizedUriPath);
        while (parentPath !== path.dirname(parentPath)) {
            if (normalizedProjectPath === parentPath) {
                return true;
            }
            parentPath = path.dirname(parentPath);
        }
        return false;
    }

    dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
}
