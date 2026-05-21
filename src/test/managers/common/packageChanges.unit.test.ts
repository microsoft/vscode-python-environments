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
        let getPackagesStub: sinon.SinonStub;
        let packageManager: PackageManager;

        setup(() => {
            environment = {} as PythonEnvironment;
            getPackagesStub = sinon.stub();
            packageManager = {
                name: 'test',
                manage: sinon.stub(),
                refresh: sinon.stub(),
                getPackages: getPackagesStub,
            } as unknown as PackageManager;
        });

        test('reports adds on first load', async () => {
            const fetched = [{ name: 'requests', version: '2.31.0' } as Package];
            getPackagesStub.resolves(fetched);
            const onChanges = sinon.stub();

            await updatePackagesAndNotify(packageManager, environment, undefined, onChanges);

            assert.ok(getPackagesStub.calledOnceWithExactly(environment, sinon.match({ skipCache: true })));
            assert.ok(onChanges.calledOnce);
            const [changes] = onChanges.firstCall.args;
            assert.strictEqual(changes.length, 1);
            assert.strictEqual(changes[0].kind, PackageChangeKind.add);
            assert.deepStrictEqual(cache, fetched);
        });

        test('does not fire callback when nothing changed', async () => {
            const pkgs = [{ name: 'requests', version: '2.31.0' } as Package];
            getPackagesStub.resolves(pkgs);
            const onChanges = sinon.stub();

            await updatePackagesAndNotify(packageManager, environment, pkgs, onChanges);

            assert.ok(onChanges.notCalled);
        });

        test('detects removals correctly', async () => {
            const before = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'flask', version: '3.0.0' } as Package,
            ];
            const after = [{ name: 'requests', version: '2.31.0' } as Package];
            getPackagesStub.resolves(after);
            const onChanges = sinon.stub();

            await updatePackagesAndNotify(packageManager, environment, before, onChanges);

            assert.ok(onChanges.calledOnce);
            const [changes] = onChanges.firstCall.args;
            assert.strictEqual(changes.length, 1);
            assert.strictEqual(changes[0].kind, PackageChangeKind.remove);
            assert.strictEqual(changes[0].pkg.name, 'flask');
        });

        test('detects mixed adds and removals', async () => {
            const before = [{ name: 'flask', version: '3.0.0' } as Package];
            const after = [{ name: 'django', version: '5.0.0' } as Package];
            getPackagesStub.resolves(after);
            const onChanges = sinon.stub();

            await updatePackagesAndNotify(packageManager, environment, before, onChanges);

            assert.ok(onChanges.calledOnce);
            const [changes] = onChanges.firstCall.args;
            assert.strictEqual(changes.length, 2);
            assert.ok(changes.some((c: { kind: PackageChangeKind }) => c.kind === PackageChangeKind.add));
            assert.ok(changes.some((c: { kind: PackageChangeKind }) => c.kind === PackageChangeKind.remove));
        });

        test('marks transitive packages when getDirectPackageNames is provided', async () => {
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'urllib3', version: '2.0.0' } as Package,
                { name: 'charset-normalizer', version: '3.0.0' } as Package,
            ];
            getPackagesStub.resolves(after);
            const getDirectPackageNamesStub = sinon.stub().resolves(new Set(['requests']));
            (packageManager as unknown as Record<string, unknown>).getDirectPackageNames = getDirectPackageNamesStub;
            const onChanges = sinon.stub();

            const result = await updatePackagesAndNotify(packageManager, environment, undefined, onChanges);

            assert.ok(result);
            assert.strictEqual(result![0].isTransitive, false, 'requests should be direct');
            assert.strictEqual(result![1].isTransitive, true, 'urllib3 should be transitive');
            assert.strictEqual(result![2].isTransitive, true, 'charset-normalizer should be transitive');
            // Original objects should not be mutated
            assert.strictEqual(after[0].isTransitive, undefined, 'original should not be mutated');
        });

        test('does not mark packages transitive when getDirectPackageNames is not implemented', async () => {
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'urllib3', version: '2.0.0' } as Package,
            ];
            getPackagesStub.resolves(after);
            const onChanges = sinon.stub();

            const result = await updatePackagesAndNotify(packageManager, environment, undefined, onChanges);

            assert.ok(result);
            assert.strictEqual(result![0].isTransitive, undefined, 'should not be set');
            assert.strictEqual(result![1].isTransitive, undefined, 'should not be set');
        });

        test('does not mark packages transitive when getDirectPackageNames returns undefined', async () => {
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'urllib3', version: '2.0.0' } as Package,
            ];
            getPackagesStub.resolves(after);
            const getDirectPackageNamesStub = sinon.stub().resolves(undefined);
            (packageManager as unknown as Record<string, unknown>).getDirectPackageNames = getDirectPackageNamesStub;
            const onChanges = sinon.stub();

            const result = await updatePackagesAndNotify(packageManager, environment, undefined, onChanges);

            assert.ok(result);
            assert.strictEqual(result![0].isTransitive, undefined, 'should not be set');
            assert.strictEqual(result![1].isTransitive, undefined, 'should not be set');
        });

        test('does not mark packages transitive when getDirectPackageNames returns empty set', async () => {
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'urllib3', version: '2.0.0' } as Package,
            ];
            getPackagesStub.resolves(after);
            const getDirectPackageNamesStub = sinon.stub().resolves(new Set<string>());
            (packageManager as unknown as Record<string, unknown>).getDirectPackageNames = getDirectPackageNamesStub;
            const onChanges = sinon.stub();

            const result = await updatePackagesAndNotify(packageManager, environment, undefined, onChanges);

            assert.ok(result);
            assert.strictEqual(result![0].isTransitive, undefined, 'should not be set');
            assert.strictEqual(result![1].isTransitive, undefined, 'should not be set');
        });

        test('all packages marked direct when all are in direct set', async () => {
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'flask', version: '3.0.0' } as Package,
            ];
            getPackagesStub.resolves(after);
            const getDirectPackageNamesStub = sinon.stub().resolves(new Set(['requests', 'flask']));
            (packageManager as unknown as Record<string, unknown>).getDirectPackageNames = getDirectPackageNamesStub;
            const onChanges = sinon.stub();

            const result = await updatePackagesAndNotify(packageManager, environment, undefined, onChanges);

            assert.ok(result);
            assert.strictEqual(result![0].isTransitive, false, 'requests should be direct');
            assert.strictEqual(result![1].isTransitive, false, 'flask should be direct');
        });

        test('all packages marked transitive when none are in direct set', async () => {
            const after = [
                { name: 'urllib3', version: '2.0.0' } as Package,
                { name: 'charset-normalizer', version: '3.0.0' } as Package,
            ];
            getPackagesStub.resolves(after);
            const getDirectPackageNamesStub = sinon.stub().resolves(new Set(['requests']));
            (packageManager as unknown as Record<string, unknown>).getDirectPackageNames = getDirectPackageNamesStub;
            const onChanges = sinon.stub();

            const result = await updatePackagesAndNotify(packageManager, environment, undefined, onChanges);

            assert.ok(result);
            assert.strictEqual(result![0].isTransitive, true, 'urllib3 should be transitive');
            assert.strictEqual(result![1].isTransitive, true, 'charset-normalizer should be transitive');
        });

        test('leaves isTransitive undefined when getDirectPackageNames throws', async () => {
            const after = [
                { name: 'requests', version: '2.31.0' } as Package,
                { name: 'urllib3', version: '2.0.0' } as Package,
            ];
            getPackagesStub.resolves(after);
            const getDirectPackageNamesStub = sinon.stub().rejects(new Error('command failed'));
            (packageManager as unknown as Record<string, unknown>).getDirectPackageNames = getDirectPackageNamesStub;
            const onChanges = sinon.stub();

            const result = await updatePackagesAndNotify(packageManager, environment, undefined, onChanges);

            assert.ok(result);
            assert.strictEqual(result![0].isTransitive, undefined, 'should not be set on error');
            assert.strictEqual(result![1].isTransitive, undefined, 'should not be set on error');
            assert.ok(onChanges.calledOnce, 'should still fire change event');
        });
    });
});
