// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Package, PackageChangeKind, PackageManager, PythonEnvironment } from '../../../api';
import { getPackageChanges, updatePackagesAndNotify } from '../../../managers/common/packageChanges';

suite('packageChanges', () => {
    teardown(() => {
        sinon.restore();
    });

    suite('getPackageChanges', () => {
        test('returns empty array when before and after are identical', () => {
            const pkgs = [{ name: 'requests', version: '2.31.0' } as Package];

            const changes = getPackageChanges(pkgs, pkgs);

            assert.strictEqual(changes.length, 0);
        });

        test('returns empty array when both before and after are empty', () => {
            const changes = getPackageChanges([], []);

            assert.strictEqual(changes.length, 0);
        });

        test('returns add changes for new packages', () => {
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'flask', version: '3.0.0' } as Package,
            ];

            const changes = getPackageChanges([], after);

            assert.strictEqual(changes.length, 2);
            assert.deepStrictEqual(
                changes.map((c) => c.kind),
                [PackageChangeKind.add, PackageChangeKind.add],
            );
            assert.deepStrictEqual(
                changes.map((c) => c.pkg.name),
                ['requests', 'flask'],
            );
        });

        test('returns remove changes for removed packages', () => {
            const before = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'flask', version: '3.0.0' } as Package,
            ];

            const changes = getPackageChanges(before, []);

            assert.strictEqual(changes.length, 2);
            assert.deepStrictEqual(
                changes.map((c) => c.kind),
                [PackageChangeKind.remove, PackageChangeKind.remove],
            );
        });

        test('detects version upgrade as add and remove', () => {
            const before = [{ name: 'requests', version: '2.30.0' } as Package];
            const after = [{ name: 'requests', version: '2.31.0' } as Package];

            const changes = getPackageChanges(before, after);

            assert.strictEqual(changes.length, 2);
            const add = changes.find((c) => c.kind === PackageChangeKind.add);
            const remove = changes.find((c) => c.kind === PackageChangeKind.remove);
            assert.ok(add);
            assert.ok(remove);
            assert.strictEqual(add.pkg.version, '2.31.0');
            assert.strictEqual(remove.pkg.version, '2.30.0');
        });

        test('handles mixed additions and removals', () => {
            const before = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'flask', version: '3.0.0' } as Package,
            ];
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'django', version: '5.0.0' } as Package,
            ];

            const changes = getPackageChanges(before, after);

            assert.strictEqual(changes.length, 2);
            const add = changes.find((c) => c.kind === PackageChangeKind.add);
            const remove = changes.find((c) => c.kind === PackageChangeKind.remove);
            assert.ok(add);
            assert.ok(remove);
            assert.strictEqual(add.pkg.name, 'django');
            assert.strictEqual(remove.pkg.name, 'flask');
        });
    });

    suite('updatePackagesAndNotify', () => {
        let environment: PythonEnvironment;
        let cache: Package[] | undefined;
        let fetchPackagesStub: sinon.SinonStub;
        let packageManager: PackageManager;

        setup(() => {
            environment = {} as PythonEnvironment;
            cache = undefined;
            fetchPackagesStub = sinon.stub();

            packageManager = {
                name: 'test',
                manage: sinon.stub(),
                refresh: sinon.stub(),
                getPackages: sinon.stub().callsFake(() => Promise.resolve(cache)),
                fetchPackages: fetchPackagesStub,
                setPackages: sinon.stub().callsFake((_env: PythonEnvironment, pkgs: Package[]) => {
                    cache = pkgs;
                }),
            } as unknown as PackageManager;
        });

        test('updates cache and reports adds on first load', async () => {
            const fetched = [{ name: 'requests', version: '2.31.0' } as Package];
            fetchPackagesStub.resolves(fetched);

            await updatePackagesAndNotify(packageManager, environment, cache);

            const setPackages = packageManager.setPackages as sinon.SinonStub;
            assert.ok(setPackages.calledOnce);
            const [env, pkgs, changes] = setPackages.firstCall.args;
            assert.strictEqual(env, environment);
            assert.deepStrictEqual(pkgs, fetched);
            assert.strictEqual(changes.length, 1);
            assert.strictEqual(changes[0].kind, PackageChangeKind.add);
            assert.deepStrictEqual(cache, fetched);
        });

        test('updates cache with empty changes when nothing changed', async () => {
            const pkgs = [{ name: 'requests', version: '2.31.0' } as Package];
            cache = pkgs;
            fetchPackagesStub.resolves(pkgs);

            await updatePackagesAndNotify(packageManager, environment, cache);

            const setPackages = packageManager.setPackages as sinon.SinonStub;
            assert.ok(setPackages.calledOnce);
            const [, , changes] = setPackages.firstCall.args;
            assert.strictEqual(changes.length, 0);
        });

        test('detects removals correctly', async () => {
            const before = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'flask', version: '3.0.0' } as Package,
            ];
            cache = before;
            const after = [{ name: 'requests', version: '2.31.0' } as Package];
            fetchPackagesStub.resolves(after);

            await updatePackagesAndNotify(packageManager, environment, cache);

            const setPackages = packageManager.setPackages as sinon.SinonStub;
            assert.ok(setPackages.calledOnce);
            const [, pkgs, changes] = setPackages.firstCall.args;
            assert.deepStrictEqual(pkgs, after);
            assert.strictEqual(changes.length, 1);
            assert.strictEqual(changes[0].kind, PackageChangeKind.remove);
            assert.strictEqual(changes[0].pkg.name, 'flask');
        });

        test('detects mixed adds and removals', async () => {
            cache = [{ name: 'flask', version: '3.0.0' } as Package];
            const after = [{ name: 'django', version: '5.0.0' } as Package];
            fetchPackagesStub.resolves(after);

            await updatePackagesAndNotify(packageManager, environment, cache);

            const setPackages = packageManager.setPackages as sinon.SinonStub;
            assert.ok(setPackages.calledOnce);
            const [, , changes] = setPackages.firstCall.args;
            assert.strictEqual(changes.length, 2);
            assert.ok(changes.some((c: { kind: PackageChangeKind }) => c.kind === PackageChangeKind.add));
            assert.ok(changes.some((c: { kind: PackageChangeKind }) => c.kind === PackageChangeKind.remove));
        });
    });
});
