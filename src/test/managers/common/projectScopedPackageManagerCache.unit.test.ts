// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, Uri } from 'vscode';
import { PackageManager, PythonProject } from '../../../api';
import { ProjectScopedPackageManagerCache } from '../../../managers/common/projectScopedPackageManagerCache';
import { InternalPackageManager } from '../../../managers/common/registeredManagers';

suite('ProjectScopedPackageManagerCache', () => {
    let invalidate: sinon.SinonStub;
    let subscribe: sinon.SinonStub;
    let subscriptionDisposers: sinon.SinonStub[];
    let cache: ProjectScopedPackageManagerCache;

    setup(() => {
        invalidate = sinon.stub();
        subscriptionDisposers = [];
        subscribe = sinon.stub().callsFake(() => {
            const dispose = sinon.stub();
            subscriptionDisposers.push(dispose);
            return new Disposable(dispose);
        });
        cache = new ProjectScopedPackageManagerCache(subscribe, invalidate);
    });

    teardown(() => {
        cache.dispose();
        sinon.restore();
    });

    function createProject(name: string): PythonProject {
        return {
            name,
            uri: Uri.file(path.join(process.cwd(), name)),
        };
    }

    function createProvider(name: string): {
        provider: InternalPackageManager;
        createForProject: sinon.SinonStub;
        scopedDisposers: sinon.SinonStub[];
    } {
        const scopedDisposers: sinon.SinonStub[] = [];
        const createForProject = sinon.stub().callsFake(() => {
            const dispose = sinon.stub();
            scopedDisposers.push(dispose);
            return {
                name,
                manage: async () => undefined,
                refresh: async () => undefined,
                getPackages: async () => [],
                dispose,
            } satisfies PackageManager;
        });
        const provider = new InternalPackageManager(name, {
            name,
            manage: async () => undefined,
            refresh: async () => undefined,
            getPackages: async () => [],
            createForProject,
        });
        return { provider, createForProject, scopedDisposers };
    }

    test('memoizes one scoped manager per canonical project', () => {
        const { provider, createForProject } = createProvider('project-aware');
        const firstProject = createProject('first-project');
        const secondProject = createProject('second-project');

        const first = cache.getOrCreate(provider, firstProject);
        const repeatedFirst = cache.getOrCreate(provider, firstProject);
        const second = cache.getOrCreate(provider, secondProject);

        assert.strictEqual(first, repeatedFirst);
        assert.notStrictEqual(first, second);
        assert.strictEqual(first?.project, firstProject);
        assert.strictEqual(second?.project, secondProject);
        assert.strictEqual(createForProject.callCount, 2);
        assert.strictEqual(subscribe.callCount, 2);
        assert.ok(invalidate.notCalled);
    });

    test('replaces and disposes a scoped manager when the provider changes', () => {
        const firstProvider = createProvider('first-provider');
        const secondProvider = createProvider('second-provider');
        const project = createProject('provider-change-project');
        const first = cache.getOrCreate(firstProvider.provider, project);

        const second = cache.getOrCreate(secondProvider.provider, project);

        assert.notStrictEqual(first, second);
        assert.ok(firstProvider.scopedDisposers[0].calledOnce);
        assert.ok(subscriptionDisposers[0].calledOnce);
        assert.ok(secondProvider.scopedDisposers[0].notCalled);
        assert.ok(subscriptionDisposers[1].notCalled);
        assert.ok(invalidate.calledOnce);
    });

    test('reconciles replaced and removed canonical projects', () => {
        const { provider, scopedDisposers } = createProvider('project-aware');
        const original = createProject('reconciled-project');
        const replacement = createProject('reconciled-project');
        cache.getOrCreate(provider, original);

        cache.reconcileProjects([replacement]);

        assert.ok(scopedDisposers[0].calledOnce);
        assert.ok(subscriptionDisposers[0].calledOnce);
        assert.ok(invalidate.calledOnce);

        cache.getOrCreate(provider, replacement);
        cache.reconcileProjects([]);

        assert.ok(scopedDisposers[1].calledOnce);
        assert.ok(subscriptionDisposers[1].calledOnce);
        assert.ok(invalidate.calledTwice);
    });

    test('removes only scoped managers created by the requested provider', () => {
        const firstProvider = createProvider('first-provider');
        const secondProvider = createProvider('second-provider');
        cache.getOrCreate(firstProvider.provider, createProject('first-provider-project'));
        cache.getOrCreate(secondProvider.provider, createProject('second-provider-project'));

        cache.removeProvider(firstProvider.provider);

        assert.ok(firstProvider.scopedDisposers[0].calledOnce);
        assert.ok(subscriptionDisposers[0].calledOnce);
        assert.ok(secondProvider.scopedDisposers[0].notCalled);
        assert.ok(subscriptionDisposers[1].notCalled);
        assert.ok(invalidate.calledOnce);
    });

    test('disposes all scoped managers and subscriptions', () => {
        const { provider, scopedDisposers } = createProvider('project-aware');
        cache.getOrCreate(provider, createProject('first-project'));
        cache.getOrCreate(provider, createProject('second-project'));

        cache.dispose();

        assert.ok(scopedDisposers[0].calledOnce);
        assert.ok(scopedDisposers[1].calledOnce);
        assert.ok(subscriptionDisposers[0].calledOnce);
        assert.ok(subscriptionDisposers[1].calledOnce);
    });

    test('returns project-independent providers without caching or subscribing', () => {
        const provider = new InternalPackageManager('shared', {
            name: 'shared',
            manage: async () => undefined,
            refresh: async () => undefined,
            getPackages: async () => [],
        });

        const resolved = cache.getOrCreate(provider, createProject('shared-project'));

        assert.strictEqual(resolved, provider);
        assert.ok(subscribe.notCalled);
        assert.ok(invalidate.notCalled);
    });

    test('disposes a scoped manager when its project switches to a project-independent provider', () => {
        const projectAwareProvider = createProvider('project-aware');
        const sharedProvider = new InternalPackageManager('shared', {
            name: 'shared',
            manage: async () => undefined,
            refresh: async () => undefined,
            getPackages: async () => [],
        });
        const project = createProject('provider-kind-change-project');
        cache.getOrCreate(projectAwareProvider.provider, project);

        const resolved = cache.getOrCreate(sharedProvider, project);

        assert.strictEqual(resolved, sharedProvider);
        assert.ok(projectAwareProvider.scopedDisposers[0].calledOnce);
        assert.ok(subscriptionDisposers[0].calledOnce);
        assert.ok(invalidate.calledOnce);
    });
});
