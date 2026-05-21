// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Package, PackageChangeKind, PackageManager, PythonEnvironment } from '../../../api';
import { getPackageChanges, updatePackagesAndNotify } from '../../../managers/common/packageChanges';

suite('packageChanges', () => {
    let environment: PythonEnvironment;
    let packageManager: PackageManager;

    let getPackagesStub: sinon.SinonStub;
    let fetchPackagesStub: sinon.SinonStub;
    let setPackagesSpy: sinon.SinonSpy;

    setup(() => {
        environment = {} as PythonEnvironment;
        getPackagesStub = sinon.stub();
        fetchPackagesStub = sinon.stub();
        setPackagesSpy = sinon.spy();

        packageManager = {
            name: 'test',
            manage: sinon.stub(),
            refresh: sinon.stub(),
            getPackages: getPackagesStub,
            fetchPackages: fetchPackagesStub,
            setPackages: setPackagesSpy,
        } as unknown as PackageManager;
    });

    teardown(() => {
        sinon.restore();
    });

    suite('getPackageChanges', () => {
        test('returns empty array when before and after are identical', async () => {
            const pkgs = [{ name: 'requests', version: '2.31.0' } as Package];
            getPackagesStub.resolves(pkgs);

            const changes = await getPackageChanges(packageManager, environment, pkgs);

            assert.strictEqual(changes.length, 0);
        });

        test('returns empty array when both before and after are empty', async () => {
            getPackagesStub.resolves([]);

            const changes = await getPackageChanges(packageManager, environment, []);

            assert.strictEqual(changes.length, 0);
        });

        test('returns add changes for new packages', async () => {
            getPackagesStub.resolves([]);
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'flask', version: '3.0.0' } as Package,
            ];

            const changes = await getPackageChanges(packageManager, environment, after);

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

        test('returns remove changes for removed packages', async () => {
            const before = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'flask', version: '3.0.0' } as Package,
            ];
            getPackagesStub.resolves(before);

            const changes = await getPackageChanges(packageManager, environment, []);

            assert.strictEqual(changes.length, 2);
            assert.deepStrictEqual(
                changes.map((c) => c.kind),
                [PackageChangeKind.remove, PackageChangeKind.remove],
            );
        });

        test('detects version upgrade as add and remove', async () => {
            const before = [{ name: 'requests', version: '2.30.0' } as Package];
            getPackagesStub.resolves(before);
            const after = [{ name: 'requests', version: '2.31.0' } as Package];

            const changes = await getPackageChanges(packageManager, environment, after);

            assert.strictEqual(changes.length, 2);
            const add = changes.find((c) => c.kind === PackageChangeKind.add);
            const remove = changes.find((c) => c.kind === PackageChangeKind.remove);
            assert.ok(add);
            assert.ok(remove);
            assert.strictEqual(add.pkg.version, '2.31.0');
            assert.strictEqual(remove.pkg.version, '2.30.0');
        });

        test('handles mixed additions and removals', async () => {
            const before = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'flask', version: '3.0.0' } as Package,
            ];
            getPackagesStub.resolves(before);
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'django', version: '5.0.0' } as Package,
            ];

            const changes = await getPackageChanges(packageManager, environment, after);

            assert.strictEqual(changes.length, 2);
            const add = changes.find((c) => c.kind === PackageChangeKind.add);
            const remove = changes.find((c) => c.kind === PackageChangeKind.remove);
            assert.ok(add);
            assert.ok(remove);
            assert.strictEqual(add.pkg.name, 'django');
            assert.strictEqual(remove.pkg.name, 'flask');
        });

        test('treats undefined getPackages result as empty', async () => {
            getPackagesStub.resolves(undefined);
            const after = [{ name: 'requests', version: '2.31.0' } as Package];

            const changes = await getPackageChanges(packageManager, environment, after);

            assert.strictEqual(changes.length, 1);
            assert.strictEqual(changes[0].kind, PackageChangeKind.add);
        });
    });

    suite('updatePackagesAndNotify', () => {
        test('calls setPackages when there are changes', async () => {
            getPackagesStub.resolves([]);
            const fetched = [{ name: 'requests', version: '2.31.0' } as Package];
            fetchPackagesStub.resolves(fetched);

            await updatePackagesAndNotify(packageManager, environment);

            assert.strictEqual(setPackagesSpy.callCount, 2);
            // First call seeds the cache
            assert.deepStrictEqual(setPackagesSpy.firstCall.args, [environment, [], []]);
            // Second call sets the actual packages
            const [env, pkgs, changes] = setPackagesSpy.secondCall.args;
            assert.strictEqual(env, environment);
            assert.deepStrictEqual(pkgs, fetched);
            assert.strictEqual(changes.length, 1);
            assert.strictEqual(changes[0].kind, PackageChangeKind.add);
        });

        test('does not call setPackages with changes when there are no changes', async () => {
            const pkgs = [{ name: 'requests', version: '2.31.0' } as Package];
            getPackagesStub.resolves(pkgs);
            fetchPackagesStub.resolves(pkgs);

            await updatePackagesAndNotify(packageManager, environment);

            // Only the seeding call, no second call with changes
            assert.strictEqual(setPackagesSpy.callCount, 1);
            assert.deepStrictEqual(setPackagesSpy.firstCall.args, [environment, [], []]);
        });

        test('passes all changes to setPackages', async () => {
            const before = [{ name: 'flask', version: '3.0.0' } as Package];
            getPackagesStub.resolves(before);
            const after = [{ name: 'django', version: '5.0.0' } as Package];
            fetchPackagesStub.resolves(after);

            await updatePackagesAndNotify(packageManager, environment);

            assert.strictEqual(setPackagesSpy.callCount, 2);
            const [, , changes] = setPackagesSpy.secondCall.args;
            assert.strictEqual(changes.length, 2);
            assert.ok(changes.some((c: { kind: PackageChangeKind }) => c.kind === PackageChangeKind.add));
            assert.ok(changes.some((c: { kind: PackageChangeKind }) => c.kind === PackageChangeKind.remove));
        });
    });
});
